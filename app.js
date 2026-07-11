// =============================================================
// 搜救人員工作管制系統 - 核心邏輯 (app.js)
// =============================================================

// --- 預設人員名冊資料 ---
const DEFAULT_ROSTER = {
  A: [
    "施瑋強", "吳濟學", "顏志雄", "楊沂錄", "陳子向", 
    "蘇峰立", "田東正", "彭睿清", "潘俊儒", "林良耕", 
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
let radioTimerSeconds = 1200; // 預設 20 分鐘 (1200秒)
let radioTimerInterval = null;
let activeTimers = {}; // 記錄各熱區人員的計時器
let loopEvacAlertInterval = null; // 全面撤離的音效循環定時器

// Web Audio API 上下文 (延遲載入)
let audioCtx = null;

// --- 初始化程序 ---
document.addEventListener('DOMContentLoaded', () => {
  initData();
  setupEventListeners();
  startMissionTimer();
  startRadioTimer();
  renderAll();
});

// --- 資料儲存與載入 ---
function initData() {
  const localRoster = localStorage.getItem('rescue_roster');
  const localLogs = localStorage.getItem('rescue_logs');
  const localStartTime = localStorage.getItem('rescue_start_time');

  // 初始化人員
  if (localRoster) {
    roster = JSON.parse(localRoster);
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
  if (localStartTime) {
    missionStartTime = new Date(localStartTime);
  } else {
    missionStartTime = new Date();
    localStorage.setItem('rescue_start_time', missionStartTime.toISOString());
  }
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

// 1. 任務持續總時間
function startMissionTimer() {
  setInterval(() => {
    const elapsedMs = new Date() - missionStartTime;
    const hours = String(Math.floor(elapsedMs / 3600000)).padStart(2, '0');
    const minutes = String(Math.floor((elapsedMs % 3600000) / 60000)).padStart(2, '0');
    const seconds = String(Math.floor((elapsedMs % 60000) / 1000)).padStart(2, '0');
    document.getElementById('mission-timer').textContent = `${hours}:${minutes}:${seconds}`;
  }, 1000);
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
    triggerGlobalEvacuation();
    closeHotzoneModal();
  });

  // 全局緊急撤離按鈕 (大紅色按鈕)
  document.getElementById('global-evacuate-btn').addEventListener('click', triggerGlobalEvacuation);
  document.getElementById('close-overlay-btn').addEventListener('click', stopGlobalEvacuationAlert);

  // 音效播放按鈕
  document.getElementById('play-evac-audio').addEventListener('click', () => triggerAudioSignal('evacuate'));
  document.getElementById('play-quiet-audio').addEventListener('click', () => triggerAudioSignal('quiet'));
  document.getElementById('play-resume-audio').addEventListener('click', () => triggerAudioSignal('resume'));

  // 重設無線電計時器
  document.getElementById('reset-radio-timer-btn').addEventListener('click', () => {
    radioTimerSeconds = 1200;
    document.querySelector('.timer-reminder').classList.remove('alerting');
    addLog('auto', '無線電安全回報計時器已由安全官重設為 20 分鐘。');
    triggerAudioSignal('warning');
  });

  // 手動新增日誌
  document.getElementById('add-manual-log-btn').addEventListener('click', addManualLog);
  document.getElementById('manual-log-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addManualLog();
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
  const listReturned = document.getElementById('list-returned');

  // 清空看板
  listStandby.innerHTML = '';
  listHotzone.innerHTML = '';
  listReturned.innerHTML = '';

  let countS = 0;
  let countH = 0;
  let countR = 0;

  // 篩選當前選擇小隊且不在預備名單的人員
  const activeMembers = roster.filter(m => m.team === activeTeam);

  activeMembers.forEach(member => {
    const card = document.createElement('div');
    card.className = `member-card ${member.status === 'hotzone' ? 'in-hotzone' : ''}`;
    card.setAttribute('data-id', member.id);
    
    // 點擊卡片開啟底部變更狀態選單
    card.addEventListener('click', () => openStatusSheet(member));

    // 時間顯示邏輯
    let timeText = '--:--';
    if (member.status === 'hotzone' && member.entryTime) {
      card.classList.add('active-timer');
      const elapsed = Math.floor((new Date() - new Date(member.entryTime)) / 1000);
      timeText = formatSeconds(elapsed);
      
      // 超時 20 分鐘（1200秒）閃爍警示
      if (elapsed >= 1200) {
        card.classList.add('overtime');
      }
    } else if (member.status === 'returned' && member.lastDuration) {
      timeText = formatSeconds(member.lastDuration);
    }

    card.innerHTML = `
      <div class="member-info">
        <span class="member-name">${member.name}</span>
        <span class="member-team-label">搜救 ${member.team} 組</span>
      </div>
      <div class="member-time">
        <span>⏱️</span> <span class="timer-value" data-entry="${member.entryTime || ''}" data-duration="${member.lastDuration || 0}">${timeText}</span>
      </div>
    `;

    // 派發到對應的欄位
    if (member.status === 'standby') {
      listStandby.appendChild(card);
      countS++;
    } else if (member.status === 'hotzone') {
      listHotzone.appendChild(card);
      countH++;
    } else if (member.status === 'returned') {
      listReturned.appendChild(card);
      countR++;
    }
  });

  // 更新小隊看板的欄位人數計數器
  document.getElementById('count-standby').textContent = countS;
  document.getElementById('count-hotzone').textContent = countH;
  document.getElementById('count-returned').textContent = countR;

  // 啟動或重設看板時間即時刷新計時器
  startLiveCardTimer();
}

// 即時刷新看板中「熱區人員」卡片的時間
let cardTimerInterval = null;
function startLiveCardTimer() {
  if (cardTimerInterval) clearInterval(cardTimerInterval);
  
  cardTimerInterval = setInterval(() => {
    const activeTimerCards = document.querySelectorAll('.member-card.in-hotzone');
    activeTimerCards.forEach(card => {
      const id = card.getAttribute('data-id');
      const member = roster.find(m => m.id === id);
      if (member && member.entryTime) {
        const elapsed = Math.floor((new Date() - new Date(member.entryTime)) / 1000);
        const timerValEl = card.querySelector('.timer-value');
        if (timerValEl) {
          timerValEl.textContent = formatSeconds(elapsed);
        }
        
        // 檢查超時
        if (elapsed >= 1200) {
          card.classList.add('overtime');
        } else {
          card.classList.remove('overtime');
        }
      }
    });
  }, 1000);
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
    
    const timeStr = new Date(log.time).toLocaleTimeString('zh-TW', { hour12: false });
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

  member.status = newStatus;

  if (newStatus === 'hotzone') {
    // 進入熱區：開始計時，寫入時間
    member.entryTime = new Date().toISOString();
    member.lastDuration = 0;
    addLog('auto', `【人員進出】${member.team}組 隊員【${member.name}】進入危險工作區。`);
    
    // 智慧提醒：觸發「工作場地評估表」提醒
    showFormReminder('worksite');
  } 
  else if (newStatus === 'returned') {
    // 返回：計算總作業時間，清除進入時間
    if (member.entryTime) {
      const elapsed = Math.floor((new Date() - new Date(member.entryTime)) / 1000);
      member.lastDuration = elapsed;
      addLog('auto', `【人員進出】${member.team}組 隊員【${member.name}】已返回安全區，工作時間：${formatSeconds(elapsed)}。`);
    } else {
      addLog('auto', `【人員進出】${member.team}組 隊員【${member.name}】移至返回區。`);
    }
    member.entryTime = null;
    
    // 智慧提醒：觸發「受困者解救表」提醒
    showFormReminder('victim');
  } 
  else if (newStatus === 'standby') {
    // 回到待命
    member.entryTime = null;
    member.lastDuration = 0;
    addLog('auto', `【人員異動】${member.team}組 隊員【${member.name}】重設至待命狀態。`);
  }

  saveRoster();
  renderAll();
  triggerAudioSignal('warning');
}

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

// 智慧提醒標籤控制
function showFormReminder(formType) {
  if (formType === 'worksite') {
    const badge = document.getElementById('badge-worksite-remind');
    badge.classList.remove('hidden');
    // 取消 checkbox 勾選
    document.getElementById('chk-form-worksite').checked = false;
    addLog('auto', '【提示】人員已進入熱區，請記得至外部申報網站填寫「工作場地評估表」。', 'danger');
  } 
  else if (formType === 'victim') {
    const badge = document.getElementById('badge-victim-remind');
    badge.classList.remove('hidden');
    document.getElementById('chk-form-victim').checked = false;
    addLog('auto', '【提示】人員返回安全區，請確認是否需要填寫「受困者解救表」。');
  }
}

// 綁定檢核表 Checkbox 收回提醒
document.getElementById('chk-form-worksite').addEventListener('change', function() {
  if (this.checked) {
    document.getElementById('badge-worksite-remind').classList.add('hidden');
    addLog('auto', '安全官確認已完成「工作場地評估表」線上申報。');
  }
});
document.getElementById('chk-form-victim').addEventListener('change', function() {
  if (this.checked) {
    document.getElementById('badge-victim-remind').classList.add('hidden');
    addLog('auto', '安全官確認已完成「受困者解救表」線上申報。');
  }
});

// --- 全面緊急撤離機制 ---
function triggerGlobalEvacuation() {
  // 1. 熱區所有人員狀態變更為「熱區中」，但系統將觸發全畫面閃爍
  const hotzoneMembers = roster.filter(m => m.status === 'hotzone');
  
  addLog('danger', `🚨🚨🚨【緊急指令】安全官啟動「全面緊急撤退」！！！指定撤退地點：前進指揮站、車輛停放區、Boo。`, 'danger');
  
  // 2. 顯示全螢幕緊急撤退蓋板
  document.getElementById('emergency-overlay').classList.remove('hidden');

  // 3. 實體播送撤退嗶聲 (三短音，每聲1秒，每隔5秒重複一次)
  triggerAudioSignal('evacuate');
  if (loopEvacAlertInterval) clearInterval(loopEvacAlertInterval);
  loopEvacAlertInterval = setInterval(() => {
    triggerAudioSignal('evacuate');
  }, 5000);

  renderAll();
}

function stopGlobalEvacuationAlert() {
  document.getElementById('emergency-overlay').classList.add('hidden');
  if (loopEvacAlertInterval) {
    clearInterval(loopEvacAlertInterval);
    loopEvacAlertInterval = null;
  }
  addLog('auto', '緊急撤離警報音已由安全官關閉。');
}

// 一鍵撤退熱區所有人 (在點名 Modal 中的快捷動作)
function evacAllHotZoneMembers() {
  const hotzoneMembers = roster.filter(m => m.status === 'hotzone');
  if (hotzoneMembers.length === 0) return;

  hotzoneMembers.forEach(m => {
    m.status = 'returned';
    if (m.entryTime) {
      m.lastDuration = Math.floor((new Date() - new Date(m.entryTime)) / 1000);
    }
    m.entryTime = null;
  });

  saveRoster();
  addLog('danger', `🚨【撤離記錄】熱區人員已全部撤出並移至「已返回」名單。請安全官落實點名確認！`);
  renderAll();
}

// --- 底部滑動選單 (Bottom Sheet) 處理 ---
function openStatusSheet(member) {
  selectedMemberForSheet = member.id;
  document.getElementById('sheet-member-name').textContent = member.name;
  
  let teamName = `搜救 ${member.team} 組`;
  if (member.team === 'standby') teamName = '預備名單';
  document.getElementById('sheet-member-team').textContent = teamName;
  
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
      const elapsed = Math.floor((new Date() - new Date(m.entryTime)) / 1000);
      const div = document.createElement('div');
      div.className = 'hot-query-item';
      div.innerHTML = `
        <div>
          <span class="name">${m.name}</span>
          <span class="badge badge-warning" style="margin-left: 8px;">${m.team}組</span>
        </div>
        <span class="timer">${formatSeconds(elapsed)}</span>
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
    const timeStr = new Date(log.time).toLocaleString('zh-TW', { hour12: false });
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
