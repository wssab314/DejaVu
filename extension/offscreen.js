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
  if (message?.target !== "offscreen") {
    return false;
  }

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      console.error("[DejaVu] Offscreen message handling failed", error);
      sendResponse({ ok: false, error: error.message ?? String(error) });
    });

  return true;
});

async function handleMessage(message) {
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
      console.warn("[DejaVu] Unknown offscreen message", message);
      throw new Error("Unknown offscreen message type");
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
  const { recorder, mimeType } = createRecorder(stream);

  state.buffer.clear();
  if (mimeType) {
    state.buffer.setMimeType(mimeType);
  }
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
  let recorder;
  try {
    recorder = new MediaRecorder(stream, options);
  } catch (primaryError) {
    console.warn("[DejaVu] Failed to init recorder with preferred options", primaryError);
    recorder = new MediaRecorder(stream);
  }

  const resolvedMimeType = recorder.mimeType || options?.mimeType || null;
  return { recorder, mimeType: resolvedMimeType };
}

function selectRecorderOptions() {
  const preferredMimeTypes = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];

  for (const mimeType of preferredMimeTypes) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return { mimeType };
    }
  }

  return undefined;
}

function onChunkAvailable(event) {
  const chunk = event.data;
  if (!chunk || chunk.size === 0) {
    return;
  }

  state.buffer.push(chunk);
  resolveChunkWaiters();
}

function onRecorderStopped() {
  cleanupRecorder();
  resolveChunkWaiters(new Error("Recorder stopped."));
}

function cleanupRecorder() {
  if (state.recorder) {
    try {
      state.recorder.removeEventListener("dataavailable", onChunkAvailable);
    } catch (error) {
      console.warn("[DejaVu] Failed to remove data listener", error);
    }
  }

  if (state.stream) {
    try {
      state.stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      console.warn("[DejaVu] Failed to stop stream tracks", error);
    }
  }

  state.recorder = null;
  state.stream = null;
  state.recording = false;
  state.startedAt = null;
  state.tabId = null;
}

function safeRequestData() {
  try {
    state.recorder?.requestData();
  } catch (error) {
    console.warn("[DejaVu] Failed to request data", error);
  }
}

function waitForNextChunk(timeoutMs) {
  return new Promise((resolve, reject) => {
    let timeout = null;
    const waiter = (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      state.chunkWaiters.delete(waiter);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    state.chunkWaiters.add(waiter);
    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => {
        waiter(new Error("Timed out waiting for chunk"));
      }, timeoutMs);
    }
  });
}

function resolveChunkWaiters(error) {
  if (state.chunkWaiters.size === 0) {
    return;
  }
  for (const waiter of Array.from(state.chunkWaiters)) {
    try {
      waiter(error);
    } catch (listenerError) {
      console.warn("[DejaVu] Chunk waiter failed", listenerError);
    }
  }
  state.chunkWaiters.clear();
}

function buildCaptureFilename() {
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  return `${DOWNLOAD_FILENAME_PREFIX}_${timestamp}.webm`;
}

function revokeUrlLater(url) {
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch (error) {
      console.warn("[DejaVu] Failed to revoke capture URL", error);
    }
  }, 5000);
}

function getStatus() {
  const approxSizeBytes = state.buffer.bytes ?? 0;
  const approxDurationMs = state.buffer.estimatedDurationMs;
  return {
    recording: state.recording,
    approxSizeBytes,
    approxDurationMs,
    startedAt: state.startedAt
  };
}
