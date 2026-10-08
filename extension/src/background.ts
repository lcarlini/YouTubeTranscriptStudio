import { fetchYouTubeTranscript } from "../../shared/src/youtube/fetch-transcript";

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
  return undefined;
});

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "fetch-transcript" || typeof message.videoId !== "string") return undefined;
  const languages = Array.isArray(message.languages) ? message.languages.filter((item: unknown) => typeof item === "string") : ["en"];
  void fetchYouTubeTranscript(message.videoId, { preferredLanguages: languages, browserPage: false })
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "failed" }));
  return true;
});
