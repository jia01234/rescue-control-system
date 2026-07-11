// =============================================================
// 搜救人員工作管制系統 - 核心邏輯 (app.js)
// =============================================================

// --- 預設人員名冊資料 ---
const DEFAULT_ROSTER = {
  A: [
    "施瑋強", "吳濟學", "顏忠雄", "楊沂錄", "陳子向", 
    "蘇峰立", "田秉正", "彭睿清", "潘俊儒", "林良耕", 
    "蔡廷鴻", "林佳翰", "李東昇", "潘信州", "林銘信", 
    "張欽勇(犬)", "傅仁輝", "鄭宏熙", "張雋景"
  ],
  B: [
    "王啟銘", "林威任", "李宗隆", "陳鎮源", "陳旻頡", 
    "胡俊雄", "賴佑宗", "張升耀", "林長緯", "林義濠", 
    "張智鈞", "蘇昱嘉", "吳冠緯", "李泊陞", "楊富聖", 
    "何國睿", "巫怡穎", "黃文賢", "陳柏劭", "黃心怡(犬)"
  ],
  standby: [
    "呂玟麗", "吳佩容", "蔣振瑋", "蘇稚茜", "曾瑜", 
    "張立芯", "林宇璇"
  ]
};

// --- 全局狀態變數 ---
let roster = [];
let logs = [];
let activeTeam = 'A'; // 當前在管制看板顯示的小隊 A 或 B
let selectedMemberForSheet = null; // 當前在 Bottom Sheet 操作的人員 ID
let missionStartTime = null;
let evacZones = ["前進指揮站", "車輛停放區", "Boo"];
let activeTimers = {}; // 記錄各熱區人員的計時器
let loopEvacAlertInterval = null; // 全面撤離的音效循環定時器
let isMultiSelectMode = false;     // 是否為批次複選模式
let selectedMemberIds = new Set(); // 記錄複選中人員的 ID 集合

// Web Audio API 上下文 (延遲載入)
let audioCtx = null;

// --- 初始化程序 ---
document.addEventListener('DOMContentLoaded', () => {
  initData();
  setupEventListeners();
  renderAll();
});

// --- 資料儲存與載入 ---
function initData() {
  const localRoster = localStorage.getItem('rescue_roster');
  const localLogs = localStorage.getItem('rescue_logs');

  // 初始化人員
  if (localRoster) {
    roster = JSON.parse(localRoster);
    // 修正名冊快取歷史資料中的錯字
    roster.forEach(m => {
      if (m.name === '顏志雄') m.name = '顏忠雄';
      if (m.name === '田東正') m.name = '田秉正';
    });
    saveRoster();
  } else {
    // 建立預設名冊
    let idCounter = 1;
    DEFAULT_ROSTER.A.forEach(name => {
      roster.push({ id: `m_${idCounter++}`, name, team: 'A', status: 'standby', entryTime: null, lastDuration: 0 });
    });
    DEFAULT_ROSTER.B.forEach(name => {
      roster.push({ id: `m_${idCounter++}`, name, team: 'B', status: 'standby', entryTime: null, lastDuration: 0 });
    });
    DEFAULT_ROSTER.standby.forEach(name => {
      roster.push({ id: `m_${idCounter++}`, name, team: 'standby', status: 'standby', entryTime: null, lastDuration: 0 });
    });
    saveRoster();
  }

  // 初始化日誌
  if (localLogs) {
    logs = JSON.parse(localLogs);
  } else {
    logs = [{
      time: new Date().toISOString(),
      type: 'auto',
      text: '人員工作管制系統啟動，指揮站已建立。'
    }];
    saveLogs();
  }

  // 初始化任務時間
  initMissionTimer();

  // 初始化撤離區
  const localZones = localStorage.getItem('rescue_evac_zones');
  if (localZones) {
    evacZones = JSON.parse(localZones);
  }
  document.getElementById('evac-zone-1').value = evacZones[0];
  document.getElementById('evac-zone-2').value = evacZones[1];
  document.getElementById('evac-zone-3').value = evacZones[2];
  updateOverlayZones();
}

function updateOverlayZones() {
  const z1 = document.getElementById('overlay-zone-1');
  const z2 = document.getElementById('overlay-zone-2');
  const z3 = document.getElementById('overlay-zone-3');
  if (z1) z1.textContent = evacZones[0];
  if (z2) z2.textContent = evacZones[1];
  if (z3) z3.textContent = evacZones[2];
}

function saveRoster() {
  localStorage.setItem('rescue_roster', JSON.stringify(roster));
}

function saveLogs() {
  localStorage.setItem('rescue_logs', JSON.stringify(logs));
}

// --- Web Audio 嗶聲合成器 ---
function playBeep(startTime, durationMs, frequency = 950) {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, startTime);

    // 漸入與漸出，避免爆音
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(0.3, startTime + 0.05);
    gainNode.gain.setValueAtTime(0.3, startTime + (durationMs / 1000) - 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + (durationMs / 1000));

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc.start(startTime);
    osc.stop(startTime + (durationMs / 1000));
  } catch (e) {
    console.error("無法播放音效", e);
  }
}

// 播放訊號模式
function triggerAudioSignal(pattern) {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const now = audioCtx.currentTime;

  if (pattern === 'evacuate') {
    // 全面撤離：三短音（每聲 1 秒，間隔 0.2 秒）
    playBeep(now, 1000);
    playBeep(now + 1.2, 1000);
    playBeep(now + 2.4, 1000);
  } else if (pattern === 'quiet') {
    // 停止作業/安靜：一長音（持續 3 秒）
    playBeep(now, 3000);
  } else if (pattern === 'resume') {
    // 恢復作業：一長一短（長3秒，隔0.5秒，短1秒）
    playBeep(now, 3000);
    playBeep(now + 3.5, 1000);
  } else if (pattern === 'warning') {
    // 一般提示短音
    playBeep(now, 200);
  }
}

// --- 定時器邏輯 ---

// 1. 任務持續總時間 (手動控制)
let isMissionRunning = false;
let missionElapsedSeconds = 0; // 暫停時已走秒數
let missionTimerInterval = null;
let missionStartTimestamp = null; // 啟動時起始時間戳

function initMissionTimer() {
  const localIsRunning = localStorage.getItem('mission_is_running');
  const localElapsed = localStorage.getItem('mission_elapsed_seconds');
  const localStartTimestamp = localStorage.getItem('mission_start_timestamp');

  if (localIsRunning === 'true') {
    isMissionRunning = true;
    missionStartTimestamp = new Date(localStartTimestamp);
    startMissionTimerInterval();
    updateStartBtnUI(true);
  } else {
    isMissionRunning = false;
    missionElapsedSeconds = parseInt(localElapsed || '0', 10);
    displayMissionTime(missionElapsedSeconds);
    updateStartBtnUI(false);
  }
}

function startMissionTimerInterval() {
  if (missionTimerInterval) clearInterval(missionTimerInterval);
  missionTimerInterval = setInterval(() => {
    const elapsed = Math.floor((new Date() - missionStartTimestamp) / 1000);
    displayMissionTime(elapsed);
  }, 1000);
}

function displayMissionTime(totalSeconds) {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(Math.floor(totalSeconds % 60)).padStart(2, '0');
  document.getElementById('mission-timer').textContent = `${hours}:${minutes}:${seconds}`;
}

function updateStartBtnUI(running) {
  const btn = document.getElementById('mission-start-btn');
  if (btn) {
    btn.innerHTML = running ? '⏸️' : '▶️';
  }
}

function toggleMissionTimer() {
  if (!isMissionRunning) {
    // 啟動
    isMissionRunning = true;
    missionStartTimestamp = new Date(new Date().getTime() - missionElapsedSeconds * 1000);
    localStorage.setItem('mission_start_timestamp', missionStartTimestamp.toISOString());
    localStorage.setItem('mission_is_running', 'true');
    startMissionTimerInterval();
    updateStartBtnUI(true);
    addLog('auto', '【任務計時】安全官啟動了任務時間計時。');
  } else {
    // 暫停
    isMissionRunning = false;
    if (missionTimerInterval) clearInterval(missionTimerInterval);
    missionElapsedSeconds = Math.floor((new Date() - missionStartTimestamp) / 1000);
    localStorage.setItem('mission_elapsed_seconds', missionElapsedSeconds.toString());
    localStorage.setItem('mission_is_running', 'false');
    updateStartBtnUI(false);
    addLog('auto', '【任務計時】安全官暫停了任務時間計時。');
  }
  renderLogs();
}

function resetMissionTimer() {
  if (confirm('確定要將任務時間重設為 00:00:00 嗎？')) {
    isMissionRunning = false;
    if (missionTimerInterval) clearInterval(missionTimerInterval);
    missionElapsedSeconds = 0;
    missionStartTimestamp = null;
    localStorage.setItem('mission_elapsed_seconds', '0');
    localStorage.setItem('mission_is_running', 'false');
    localStorage.removeItem('mission_start_timestamp');
    displayMissionTime(0);
    updateStartBtnUI(false);
    addLog('auto', '【任務計時】安全官將任務時間重設為零。');
    renderLogs();
  }
}

// 2. 安全官無線電回報定時提醒
function startRadioTimer() {
  if (radioTimerInterval) clearInterval(radioTimerInterval);
  
  const timerEl = document.getElementById('radio-timer');
  const reminderBox = document.querySelector('.timer-reminder');

  radioTimerInterval = setInterval(() => {
    if (radioTimerSeconds > 0) {
      radioTimerSeconds--;
      const min = String(Math.floor(radioTimerSeconds / 60)).padStart(2, '0');
      const sec = String(radioTimerSeconds % 60).padStart(2, '0');
      timerEl.textContent = `${min}:${sec}`;
      
      // 倒數到最後 10 秒閃爍警示
      if (radioTimerSeconds <= 10) {
        reminderBox.classList.add('alerting');
      } else {
        reminderBox.classList.remove('alerting');
      }
    } else {
      // 時間到，警報嗶聲，發出日誌
      reminderBox.classList.add('alerting');
      triggerAudioSignal('warning');
      addLog('auto', '【安全提醒】無線電回報時間截止！請立即確認熱區小隊安全。', 'danger');
      radioTimerSeconds = 1200; // 自動重設
      renderLogs();
    }
  }, 1000);
}

// --- 事件綁定 ---
function setupEventListeners() {
  // 底部導覽頁籤切換
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tabId = btn.getAttribute('data-tab');
      
      // 切換按鈕狀態
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // 切換面板顯示
      document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
      document.getElementById(tabId).classList.add('active');
    });
  });

  // 看板：A/B 組切換
  document.querySelectorAll('.team-sidebar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.team-sidebar-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTeam = btn.getAttribute('data-team');
      renderBoard();
    });
  });

  // 關閉 Bottom Sheet
  document.getElementById('close-sheet-btn').addEventListener('click', closeStatusSheet);
  document.querySelector('.sheet-overlay').addEventListener('click', closeStatusSheet);

  // Bottom Sheet 內狀態按鈕點擊
  document.querySelectorAll('.sheet-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const newStatus = btn.getAttribute('data-status');
      if (selectedMemberForSheet) {
        changeMemberStatus(selectedMemberForSheet, newStatus);
        closeStatusSheet();
      }
    });
  });

  // 一鍵查詢懸浮按鈕
  document.getElementById('floating-query-btn').addEventListener('click', openHotzoneModal);
  document.getElementById('close-modal-btn').addEventListener('click', closeHotzoneModal);
  document.getElementById('modal-close-footer').addEventListener('click', closeHotzoneModal);

  // 一鍵查詢彈窗內的「全員撤離」
  document.getElementById('modal-evac-btn').addEventListener('click', () => {
    evacAllHotZoneMembers();
    closeHotzoneModal();
  });

  // 工作開始按鈕事件 (▶️ 工作開始)
  const opStartModal = document.getElementById('op-start-modal');
  document.getElementById('op-start-btn').addEventListener('click', () => {
    // 寫入當前預設撤離區至 modal 中對應的 span/strong
    document.getElementById('start-modal-zone-1').textContent = evacZones[0];
    document.getElementById('start-modal-zone-2').textContent = evacZones[1];
    document.getElementById('start-modal-zone-3').textContent = evacZones[2];
    opStartModal.classList.remove('hidden');
  });
  document.getElementById('close-op-start-modal').addEventListener('click', () => {
    opStartModal.classList.add('hidden');
  });
  document.getElementById('confirm-op-start').addEventListener('click', () => {
    opStartModal.classList.add('hidden');
    // 如果計時未啟動，則自動啟動任務時間
    if (!isMissionRunning) {
      toggleMissionTimer();
    }
    addLog('auto', '【任務狀態】工作開始。安全官已確認任務簡報、撤離訊號宣讀、撤離區位置及危險評估物品。');
    renderLogs();
  });

  // 工作結束按鈕事件 (⏹️ 工作結束)
  const opEndModal = document.getElementById('op-end-modal');
  document.getElementById('op-end-btn').addEventListener('click', () => {
    opEndModal.classList.remove('hidden');
  });
  document.getElementById('close-op-end-modal').addEventListener('click', () => {
    opEndModal.classList.add('hidden');
  });
  document.getElementById('confirm-op-end').addEventListener('click', () => {
    opEndModal.classList.add('hidden');
    // 如果計時正在跑，則暫停任務時間
    if (isMissionRunning) {
      toggleMissionTimer();
    }
    addLog('danger', '【任務狀態】工作結束！搜救隊已撤離。請搜救犬進行最後搜偵確認，並完成 INSARAG 標記！');
    renderLogs();
  });

  // 音效播放按鈕
  document.getElementById('play-evac-audio').addEventListener('click', () => triggerAudioSignal('evacuate'));
  document.getElementById('play-quiet-audio').addEventListener('click', () => triggerAudioSignal('quiet'));
  document.getElementById('play-resume-audio').addEventListener('click', () => triggerAudioSignal('resume'));

  // 任務時間控制按鈕
  document.getElementById('mission-start-btn').addEventListener('click', toggleMissionTimer);
  document.getElementById('mission-reset-btn').addEventListener('click', resetMissionTimer);

  // 監聽並儲存自訂撤離區
  ['evac-zone-1', 'evac-zone-2', 'evac-zone-3'].forEach((id, index) => {
    document.getElementById(id).addEventListener('input', (e) => {
      evacZones[index] = e.target.value.trim() || `撤離區 ${index + 1}`;
      localStorage.setItem('rescue_evac_zones', JSON.stringify(evacZones));
      updateOverlayZones();
    });
  });

  // 手動新增日誌
  document.getElementById('add-manual-log-btn').addEventListener('click', addManualLog);
  document.getElementById('manual-log-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addManualLog();
  });

  // 看板第一頁快速日誌與預設字
  const boardLogInput = document.getElementById('board-manual-log-input');
  document.getElementById('board-add-manual-log-btn').addEventListener('click', () => {
    const text = boardLogInput.value.trim();
    if (text) {
      addLog('manual', text);
      boardLogInput.value = '';
      renderLogs();
      triggerAudioSignal('warning');
    }
  });
  boardLogInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      const text = boardLogInput.value.trim();
      if (text) {
        addLog('manual', text);
        boardLogInput.value = '';
        renderLogs();
        triggerAudioSignal('warning');
      }
    }
  });
  // 看板第一頁的預設字點擊 (累加文字，不覆蓋)
  document.querySelectorAll('.board-quick-log-panel .tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      let text = chip.getAttribute('data-text');
      if (text === 'current_time') {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('zh-TW', {
          timeZone: 'Asia/Taipei',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        });
        const parts = formatter.formatToParts(now);
        let hour = '00', minute = '00', second = '00';
        parts.forEach(p => {
          if (p.type === 'hour') hour = p.value;
          if (p.type === 'minute') minute = p.value;
          if (p.type === 'second') second = p.value;
        });
        text = `${hour}:${minute}:${second}`; // 24小時制，顯示 時:分:秒
      }
      const currentVal = boardLogInput.value.trim();
      boardLogInput.value = currentVal ? `${currentVal} ${text}` : text;
      boardLogInput.focus();
    });
  });

  // 安全日誌頁面中的預設字點擊 (累加文字，不覆蓋)
  const mainLogInput = document.getElementById('manual-log-input');
  document.querySelectorAll('#tab-logs .tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      let text = chip.getAttribute('data-text');
      if (text === 'current_time') {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('zh-TW', {
          timeZone: 'Asia/Taipei',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        });
        const parts = formatter.formatToParts(now);
        let hour = '00', minute = '00', second = '00';
        parts.forEach(p => {
          if (p.type === 'hour') hour = p.value;
          if (p.type === 'minute') minute = p.value;
          if (p.type === 'second') second = p.value;
        });
        text = `${hour}:${minute}:${second}`; // 24小時制，顯示 時:分:秒
      }
      const currentVal = mainLogInput.value.trim();
      mainLogInput.value = currentVal ? `${currentVal} ${text}` : text;
      mainLogInput.focus();
    });
  });

  // 匯出 CSV 日誌
  document.getElementById('export-log-btn').addEventListener('click', exportLogsToCSV);

  // 清除日誌
  document.getElementById('clear-log-btn').addEventListener('click', () => {
    if (confirm('確定要清除所有安全日誌嗎？此動作無法復原。')) {
      logs = [{
        time: new Date().toISOString(),
        type: 'auto',
        text: '安全日誌已由安全官清空。'
      }];
      saveLogs();
      renderLogs();
    }
  });

  // 新增人員彈窗控制
  const addModal = document.getElementById('add-member-modal');
  document.getElementById('open-add-member-btn').addEventListener('click', () => addModal.classList.remove('hidden'));
  document.getElementById('close-add-modal').addEventListener('click', () => addModal.classList.add('hidden'));
  document.getElementById('cancel-add-modal').addEventListener('click', () => addModal.classList.add('hidden'));
  
  // 新增人員表單提交
  document.getElementById('add-member-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('new-member-name');
    const groupSelect = document.getElementById('new-member-group');
    
    const name = nameInput.value.trim();
    const team = groupSelect.value;
    
    if (name) {
      const newId = `m_${Date.now()}`;
      roster.push({
        id: newId,
        name,
        team,
        status: 'standby',
        entryTime: null,
        lastDuration: 0
      });
      saveRoster();
      
      addLog('auto', `新增隊員【${name}】至 ${team === 'standby' ? '預備名單' : '搜救 ' + team + ' 組'}`);
      
      nameInput.value = '';
      addModal.classList.add('hidden');
      renderAll();
    }
  });

  // 批次複選模式控制監聽
  const toggleBtn = document.getElementById('multi-select-toggle-btn');
  const btnText = document.getElementById('multi-select-btn-text');
  const btnIcon = document.getElementById('multi-select-icon');
  const actionsEl = document.getElementById('multi-select-actions');

  toggleBtn.addEventListener('click', () => {
    isMultiSelectMode = !isMultiSelectMode;
    if (isMultiSelectMode) {
      toggleBtn.classList.remove('btn-secondary');
      toggleBtn.classList.add('btn-primary');
      toggleBtn.style.background = 'var(--color-primary)';
      btnText.textContent = '關閉複選模式';
      btnIcon.textContent = '☑️';
      actionsEl.classList.remove('hidden');
      selectedMemberIds.clear();
      document.getElementById('batch-selected-count').textContent = '已選 0 人';
    } else {
      toggleBtn.classList.add('btn-secondary');
      toggleBtn.classList.remove('btn-primary');
      toggleBtn.style.background = '';
      btnText.textContent = '開啟複選移動';
      btnIcon.textContent = '🔳';
      actionsEl.classList.add('hidden');
      selectedMemberIds.clear();
    }
    renderBoard();
  });

  document.getElementById('batch-move-standby').addEventListener('click', () => {
    if (selectedMemberIds.size === 0) {
      alert('請先選取要移動的人員！');
      return;
    }
    const names = [];
    selectedMemberIds.forEach(id => {
      const member = roster.find(m => m.id === id);
      if (member) {
        member.status = 'standby';
        member.entryTime = null;
        member.timerStarted = false;
        names.push(member.name);
      }
    });
    saveRoster();
    addLog('auto', `【批次移回】安全官批次將 ${activeTeam}組 隊員 [${names.join(', ')}] 移回待命。`);
    
    // 退出複選模式
    isMultiSelectMode = false;
    toggleBtn.classList.add('btn-secondary');
    toggleBtn.classList.remove('btn-primary');
    toggleBtn.style.background = '';
    btnText.textContent = '開啟複選移動';
    btnIcon.textContent = '🔳';
    actionsEl.classList.add('hidden');
    selectedMemberIds.clear();
    
    renderAll();
    triggerAudioSignal('warning');
  });

  document.getElementById('batch-move-hotzone').addEventListener('click', () => {
    if (selectedMemberIds.size === 0) {
      alert('請先選取要移動的人員！');
      return;
    }
    
    // 檢查出勤安全鎖：如果另一隊有人在熱區，禁止此隊移入熱區
    const otherTeam = activeTeam === 'A' ? 'B' : 'A';
    const isOtherTeamActive = roster.some(m => m.team === otherTeam && m.status === 'hotzone');
    if (isOtherTeamActive) {
      alert(`⚠️ 管制警告！目前【搜救 ${otherTeam} 組】正在熱區作業，兩組不可同時在熱區出勤！`);
      return;
    }
    
    const names = [];
    selectedMemberIds.forEach(id => {
      const member = roster.find(m => m.id === id);
      if (member) {
        member.status = 'hotzone';
        member.entryTime = new Date().toISOString();
        member.timerStarted = true;
        names.push(member.name);
      }
    });
    saveRoster();
    addLog('danger', `🚨【批次出勤】安全官批次將 ${activeTeam}組 隊員 [${names.join(', ')}] 送入熱區作業並開始計時。`);
    
    // 退出複選模式
    isMultiSelectMode = false;
    toggleBtn.classList.add('btn-secondary');
    toggleBtn.classList.remove('btn-primary');
    toggleBtn.style.background = '';
    btnText.textContent = '開啟複選移動';
    btnIcon.textContent = '🔳';
    actionsEl.classList.add('hidden');
    selectedMemberIds.clear();
    
    renderAll();
    triggerAudioSignal('warning');
  });
}

// --- 渲染畫面核心函式 ---
function renderAll() {
  renderBoard();
  renderLogs();
  renderRosterEditor();
  updateHeaderStats();
}

// 1. 管制看板渲染
function renderBoard() {
  const listStandby = document.getElementById('list-standby');
  const listHotzone = document.getElementById('list-hotzone');
  const bannerEl = document.getElementById('team-exclusion-banner');
  const bannerTextEl = document.getElementById('banner-text');

  // 清空看板
  listStandby.innerHTML = '';
  listHotzone.innerHTML = '';

  let countS = 0;
  let countH = 0;

  // 檢查另一組是否有成員在熱區中，進行互斥警示
  const otherTeam = activeTeam === 'A' ? 'B' : 'A';
  const isOtherTeamActive = roster.some(m => m.team === otherTeam && m.status === 'hotzone');
  
  if (isOtherTeamActive) {
    bannerEl.className = 'exclusion-banner danger';
    bannerTextEl.textContent = `管制警告：【搜救 ${otherTeam} 組】目前正在熱區出勤中！本隊（${activeTeam}組）已鎖定為待命備援，禁止移入熱區。`;
    bannerEl.classList.remove('hidden');
  } else {
    // 自己這隊在熱區中，不顯示提示，隱藏橫幅以省空間
    bannerEl.classList.add('hidden');
  }

  // 更新複選模式下的欄位容器樣式
  const columnsEl = document.querySelector('.board-columns');
  if (columnsEl) {
    if (isMultiSelectMode) {
      columnsEl.classList.add('multi-select-active');
    } else {
      columnsEl.classList.remove('multi-select-active');
    }
  }

  // 篩選當前選擇小隊且不在預備名單的人員
  const activeMembers = roster.filter(m => m.team === activeTeam);

  activeMembers.forEach(member => {
    // 防呆相容舊資料：若狀態是 returned 則自動導回 standby
    if (member.status === 'returned') {
      member.status = 'standby';
      member.entryTime = null;
      member.timerStarted = false;
    }

    const isSelected = selectedMemberIds.has(member.id);
    const card = document.createElement('div');
    card.className = `member-card ${member.status === 'hotzone' ? 'in-hotzone' : ''} ${isSelected ? 'selected-for-batch' : ''}`;
    card.setAttribute('data-id', member.id);
    
    // 綁定拖曳與點擊二合一觸控事件
    setupDragAndDrop(card, member);

    card.innerHTML = `
      <div class="member-info">
        <span class="member-name">${member.name}</span>
        <span class="member-team-label">搜救 ${member.team} 組</span>
      </div>
    `;

    // 派發到對應的二欄位
    if (member.status === 'hotzone') {
      listHotzone.appendChild(card);
      countH++;
    } else {
      listStandby.appendChild(card);
      countS++;
    }
  });

  // 更新小隊看板的欄位人數計數器
  document.getElementById('count-standby').textContent = countS;
  document.getElementById('count-hotzone').textContent = countH;
}

// 2. 日誌渲染
function renderLogs() {
  const logList = document.getElementById('log-list');
  logList.innerHTML = '';

  // 從新到舊排序顯示（底端為最新）
  logs.forEach(log => {
    const entry = document.createElement('div');
    let logClass = 'log-auto';
    if (log.type === 'manual') logClass = 'log-manual';
    if (log.type === 'danger') logClass = 'log-danger';

    entry.className = `log-entry ${logClass}`;
    
    const timeStr = new Date(log.time).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    entry.innerHTML = `<span class="time">[${timeStr}]</span>${log.text}`;
    logList.appendChild(entry);
  });

  // 自動捲動到日誌底部
  logList.scrollTop = logList.scrollHeight;
}

// 3. 人員管理名冊渲染 (編輯分組功能)
function renderRosterEditor() {
  const listA = document.getElementById('roster-list-a');
  const listB = document.getElementById('roster-list-b');
  const listStandby = document.getElementById('roster-list-standby');

  listA.innerHTML = '';
  listB.innerHTML = '';
  listStandby.innerHTML = '';

  roster.forEach(member => {
    const item = document.createElement('div');
    item.className = 'roster-item';
    
    // 生成調動按鈕
    let actionButtons = '';
    if (member.team === 'A') {
      actionButtons = `
        <button class="btn btn-sm" onclick="moveMemberTeam('${member.id}', 'B')">移至 B 組</button>
        <button class="btn btn-sm btn-secondary" onclick="moveMemberTeam('${member.id}', 'standby')">移至預備</button>
      `;
    } else if (member.team === 'B') {
      actionButtons = `
        <button class="btn btn-sm" onclick="moveMemberTeam('${member.id}', 'A')">移至 A 組</button>
        <button class="btn btn-sm btn-secondary" onclick="moveMemberTeam('${member.id}', 'standby')">移至預備</button>
      `;
    } else {
      actionButtons = `
        <button class="btn btn-sm" onclick="moveMemberTeam('${member.id}', 'A')">移至 A 組</button>
        <button class="btn btn-sm" onclick="moveMemberTeam('${member.id}', 'B')">移至 B 組</button>
      `;
    }

    item.innerHTML = `
      <span class="roster-item-name">${member.name}</span>
      <div class="roster-actions">
        ${actionButtons}
        <button class="btn btn-sm btn-danger" onclick="deleteMember('${member.id}')">刪除</button>
      </div>
    `;

    if (member.team === 'A') {
      listA.appendChild(item);
    } else if (member.team === 'B') {
      listB.appendChild(item);
    } else {
      listStandby.appendChild(item);
    }
  });
}

// 4. 更新頂部與全螢幕狀態指標
function updateHeaderStats() {
  const hotzoneCount = roster.filter(m => m.status === 'hotzone').length;
  document.getElementById('hotzone-count').textContent = hotzoneCount;
}

// --- 業務邏輯控制 ---

// 變更成員狀態 (待命/熱區/返回)
function changeMemberStatus(id, newStatus) {
  const member = roster.find(m => m.id === id);
  if (!member) return;

  const oldStatus = member.status;
  if (oldStatus === newStatus) return;

  // 1. 小隊出勤互斥檢查
  if (newStatus === 'hotzone') {
    const otherTeam = member.team === 'A' ? 'B' : 'A';
    const isOtherTeamActive = roster.some(m => m.team === otherTeam && m.status === 'hotzone');
    if (isOtherTeamActive) {
      alert(`⚠️ 出勤管制警告！\n\n目前【搜救 ${otherTeam} 組】正在熱區作業中。\n依安全管制規定，A、B 兩小隊不可同時進入熱區，另一小隊必須在站外待命備援，以利緊急救援 (RIT)！`);
      return;
    }
  }

  member.status = newStatus;

  if (newStatus === 'hotzone') {
    // 進入熱區
    member.timerStarted = false;
    member.entryTime = new Date().toISOString();
    member.lastDuration = 0;
    addLog('auto', `【人員部署】${member.team}組 隊員【${member.name}】部署至危險工作區。`);
  } 
  else if (newStatus === 'standby') {
    // 從熱區返回待命
    if (oldStatus === 'hotzone') {
      addLog('auto', `【人員進出】${member.team}組 隊員【${member.name}】已自熱區安全撤離，回到站外待命。`);
    } else {
      addLog('auto', `【人員異動】${member.team}組 隊員【${member.name}】設定為待命狀態。`);
    }
    member.entryTime = null;
    member.timerStarted = false;
    member.lastDuration = 0;
  }

  saveRoster();
  renderAll();
  triggerAudioSignal('warning');
}

// 啟動特定隊員的作業計時器
window.startMemberTimer = function(id, event) {
  if (event) event.stopPropagation(); // 阻止觸發卡片點擊彈出 Bottom Sheet
  
  const member = roster.find(m => m.id === id);
  if (!member) return;

  // 安全雙重防呆：檢查另一組此時是否在熱區
  const otherTeam = member.team === 'A' ? 'B' : 'A';
  const isOtherTeamActive = roster.some(m => m.team === otherTeam && m.status === 'hotzone');
  if (isOtherTeamActive) {
    alert(`⚠️ 管制警告！目前【搜救 ${otherTeam} 組】正在熱區作業，兩組不可同時在熱區出勤！`);
    return;
  }

  member.timerStarted = true;
  member.entryTime = new Date().toISOString();
  saveRoster();
  
  addLog('auto', `【計時啟動】${member.team}組 隊員【${member.name}】開始計算作業時間。`);
  renderAll();
  triggerAudioSignal('warning');
};

// 調動小隊編組 (供名冊編輯調動 A/B/預備)
window.moveMemberTeam = function(id, targetTeam) {
  const member = roster.find(m => m.id === id);
  if (!member) return;

  const oldTeam = member.team;
  member.team = targetTeam;
  
  // 若移至預備名單，狀態重設為待命，並清除任何計時
  if (targetTeam === 'standby') {
    member.status = 'standby';
    member.entryTime = null;
    member.lastDuration = 0;
  }

  saveRoster();
  
  const fromStr = oldTeam === 'standby' ? '預備名單' : `搜救 ${oldTeam} 組`;
  const toStr = targetTeam === 'standby' ? '預備名單' : `搜救 ${targetTeam} 組`;
  addLog('auto', `【編組調動】安全官將【${member.name}】由 ${fromStr} 調動至 ${toStr}。`);

  renderAll();
};

// 刪除人員
window.deleteMember = function(id) {
  const member = roster.find(m => m.id === id);
  if (!member) return;

  if (confirm(`確定要將隊員【${member.name}】自系統中移除嗎？`)) {
    roster = roster.filter(m => m.id !== id);
    saveRoster();
    addLog('auto', `【人員異動】移除隊員【${member.name}】。`);
    renderAll();
  }
};



// 一鍵撤退熱區所有人 (在點名 Modal 中的快捷動作)
function evacAllHotZoneMembers() {
  const hotzoneMembers = roster.filter(m => m.status === 'hotzone');
  if (hotzoneMembers.length === 0) return;

  hotzoneMembers.forEach(m => {
    m.status = 'standby';
    m.entryTime = null;
    m.timerStarted = false;
  });

  saveRoster();
  addLog('danger', `🚨【撤離記錄】熱區人員已全部撤出並回到「待命」狀態。請安全官落實點名確認！`);
  renderAll();
}

// --- 底部滑動選單 (Bottom Sheet) 處理 ---
function openStatusSheet(member) {
  selectedMemberForSheet = member.id;
  document.getElementById('sheet-member-name').textContent = member.name;
  
  let teamName = `搜救 ${member.team} 組`;
  if (member.team === 'standby') teamName = '預備名單';
  document.getElementById('sheet-member-team').textContent = teamName;

  // 依據隊員當前狀態，隱藏重複的狀態變更按鈕
  const btnStandby = document.querySelector('.sheet-btn[data-status="standby"]');
  const btnHotzone = document.querySelector('.sheet-btn[data-status="hotzone"]');

  if (member.status === 'standby') {
    btnStandby.classList.add('hidden');
    btnHotzone.classList.remove('hidden');
  } else if (member.status === 'hotzone') {
    btnStandby.classList.remove('hidden');
    btnHotzone.classList.add('hidden');
  } else {
    btnStandby.classList.remove('hidden');
    btnHotzone.classList.remove('hidden');
  }
  
  document.getElementById('status-sheet').classList.remove('hidden');
}

function closeStatusSheet() {
  document.getElementById('status-sheet').classList.add('hidden');
  selectedMemberForSheet = null;
}

// --- 查詢彈窗 (Modal) 處理 ---
function openHotzoneModal() {
  const modal = document.getElementById('hotzone-modal');
  const container = document.getElementById('hotzone-query-list');
  container.innerHTML = '';

  const hotMembers = roster.filter(m => m.status === 'hotzone');

  if (hotMembers.length === 0) {
    container.innerHTML = `<div class="no-hot-members">✅ 熱區目前安全，無作業人員。</div>`;
  } else {
    hotMembers.forEach(m => {
      let timeText = '待命計時';
      if (m.timerStarted && m.entryTime) {
        const elapsed = Math.floor((new Date() - new Date(m.entryTime)) / 1000);
        timeText = formatSeconds(elapsed);
      }
      const div = document.createElement('div');
      div.className = 'hot-query-item';
      div.innerHTML = `
        <div>
          <span class="name">${m.name}</span>
          <span class="badge badge-warning" style="margin-left: 8px;">${m.team}組</span>
        </div>
        <span class="timer">${timeText}</span>
      `;
      container.appendChild(div);
    });
  }

  modal.classList.remove('hidden');
}

function closeHotzoneModal() {
  document.getElementById('hotzone-modal').classList.add('hidden');
}

// --- 日誌管理與手動輸入 ---
function addManualLog() {
  const input = document.getElementById('manual-log-input');
  const text = input.value.trim();
  if (text) {
    addLog('manual', text);
    input.value = '';
    renderLogs();
    triggerAudioSignal('warning');
  }
}

function addLog(type, text, level = 'info') {
  logs.push({
    time: new Date().toISOString(),
    type,
    text
  });
  saveLogs();
}

// 匯出日誌為 CSV 檔案
function exportLogsToCSV() {
  let csvContent = "\uFEFF"; // UTF-8 BOM，防止 Excel 開啟亂碼
  csvContent += "時間,日誌類型,內容\n";

  logs.forEach(log => {
    const timeStr = new Date(log.time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    const cleanText = log.text.replace(/"/g, '""'); // 雙引號跳脫
    csvContent += `"${timeStr}","${log.type}","${cleanText}"\n`;
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  
  const today = new Date().toISOString().slice(0,10);
  link.setAttribute("href", url);
  link.setAttribute("download", `搜救管制站日誌_${today}.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  addLog('auto', '安全官匯出了管制系統日誌 CSV 檔。');
  renderLogs();
}

// --- 時間格式化小工具 ---
function formatSeconds(totalSeconds) {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// ==========================================
// 平板觸控拖曳 (Drag & Drop) 二合一邏輯
// ==========================================
let dragClone = null;
let activeDragId = null;
let dragStartX = 0;
let dragStartY = 0;
let dragStartTouchX = 0;
let dragStartTouchY = 0;
let isDragging = false;
let dragOriginalCard = null;

function setupDragAndDrop(cardEl, member) {
  // 綁定觸控事件
  cardEl.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    dragStartTouchX = touch.clientX;
    dragStartTouchY = touch.clientY;
    activeDragId = member.id;
    dragOriginalCard = cardEl;
    isDragging = false;
    
    // 記錄觸控點相對於卡片左上角的相對位置
    const rect = cardEl.getBoundingClientRect();
    dragStartX = dragStartTouchX - rect.left;
    dragStartY = dragStartTouchY - rect.top;
  }, { passive: true });

  cardEl.addEventListener('touchmove', (e) => {
    if (!activeDragId) return;
    const touch = e.touches[0];
    const dx = touch.clientX - dragStartTouchX;
    const dy = touch.clientY - dragStartTouchY;
    
    // 當手指移動超過 10 像素時，才判定為「拖曳動作」而非「點擊」
    if (!isDragging && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      isDragging = true;
      
      const rect = dragOriginalCard.getBoundingClientRect();
      // 複製一份暫時的卡片作為拖曳視覺分身
      dragClone = dragOriginalCard.cloneNode(true);
      dragClone.className = 'member-card dragging-clone';
      dragClone.style.position = 'fixed';
      dragClone.style.width = rect.width + 'px';
      dragClone.style.height = rect.height + 'px';
      dragClone.style.left = rect.left + 'px';
      dragClone.style.top = rect.top + 'px';
      dragClone.style.pointerEvents = 'none'; // 讓觸控點能穿透 clone 探測下方元素
      dragClone.style.zIndex = '2000';
      dragClone.style.opacity = '0.9';
      dragClone.style.transform = 'scale(1.04)';
      dragClone.style.boxShadow = '0 10px 25px rgba(0, 0, 0, 0.5)';
      dragClone.style.transition = 'none';
      document.body.appendChild(dragClone);
      
      // 原卡片半透明表示正在拖移
      dragOriginalCard.style.opacity = '0.35';
    }
    
    if (isDragging && dragClone) {
      e.preventDefault(); // 阻止平板滾動畫面
      
      // 讓卡片分身跟隨手指移動
      dragClone.style.left = (touch.clientX - dragStartX) + 'px';
      dragClone.style.top = (touch.clientY - dragStartY) + 'px';
      
      // 高亮標示目標區域
      highlightDropColumns(touch.clientX, touch.clientY);
    }
  }, { passive: false });

  cardEl.addEventListener('touchend', (e) => {
    if (!activeDragId) return;
    
    if (isDragging) {
      const touch = e.changedTouches[0];
      const targetColumn = findDropColumn(touch.clientX, touch.clientY);
      
      // 移除視覺分身與復原不透明度
      if (dragClone) {
        dragClone.remove();
        dragClone = null;
      }
      if (dragOriginalCard) {
        dragOriginalCard.style.opacity = '1';
      }
      
      // 移除所有看板欄位的高亮
      document.querySelectorAll('.board-column').forEach(col => col.classList.remove('drag-hover'));
      
      // 如果手指在正確的欄位釋放，執行變更狀態
      if (targetColumn) {
        const newStatus = targetColumn === 'col-hotzone' ? 'hotzone' : 'standby';
        changeMemberStatus(activeDragId, newStatus);
      }
    } else {
      // 若沒有明顯滑移，則判定為點選
      if (isMultiSelectMode) {
        toggleMemberSelection(member.id);
      } else {
        openStatusSheet(member);
      }
    }
    
    // 重設狀態變數
    activeDragId = null;
    dragOriginalCard = null;
    isDragging = false;
  });

  // 相容桌上型電腦點擊
  cardEl.addEventListener('click', (e) => {
    if (e.pointerType === 'touch') return;
    if (isDragging) return;
    if (isMultiSelectMode) {
      toggleMemberSelection(member.id);
    } else {
      openStatusSheet(member);
    }
  });
}

// 批次複選點擊切換輔助函數
function toggleMemberSelection(id) {
  if (selectedMemberIds.has(id)) {
    selectedMemberIds.delete(id);
  } else {
    selectedMemberIds.add(id);
  }
  
  // 更新複選計數
  const countEl = document.getElementById('batch-selected-count');
  if (countEl) {
    countEl.textContent = `已選 ${selectedMemberIds.size} 人`;
  }
  
  renderBoard();
}

function highlightDropColumns(x, y) {
  document.querySelectorAll('.board-column').forEach(col => col.classList.remove('drag-hover'));
  const colId = findDropColumn(x, y);
  if (colId) {
    document.getElementById(colId).classList.add('drag-hover');
  }
}

function findDropColumn(x, y) {
  const standbyCol = document.getElementById('col-standby');
  const hotzoneCol = document.getElementById('col-hotzone');
  
  if (standbyCol) {
    const rect = standbyCol.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return 'col-standby';
    }
  }
  
  if (hotzoneCol) {
    const rect = hotzoneCol.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return 'col-hotzone';
    }
  }
  
  return null;
}
