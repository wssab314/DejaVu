import { BlobRingBuffer } from "./ringBuffer.js";

const CHUNK_INTERVAL_MS = 1000;
const BUFFER_DURATION_MS = 5 * 60 * 1000;
const DOWNLOAD_FILENAME_PREFIX = "bug_capture";

const state = {
  recording: false,
  tabId: null,
  startedAt: null,
  stream: null,
  recorder: null,
  buffer: new BlobRingBuffer({
    chunkDurationMs: CHUNK_INTERVAL_MS,
    maxDurationMs: BUFFER_DURATION_MS
  }),
  chunkWaiters: new Set()
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      console.error("[DejaVu] Message handling failed", error);
      sendResponse({ ok: false, error: error.message ?? String(error) });
    });

  return true;
});

async function handleMessage(message, sender) {
  const { type } = message ?? {};
  switch (type) {
    case "START_RECORDING":
      return startRecording(message.tabId);
    case "STOP_RECORDING":
      return stopRecording();
    case "CAPTURE_BUG":
      return captureBug();
    case "GET_STATUS":
      return getStatus();
    default:
      console.warn("[DejaVu] Unknown message", message, sender);
      throw new Error("Unknown message type");
  }
}

async function startRecording(tabId) {
  if (state.recording) {
    throw new Error("Recording is already in progress.");
  }
  if (typeof tabId !== "number") {
    throw new Error("Missing active tab id.");
  }

  const stream = await captureTabStream(tabId);
  const recorder = createRecorder(stream);

  state.buffer.clear();
  state.tabId = tabId;
  state.stream = stream;
  state.recorder = recorder;
  state.startedAt = Date.now();
  state.recording = true;

  recorder.addEventListener("dataavailable", onChunkAvailable);
  recorder.addEventListener("stop", onRecorderStopped, { once: true });
  recorder.start(CHUNK_INTERVAL_MS);

  return getStatus();
}

async function stopRecording() {
  if (!state.recording) {
    cleanupRecorder();
    return getStatus();
  }

  if (state.recorder?.state === "recording") {
    safeRequestData();
  }

  await new Promise((resolve) => {
    if (!state.recorder) {
      resolve();
      return;
    }
    const onStopped = () => resolve();
    state.recorder.addEventListener("stop", onStopped, { once: true });
    try {
      state.recorder.stop();
    } catch (error) {
      console.warn("[DejaVu] Failed to stop recorder", error);
      resolve();
    }
  });

  cleanupRecorder();
  state.buffer.clear();

  return getStatus();
}

async function captureBug() {
  if (!state.recording) {
    throw new Error("Start recording before capturing a bug.");
  }

  if (state.recorder?.state === "recording") {
    safeRequestData();
    await waitForNextChunk(750).catch((error) => {
      console.warn("[DejaVu] Waiting for fresh chunk timed out", error);
    });
  }

  const blob = state.buffer.toBlob();
  if (!blob || blob.size === 0) {
    throw new Error("No video has been captured yet.");
  }

  const url = URL.createObjectURL(blob);
  const filename = buildCaptureFilename();

  try {
    await downloadUrl(url, filename);
  } finally {
    revokeUrlLater(url);
  }

  return {
    filename,
    bytes: blob.size,
    approxDurationMs: state.buffer.estimatedDurationMs
  };
}

function captureTabStream(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture(
      {
        video: true,
        audio: true,
        targetTabId: tabId,
        videoConstraints: {
          mandatory: {
            chromeMediaSource: "tab",
            maxFrameRate: 30,
            maxWidth: 1920,
            maxHeight: 1080
          }
        },
        audioConstraints: {
          mandatory: {
            chromeMediaSource: "tab"
          }
        }
      },
      (stream) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!stream) {
          reject(new Error("Failed to capture tab stream."));
          return;
        }
        resolve(stream);
      }
    );
  });
}

function downloadUrl(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

function createRecorder(stream) {
  const options = selectRecorderOptions();
  try {
    return new MediaRecorder(stream, options);
  } catch (primaryError) {
    console.warn("[DejaVu] Failed to init recorder with preferred options", primaryError);
    return new MediaRecorder(stream);
  }
}

function selectRecorderOptions() {
  const preferredTypes = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];

  for (const mimeType of preferredTypes) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return {
        mimeType,
        videoBitsPerSecond: 2_500_000,
        audioBitsPerSecond: 128_000
      };
    }
  }

  return {
    videoBitsPerSecond: 2_500_000,
    audioBitsPerSecond: 128_000
  };
}

function onChunkAvailable(event) {
  const { data } = event;
  if (!data || data.size === 0) {
    return;
  }
  state.buffer.push(data);
  resolveChunkWaiters();
}

function onRecorderStopped() {
  cleanupRecorder();
}

function waitForNextChunk(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      state.chunkWaiters.delete(resolveWrapper);
      reject(new Error("Timed out waiting for chunk."));
    }, timeoutMs);

    const resolveWrapper = () => {
      clearTimeout(timeoutId);
      state.chunkWaiters.delete(resolveWrapper);
      resolve();
    };

    state.chunkWaiters.add(resolveWrapper);
  });
}

function resolveChunkWaiters() {
  for (const waiter of state.chunkWaiters) {
    waiter();
  }
  state.chunkWaiters.clear();
}

function safeRequestData() {
  try {
    state.recorder?.requestData();
  } catch (error) {
    console.warn("[DejaVu] requestData failed", error);
  }
}

function cleanupRecorder() {
  state.recording = false;
  state.recorder?.removeEventListener("dataavailable", onChunkAvailable);
  state.recorder = null;
  state.tabId = null;
  state.startedAt = null;
  if (state.stream) {
    for (const track of state.stream.getTracks()) {
      track.stop();
    }
  }
  state.stream = null;
  resolveChunkWaiters();
}

function revokeUrlLater(url) {
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

function buildCaptureFilename() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${DOWNLOAD_FILENAME_PREFIX}_${timestamp}.webm`;
}

function getStatus() {
  return {
    recording: state.recording,
    startedAt: state.startedAt,
    tabId: state.tabId,
    chunkCount: state.buffer.length,
    approxDurationMs: state.buffer.estimatedDurationMs,
    approxSizeBytes: state.buffer.bytes
  };
}
