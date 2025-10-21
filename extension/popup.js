const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const captureBtn = document.getElementById("captureBtn");
const statusDot = document.getElementById("statusDot");
const statusTitle = document.getElementById("statusTitle");
const statusMeta = document.getElementById("statusMeta");
const hintText = document.getElementById("hint");

let isBusy = false;
let currentStatus = null;

startBtn.addEventListener("click", withBusyGuard(startRecording));
stopBtn.addEventListener("click", withBusyGuard(stopRecording));
captureBtn.addEventListener("click", withBusyGuard(captureBug));

initializePopup().catch((error) => {
  console.error("[DejaVu] Failed to initialize popup", error);
  renderHint(`初始化失败: ${error.message ?? error}`);
});

function withBusyGuard(handler) {
  return async () => {
    if (isBusy) return;
    setBusy(true);
    try {
      await handler();
    } finally {
      setBusy(false);
    }
  };
}

async function initializePopup() {
  const status = await requestBackground({ type: "GET_STATUS" });
  renderStatus(status);
  renderHint("Grant tab capture when prompted to begin.");
}

async function startRecording() {
  const tabId = await queryActiveTabId();
  const status = await requestBackground({ type: "START_RECORDING", tabId });
  renderStatus(status);
  renderHint("Recording has started. Keep reproducing the bug.");
}

async function stopRecording() {
  const status = await requestBackground({ type: "STOP_RECORDING" });
  renderStatus(status);
  renderHint("Recording stopped. Start again when ready.");
}

async function captureBug() {
  const statusBefore = await requestBackground({ type: "GET_STATUS" });
  if (!statusBefore.recording) {
    renderHint("Start recording before capturing a bug.");
    return;
  }

  try {
    const captureResult = await requestBackground({ type: "CAPTURE_BUG" });
    renderHint(
      `Captured ${formatDuration(captureResult.approxDurationMs)} (~${formatBytes(
        captureResult.bytes
      )}). Check your downloads for ${captureResult.filename}.`
    );
  } catch (error) {
    renderHint(`Capture failed: ${error.message ?? error}`);
  }

  const status = await requestBackground({ type: "GET_STATUS" });
  renderStatus(status);
}

async function requestBackground(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (!response?.ok) {
    throw new Error(response?.error ?? "Unknown background error");
  }
  return response.result;
}

async function queryActiveTabId() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (!activeTab?.id) {
    throw new Error("未找到当前标签页");
  }
  return activeTab.id;
}

function renderStatus(status) {
  if (!status) return;
  currentStatus = status;
  const { recording, approxDurationMs, approxSizeBytes, startedAt } = status;

  if (recording) {
    statusTitle.textContent = "Recording";
    statusMeta.textContent = [
      formatDuration(approxDurationMs),
      formatBytes(approxSizeBytes),
      startedAt ? new Date(startedAt).toLocaleTimeString() : null
    ]
      .filter(Boolean)
      .join(" • ");
    statusDot.classList.add("is-recording");
  } else {
    statusTitle.textContent = "Idle";
    statusMeta.textContent = "Press Start Recording to begin.";
    statusDot.classList.remove("is-recording");
  }

  startBtn.disabled = recording || isBusy;
  stopBtn.disabled = !recording || isBusy;
  captureBtn.disabled = !recording || isBusy;
}

function renderHint(text) {
  if (!text) return;
  hintText.textContent = text;
}

function setBusy(busy) {
  isBusy = busy;
  if (currentStatus) {
    renderStatus(currentStatus);
  } else {
    startBtn.disabled = busy;
    stopBtn.disabled = busy;
    captureBtn.disabled = busy;
  }
}

function formatDuration(ms = 0) {
  if (!ms || ms <= 0) {
    return "0s";
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatBytes(bytes = 0) {
  if (!bytes || bytes <= 0) {
    return "0 MB";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}
