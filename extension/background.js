const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_DOCUMENT_JUSTIFICATION =
  "Record the active tab to capture pre-bug context.";
const DEFAULT_STATUS = {
  recording: false,
  approxSizeBytes: 0,
  approxDurationMs: 0,
  startedAt: null
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") {
    // Ignore messages that are intended for the offscreen document.
    return false;
  }

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
  if (typeof tabId !== "number") {
    throw new Error("Missing active tab id.");
  }

  return proxyToOffscreen({ type: "START_RECORDING", tabId });
}

async function stopRecording() {
  const status = await proxyToOffscreen({ type: "STOP_RECORDING" });
  if (!status?.recording) {
    await maybeCloseOffscreenDocument();
  }
  return status;
}

function captureBug() {
  return proxyToOffscreen({ type: "CAPTURE_BUG" });
}

function getStatus() {
  return proxyToOffscreen({ type: "GET_STATUS" });
}

async function proxyToOffscreen(payload) {
  if (payload?.type === "GET_STATUS") {
    const hasDocument = await chrome.offscreen?.hasDocument?.();
    if (!hasDocument) {
      return { ...DEFAULT_STATUS };
    }
  } else {
    await ensureOffscreenDocument();
  }

  const response = await chrome.runtime
    .sendMessage({
      ...payload,
      target: "offscreen"
    })
    .catch((error) => {
      console.error("[DejaVu] Failed to reach offscreen document", error);
      throw new Error("Offscreen document did not respond");
    });

  if (!response?.ok) {
    throw new Error(response?.error ?? "Unknown offscreen error");
  }

  return response.result;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error("Offscreen API is unavailable in this environment.");
  }

  const hasDocument = await chrome.offscreen.hasDocument?.();
  if (hasDocument) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.WEB_RTC],
    justification: OFFSCREEN_DOCUMENT_JUSTIFICATION
  });
}

async function maybeCloseOffscreenDocument() {
  if (!chrome.offscreen?.hasDocument) {
    return;
  }
  const hasDocument = await chrome.offscreen.hasDocument();
  if (!hasDocument) {
    return;
  }
  try {
    await chrome.offscreen.closeDocument();
  } catch (error) {
    console.warn("[DejaVu] Failed to close offscreen document", error);
  }
}
