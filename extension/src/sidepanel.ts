import { mountStudio } from "../../shared/src/ui/studio-app";
import "../../shared/src/ui/app.css";
import { PREF_LANGUAGE, localSet } from "../../shared/src/storage/preferences";
import { canonicalWatchUrl, parseYouTubeVideoId } from "../../shared/src/youtube/url";

const root = document.querySelector("#app");
if (root instanceof HTMLElement) {
  mountStudio(root, {
    mode: "extension",
    devProxy: false,
    wasmPaths: chrome.runtime.getURL("dist/wasm/"),
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
    onLocaleChange: (locale) => {
      localSet(PREF_LANGUAGE, locale);
      void chrome.storage.local.set({ [PREF_LANGUAGE]: locale });
    },
  });
  const saved = localStorage.getItem(PREF_LANGUAGE);
  if (saved) void chrome.storage.local.set({ [PREF_LANGUAGE]: saved });
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
