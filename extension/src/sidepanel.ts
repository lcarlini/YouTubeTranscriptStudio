import { StudioError } from "../../shared/src/errors";
import { mountStudio } from "../../shared/src/ui/studio-app";
import "../../shared/src/ui/app.css";
import { PREF_LANGUAGE, localSet } from "../../shared/src/storage/preferences";
import { requestCaptionsFromYouTubeFrame, transcriptFromCaptionResult } from "../../shared/src/youtube/caption-frame";
import type { FetchedTranscript } from "../../shared/src/youtube/fetch-transcript";
import type { CaptionXmlResult } from "../../shared/src/youtube/read-caption-xml";
import { canonicalWatchUrl, parseYouTubeVideoId } from "../../shared/src/youtube/url";

const root = document.querySelector("#app");
if (root instanceof HTMLElement) {
  mountStudio(root, {
    mode: "extension",
    devProxy: false,
    wasmPaths: chrome.runtime.getURL("dist/wasm/"),
    requestOrigin: requestApiOrigin,
    getContextVideo: async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return null;
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: "get-video" });
        if (typeof response?.videoId === "string" && response.videoId) return response.videoId;
      } catch {
        // The content script is only injected on watch pages.
      }
      return parseYouTubeVideoId(tab.url ?? "");
    },
    openAtTimestamp: (videoId, seconds) => {
      void seekOrOpen(videoId, seconds);
    },
    tryCaptionFrame: async (videoId, languages) => {
      const fromTab = await tryActiveTabCaptions(videoId, languages);
      if (fromTab) return fromTab;
      return requestCaptionsFromYouTubeFrame(videoId, languages);
    },
    tryExtensionFetch: (videoId, languages) => requestExtensionTranscript(videoId, languages),
    onLocaleChange: (locale) => {
      localSet(PREF_LANGUAGE, locale);
      void chrome.storage.local.set({ [PREF_LANGUAGE]: locale });
    },
  });
  const saved = localStorage.getItem(PREF_LANGUAGE);
  if (saved) void chrome.storage.local.set({ [PREF_LANGUAGE]: saved });
}

async function tryActiveTabCaptions(videoId: string, languages: string[]): Promise<FetchedTranscript | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || parseYouTubeVideoId(tab.url ?? "") !== videoId) return null;
  const response = (await chrome.runtime.sendMessage({ type: "captions-from-tab", tabId: tab.id, videoId, languages })) as
    | CaptionXmlResult
    | undefined;
  if (!response?.ok) {
    console.warn("[YTS] active tab captions unavailable", response);
    return null;
  }
  return transcriptFromCaptionResult(videoId, response);
}

function requestExtensionTranscript(videoId: string, languages: string[]): Promise<FetchedTranscript | null> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "fetch-transcript", videoId, languages }, (response: { ok?: boolean; data?: FetchedTranscript; code?: string } | undefined) => {
      if (chrome.runtime.lastError || !response) {
        resolve(null);
        return;
      }
      if (response.ok && response.data) {
        resolve(response.data);
        return;
      }
      if (response.code === "no-captions" || response.code === "unsupported-language") {
        reject(new StudioError(response.code, "The transcript request failed."));
        return;
      }
      resolve(null);
    });
  });
}

async function seekOrOpen(videoId: string, seconds: number): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && parseYouTubeVideoId(tab.url ?? "") === videoId) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "seek", seconds });
      if (response?.ok) return;
    } catch {
      // Fall through and open the timestamped watch URL.
    }
  }
  await chrome.tabs.create({ url: canonicalWatchUrl(videoId, seconds) });
}

/** Local servers (Ollama on localhost) are already allowed by the manifest; other hosts need a grant. */
async function requestApiOrigin(url: string): Promise<boolean> {
  const origin = new URL(url).origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return chrome.permissions.request({ origins: [`${origin}/*`] });
}