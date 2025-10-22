let mediaRecorder = null;
let stream = null; // 必须保留 stream 的引用以停止它

// 1. 监听来自 background.js 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'START_OFFSCREEN_RECORDING') {
    startRecording(sendResponse);
    return true; // 保持消息通道开放以进行异步响应
  }
  
  if (request.type === 'STOP_OFFSCREEN_RECORDING') {
    stopRecording();
    sendResponse({ success: true });
  }
});

// 2. 开始录制 (核心 WebRTC 逻辑)
async function startRecording(sendResponse) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    console.warn("Offscreen: 已经在录制中。");
    sendResponse({ success: false, error: "Already recording" });
    return;
  }

  try {
    // 关键：弹出“选择”对话框
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: false // 我们的插件不需要音频
    });

    const mimeType = 'video/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      sendResponse({ success: false, error: "MimeType not supported" });
      return;
    }

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType
    });

    // 3. 当数据块可用时，立即将其发送到 background.js
    mediaRecorder.ondataavailable = async (event) => { // <-- 必须有 'async'
        if (event.data && event.data.size > 0) {
          
          // --- 诊断日志 1 ---
          console.log(`Offscreen: 捕获到数据块! 大小: ${event.data.size} bytes`);
          
          // (关键) 将 Blob 转换为 ArrayBuffer
          const arrayBuffer = await event.data.arrayBuffer();
          const mimeType = mediaRecorder.mimeType;
  
          // (关键) 发送 'buffer' 和 'mimeType'
          chrome.runtime.sendMessage({
            type: 'VIDEO_CHUNK',
            buffer: arrayBuffer, // <-- 必须是 'buffer'
            mimeType: mimeType
          });
        } else {
          if (event.data && event.data.size === 0) {
              console.warn("Offscreen: 捕获到数据块，但大小为 0。");
          } else {
              console.error("Offscreen: ondataavailable 触发，但 event.data 不存在!");
          }
        }
      };
    
    // 4. 启动录制并切片
    // 注意：这里的 timeslice 必须与 background.js 中的 RING_BUFFER_SIZE 匹配
    mediaRecorder.start(1000); // 每 1 秒一个数据块

    // 当用户手动停止分享（例如点击浏览器上的“停止分享”按钮）
    stream.getVideoTracks()[0].onended = () => {
      stopRecording();
    };

    sendResponse({ success: true });

  } catch (err) {
    console.error("Offscreen: getDisplayMedia 失败:", err);
    sendResponse({ success: false, error: err.message });
  }
}

// 4. 停止录制
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
  mediaRecorder = null;
  stream = null;
  
  // 告诉 background.js 我们已停止
  chrome.runtime.sendMessage({ type: 'RECORDING_STOPPED_FROM_OFFSCREEN' });
  
  // 我们可以关闭这个屏外文档以释放资源
  window.close();
}