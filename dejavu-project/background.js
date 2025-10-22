// 1. 导入库
try {
  importScripts('lib/jszip.min.js');
} catch (e) {
  console.error("无法加载 jszip 库:", e);
}

// 2. 全局状态和常量
const RING_BUFFER_SIZE_SECONDS = 180; // 3 分钟
const TIMESLICE_MS = 1000; // 1 秒 (这必须与 offscreen.js 中的 timeslice 匹配)

let videoBuffer = [];
let networkLogs = [];
let actionLogs = [];
let isRecording = false;
let activeTabId = null;
let recordingStartTime = null;

const DEBUGGER_VERSION = "1.3";

// 3. 监听来自 Popup 和 Offscreen 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 必须是异步 sendResponse
  (async () => {
    
    // --- 来自 Popup.js ---
    if (request.type === 'GET_STATE') {
      sendResponse({ isRecording: isRecording, startTime: recordingStartTime });
      return;
    }

    if (request.type === 'START_RECORDING') {
      try {
        await startRecording();
        sendResponse({ success: true });
      } catch (err) {
        console.error("启动录制失败:", err.message, err);
        // 将错误消息（例如“用户取消了屏幕共享”）发送回 popup
        sendResponse({ success: false, error: err.message });
      }
      return;
    }

    if (request.type === 'CAPTURE_BUG') {
      await captureBug();
      sendResponse({ success: true });
      return;
    }

    // --- 来自 Content.js ---
    if (request.type === 'LOG_ACTION') {
      if (isRecording) {
        actionLogs.push(request.data);
      }
      return;
    }

    // --- (新) 接收来自 Offscreen.js 的视频数据块 ---
    if (request.type === 'VIDEO_CHUNK') {
      
      // --- 诊断日志 3 (现在将读取 request.buffer.byteLength) ---
      console.log(`Background: 收到 VIDEO_CHUNK。 大小: ${request.buffer?.byteLength} bytes. 当前 isRecording: ${isRecording}`);
      // --- 诊断日志 3 结束 ---

      // (关键) 必须检查 'request.buffer'
      if (isRecording && request.buffer) {
        
        // (关键) 从 ArrayBuffer 重建 Blob
        const newBlob = new Blob([request.buffer], { type: request.mimeType });
        
        // (关键) 将 *newBlob* 推入缓冲区
        videoBuffer.push(newBlob);
        
        // --- 诊断日志 4 ---
        console.log(`Background: 数据块已推入. videoBuffer 长度: ${videoBuffer.length}`);
        // --- 诊断日志 4 结束 ---

        if (videoBuffer.length > RING_BUFFER_SIZE_SECONDS) {
          videoBuffer.shift(); // 丢弃最老的数据块
        }
      } else if (isRecording) {
        console.warn("Background: 收到 VIDEO_CHUNK，但 request.buffer 为空或 undefined。");
      }
      return;
    }

    // --- (新) 当用户在 Offscreen 中手动停止分享时 ---
    if (request.type === 'RECORDING_STOPPED_FROM_OFFSCREEN') {
      console.log("录制已从 Offscreen 停止，自动抓取。");
      if (isRecording) {
        // 用户点击了浏览器UI上的“停止分享”
        await captureBug();
      }
      return;
    }

  })();
  
  return true; // 表示我们将异步回复
});

// 4. 核心功能：开始录制
async function startRecording() {
  if (isRecording) {
    console.warn("已经在录制中。");
    return;
  }

  // 获取当前标签页 (用于 debugger 和 content.js)
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab.id;

  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("https://chrome.google.com")) {
    throw new Error("无法在此页面上录制 (例如 'chrome://' 页面或 Chrome 商店)。请在一个普通网页上重试。");
  }

  // 重置缓冲区
  videoBuffer = [];
  networkLogs = [];
  actionLogs = [];

  // A. (新) 启动 Offscreen 文档并开始录制
  // 如果用户在 getDisplayMedia 弹窗中点击“取消”，这里会抛出错误
  await startOffscreenRecording();

  // B. 启动网络监听 (不变)
  await startNetworkListener(activeTabId);

  // C. 启动操作监听 (不变)
  await startActionListener(activeTabId);

  isRecording = true;
  recordingStartTime = Date.now();
  // 更新图标为“录制中”
  // chrome.action.setIcon({
  //   path: {
  //     "16": "icons/icon16-recording.png",
  //     "48": "icons/icon48-recording.png"
  //   }
  // });
}

// 4A. (新) 启动屏外文档并发送消息
async function startOffscreenRecording() {
  // 检查是否已有屏外文档，有则先关闭
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }

  // 创建屏外文档
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Need to capture tab video stream using getDisplayMedia()'
  });
  
  // 向 offscreen.js 发送消息，让它开始
  // sendMessage 会等待 offscreen.js 中的 sendResponse 被调用
  console.log("正在向 Offscreen 发送 START_OFFSCREEN_RECORDING...");
  const response = await chrome.runtime.sendMessage({
    type: 'START_OFFSCREEN_RECORDING'
  });

  if (!response || !response.success) {
    // 如果 response.success 为 false，是 getDisplayMedia 失败 (例如用户点击了“取消”)
    await closeOffscreenDocument(); // 清理
    throw new Error(response?.error || "无法从 Offscreen 开始录制 (用户可能已取消)");
  }
  console.log("Offscreen 已确认开始录制。");
}

// (新) 关闭屏外文档的辅助函数
async function closeOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (existingContexts.length > 0) {
        await chrome.offscreen.closeDocument();
    }
}

// 4B. 网络监听 (Debugger API) - (不变)
function startNetworkListener(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId: tabId }, DEBUGGER_VERSION, () => {
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      // 启用网络域
      chrome.debugger.sendCommand({ tabId: tabId }, "Network.enable", {}, () => {
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError);
        }
        resolve();
      });
    });
  });
}

// 4C. 操作监听 (注入 Content Script) - (不变)
function startActionListener(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ['content.js']
  });
}

// 5. 核心功能：抓取 BUG (停止、打包、下载)
async function captureBug() {
  if (!isRecording) return;
  isRecording = false;
  recordingStartTime = null;
  console.log("正在抓取 BUG...");

  // A. (新) 停止 Offscreen 录制
  // 我们将告诉 offscreen 停止，它会在停止后自行关闭
  try {
    await chrome.runtime.sendMessage({
      type: 'STOP_OFFSCREEN_RECORDING'
    });
  } catch (e) {
    // 如果 offscreen 已经关闭 (例如用户手动停止)，这里会报错，忽略它
    console.warn("发送 STOP_OFFSCREEN_RECORDING 时出错 (可能已停止):", e.message);
  }

  // B. 停止网络监听 (不变)
  if (activeTabId) {
    try {
      await chrome.debugger.detach({ tabId: activeTabId });
    } catch(e) {
      console.warn("无法分离 debugger:", e.message);
    }
  }

  // C. 打包下载
  // 增加延迟以确保最后一块 blob (从 offscreen 发来) 已经被推入 buffer
  setTimeout(async () => {
    await packageAndDownload();

    // D. 重置状态
    videoBuffer = [];
    networkLogs = [];
    actionLogs = [];
    activeTabId = null;
    
    // 恢复图标
    chrome.action.setIcon({
      path: {
        "16": "icons/icon16.png",
        "48": "icons/icon48.png"
      }
    });
  }, 500); // 延迟 500ms 确保跨进程消息和 blob 传输完成
}

  /**
 * (新) 辅助函数：将 Blob 转换为 Data URL
 * @param {Blob} blob 
 * @returns {Promise<string>}
 */
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

// 5C. 打包和下载 (JSZip)
async function packageAndDownload() {
  try {
    console.log(`Background: 开始打包. videoBuffer 中有 ${videoBuffer.length} 个数据块.`);
    if (videoBuffer.length > 0) {
        console.log("第一个数据块大小:", videoBuffer[0].size); // <-- videoBuffer[0] 现在是 Blob， .size 会正常工作
    }
    const zip = new JSZip();

    // 1. 添加视频
    const videoBlob = new Blob(videoBuffer, { type: 'video/webm' });
    zip.file("Video.webm", videoBlob);

    // 2. 添加网络日志
    const networkJson = JSON.stringify(networkLogs, null, 2);
    zip.file("Network.json", networkJson);

    // 3. 添加操作日志
    const actionsJson = JSON.stringify(actionLogs, null, 2);
    zip.file("Actions.json", actionsJson);

    // 4. 生成 ZIP Blob
    const zipBlob = await zip.generateAsync({ type: "blob" });

    // 5. (新) 触发下载 - 转换 Blob 为 Data URL
    const url = await blobToDataURL(zipBlob);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `bug_report_[${timestamp}].zip`;

    chrome.downloads.download({
      url: url,
      filename: filename
    }, (downloadId) => {
      // Data URL 不需要 revoke
      if (chrome.runtime.lastError) {
        console.error("下载启动失败:", chrome.runtime.lastError.message);
      } else {
        console.log("下载已开始, ID:", downloadId);
      }
    });

  } catch (err) {
    console.error("打包失败:", err);
  }
}

// 6. Debugger 事件监听器 (包含 getResponseBody 改进)
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== activeTabId || !isRecording) {
    return;
  }

  // 只记录 Fetch 和 XHR
  const types = ['Fetch', 'XHR'];

  if (method === "Network.requestWillBeSent") {
    if (types.includes(params.type)) {
      networkLogs.push({
        type: 'Request',
        timestamp: params.wallTime,
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        headers: params.request.headers,
        postData: params.request.postData // 额外记录 POST 数据
      });
    }
  }

  if (method === "Network.responseReceived") {
    if (types.includes(params.type)) {
      networkLogs.push({
        type: 'Response',
        timestamp: params.wallTime,
        requestId: params.requestId,
        status: params.response.status,
        statusText: params.response.statusText,
        headers: params.response.headers,
        body: null // 先占位
      });

      // --- 异步获取 Response Body ---
      try {
        chrome.debugger.sendCommand(
          { tabId: source.tabId },
          "Network.getResponseBody",
          { requestId: params.requestId },
          (responseBodyParams) => {
            if (chrome.runtime.lastError) {
              // console.warn("无法获取 response body (可能没有body):", chrome.runtime.lastError.message);
              return;
            }

            // 找到我们刚才添加的日志条目
            const logEntry = networkLogs.find(
              log => log.requestId === params.requestId && log.type === 'Response'
            );
            if (logEntry) {
              if (responseBodyParams.base64Encoded) {
                logEntry.body = "[Base64 Encoded Body]"; 
              } else {
                logEntry.body = responseBodyParams.body;
              }
            }
          }
        );
      } catch (e) {
        console.warn("获取 response body 时出错:", e.message);
      }
      // --- 异步获取结束 ---
    }
  }
});

// 7. 标签页移除监听器 (不变)
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId && isRecording) {
    console.log("目标标签页已关闭，自动停止录制。");
    captureBug();
  }
});