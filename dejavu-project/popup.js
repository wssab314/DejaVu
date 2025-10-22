// 全局变量，用于清除计时器
let timerInterval = null;
const BUFFER_DURATION_SECONDS = 180; // 3分钟 (与 background.js 保持一致)

document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBtn');
  const captureBtn = document.getElementById('captureBtn');

  // 1. 页面加载时，立即从 background.js 获取当前状态
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError.message);
      return;
    }
    updateUI(response.isRecording, response.startTime);
  });

  // 2. "Start Recording" 按钮
  startBtn.addEventListener('click', () => {
    startBtn.disabled = true; // 立即禁用，防止双击
    
    chrome.runtime.sendMessage({ type: 'START_RECORDING' }, (response) => {
      if (response && response.success) {
        // 成功，重新获取状态以启动计时器
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
          updateUI(state.isRecording, state.startTime);
        });
      } else if (response && response.error) {
        // background.js 传来一个已知错误 (例如：在 chrome:// 页面)
        alert("启动失败: \n" + response.error);
        updateUI(false, null); // 重置回待命状态
      } else if (chrome.runtime.lastError) {
        // 发生意外错误
        console.error(chrome.runtime.lastError.message);
        alert("无法开始录制: " + chrome.runtime.lastError.message);
        updateUI(false, null); // 重置回待命状态
      }
    });
  });

  // 3. "Capture Bug!" 按钮
  captureBtn.addEventListener('click', () => {
    captureBtn.disabled = true; // 立即禁用
    chrome.runtime.sendMessage({ type: 'CAPTURE_BUG' }, (response) => {
      if (response && response.success) {
        updateUI(false, null); // 重置回待命状态
        window.close(); // 关闭 popup
      }
    });
  });

});

/**
 * 核心函数：根据状态更新整个 Popup UI
 * @param {boolean} isRecording 
 * @param {number | null} startTime 
 */
function updateUI(isRecording, startTime) {
  // 获取所有 UI 元素
  const statusIdle = document.getElementById('status-idle');
  const statusRecording = document.getElementById('status-recording');
  const startBtn = document.getElementById('startBtn');
  const captureBtn = document.getElementById('captureBtn');
  const timerEl = document.getElementById('timer');
  const bufferStatusEl = document.getElementById('buffer-status');
  
  // 停止任何正在运行的旧计时器
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  if (isRecording && startTime) {
    // --- 切换到“录制中”状态 ---
    statusIdle.style.display = 'none';
    statusRecording.style.display = 'block';
    startBtn.disabled = true;
    captureBtn.disabled = false;

    // 启动新计时器
    timerInterval = setInterval(() => {
      const elapsedMs = Date.now() - startTime;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);

      // 更新计时器 (MM:SS)
      timerEl.textContent = formatTime(elapsedMs);

      // 更新缓冲区状态
      if (elapsedSeconds < BUFFER_DURATION_SECONDS) {
        bufferStatusEl.textContent = `缓冲区: 正在填充... (${elapsedSeconds}s / ${BUFFER_DURATION_SECONDS}s)`;
      } else {
        bufferStatusEl.textContent = `缓冲区: 已满 (正在录制最后 ${BUFFER_DURATION_SECONDS / 60} 分钟)`;
      }
    }, 1000);

  } else {
    // --- 切换到“待命”状态 ---
    statusIdle.style.display = 'block';
    statusRecording.style.display = 'none';
    startBtn.disabled = false;
    captureBtn.disabled = true;
  }
}

/**
 * 辅助函数：将毫秒转换为 MM:SS 格式
 * @param {number} milliseconds 
 * @returns {string}
 */
function formatTime(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}