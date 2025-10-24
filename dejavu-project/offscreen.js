let mediaRecorder = null;
let stream = null; // 必须保留 stream 的引用以停止它
let port = null;   // 与 background 建立的长连接，用于传输视频数据

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function ensurePort() {
  if (port) {
    return port;
  }

  port = chrome.runtime.connect({ name: 'offscreen-video' });
  port.onDisconnect.addListener(() => {
    port = null;
  });
  return port;
}

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

    ensurePort();

    // 3. 当数据块可用时，立即将其发送到 background.js
    mediaRecorder.ondataavailable = async (event) => {
        if (event.data && event.data.size > 0) {

          // --- 诊断日志 1 ---
          console.log(`Offscreen: 捕获到数据块! 大小: ${event.data.size} bytes`);

          const chunk = event.data;
          const mimeType = chunk.type || mediaRecorder.mimeType;

          const tryPostViaPort = async () => {
            const currentPort = ensurePort();
            if (!currentPort) {
              return false;
            }
            try {
              const original = await chunk.arrayBuffer();
              const transferable = original.slice(0);
              currentPort.postMessage({
                type: 'VIDEO_CHUNK',
                buffer: transferable,
                mimeType: mimeType
              }, [transferable]);
              return true;
            } catch (err) {
              console.error("Offscreen: 发送视频数据块失败:", err);
              if (port === currentPort) {
                try {
                  currentPort.disconnect();
                } catch (e) {
                  console.warn("Offscreen: 断开故障端口失败:", e.message);
                }
                port = null;
              }
              return false;
            }
          };

          let delivered = await tryPostViaPort();

          if (!delivered) {
            try {
              const fallbackBuffer = await chunk.arrayBuffer();
              const fallbackBase64 = arrayBufferToBase64(fallbackBuffer);
              chrome.runtime.sendMessage({
                type: 'VIDEO_CHUNK',
                buffer: fallbackBuffer.slice(0),
                base64: fallbackBase64,
                mimeType: mimeType
              }, () => {
                if (chrome.runtime.lastError) {
                  console.error("Offscreen: sendMessage 发送失败:", chrome.runtime.lastError.message);
                }
              });
              delivered = true;
            } catch (err) {
              console.error("Offscreen: 回退发送失败:", err);
            }
          }
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
  if (port) {
    try {
      port.disconnect();
    } catch (e) {
      console.warn("Offscreen: 断开端口失败:", e.message);
    }
    port = null;
  }
  
  // 告诉 background.js 我们已停止
  chrome.runtime.sendMessage({ type: 'RECORDING_STOPPED_FROM_OFFSCREEN' });
  
  // 我们可以关闭这个屏外文档以释放资源
  window.close();
}
