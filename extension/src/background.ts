import { StudioError } from "../../shared/src/errors";
import { transcriptFromCaptionResult } from "../../shared/src/youtube/caption-frame";
import type { FetchedTranscript } from "../../shared/src/youtube/fetch-transcript";
import { readCaptionXml } from "../../shared/src/youtube/read-caption-xml";
import type { CaptionXmlResult } from "../../shared/src/youtube/read-caption-xml";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "open-panel" && sender.tab?.id !== undefined) {
    void chrome.sidePanel
      .open({ tabId: sender.tab.id })
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "permission" }));
    return true;
  }
  if (message?.type === "caption-in-frame" && sender.tab?.id !== undefined && typeof message.videoId === "string") {
    const languages = Array.isArray(message.languages) ? message.languages.filter((item: unknown) => typeof item === "string") : ["en"];
    void readCaptionsInFrame(sender.tab.id, sender.frameId, message.videoId, languages)
      .then((result) => sendResponse(result))
      .catch((error: unknown) => sendResponse({ ok: false, code: "network", detail: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "fetch-transcript" && typeof message.videoId === "string") {
    respondWithTranscript(message, sendResponse);
    return true;
  }
  return undefined;
});

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ping") {
    sendResponse({ ok: true });
    return undefined;
  }
  if (message?.type !== "fetch-transcript" || typeof message.videoId !== "string") return undefined;
  respondWithTranscript(message, sendResponse);
  return true;
});

function respondWithTranscript(
  message: { videoId: string; languages?: unknown },
  sendResponse: (response: { ok: boolean; data?: FetchedTranscript; code?: string; error?: string }) => void,
): void {
  const languages = Array.isArray(message.languages) ? message.languages.filter((item: unknown) => typeof item === "string") : ["en"];
  void fetchTranscriptFromYouTubeFrame(message.videoId, languages)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error: unknown) => {
      const code = error instanceof StudioError ? error.code : "network";
      sendResponse({ ok: false, code, error: error instanceof Error ? error.message : "failed" });
    });
}

async function readCaptionsInFrame(
  tabId: number,
  frameId: number | undefined,
  videoId: string,
  languages: string[],
): Promise<CaptionXmlResult> {
  const injected = await chrome.scripting.executeScript({
    target: frameId === undefined ? { tabId } : { tabId, frameIds: [frameId] },
    world: "MAIN",
    func: readCaptionXml,
    args: [videoId, languages],
  });
  return injected[0]?.result ?? { ok: false, code: "network" };
}

async function fetchTranscriptFromYouTubeFrame(videoId: string, languages: string[]): Promise<FetchedTranscript> {
  const created = await openYouTubePopup(`https://www.youtube.com/embed/${encodeURIComponent(videoId)}?enablejsapi=1`);
  const tabId = created.tabs?.[0]?.id;
  if (created.id === undefined || tabId === undefined) {
    throw new StudioError("network", "The transcript request failed.");
  }
  try {
    await waitForTabComplete(tabId);
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: readCaptionXml,
      args: [videoId, languages],
    });
    const payload = injected[0]?.result;
    if (!payload) throw new StudioError("network", "The transcript request failed.");
    if (!payload.ok) {
      throw new StudioError(
        payload.code === "no-captions" ? "no-captions" : "network",
        payload.detail || "The transcript request failed.",
      );
    }
    return transcriptFromCaptionResult(videoId, payload);
  } finally {
    await chrome.windows.remove(created.id).catch(() => undefined);
  }
}

async function openYouTubePopup(url: string): Promise<chrome.windows.Window> {
  const created = await chrome.windows.create({ url, type: "popup", focused: false, width: 480, height: 320 });
  if (!created) throw new StudioError("network", "The transcript request failed.");
  return created;
}

function waitForTabComplete(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const timeout = setTimeout(() => finish(new Error("The YouTube frame did not load.")), 20000);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch(() => undefined);
  });
}
