"use strict";
(() => {
  // shared/src/identity.ts
  var EXTENSION_ID = "ilghkafjpaojhclmnebepddhmndelhjl";

  // shared/src/youtube/caption-frame.ts
  var CAPTION_REQUEST = "yts-caption-request";
  var CAPTION_RESULT = "yts-caption-result";
  function isCaptionParentOrigin(origin, extensionId) {
    if (origin === `chrome-extension://${extensionId}`) return true;
    let url;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.hostname === "lcarlini.github.io" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  }

  // extension/src/caption-bridge.ts
  if (window.parent !== window) {
    const seen = /* @__PURE__ */ new Set();
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent || !isCaptionParentOrigin(event.origin, EXTENSION_ID)) return;
      const data = event.data;
      if (!data || data.source !== CAPTION_REQUEST || typeof data.videoId !== "string" || typeof data.requestId !== "string") return;
      if (seen.has(data.requestId)) return;
      seen.add(data.requestId);
      const languages = Array.isArray(data.languages) ? data.languages.filter((item) => typeof item === "string") : ["en"];
      const parentOrigin = event.origin;
      const videoId = data.videoId;
      const requestId = data.requestId;
      chrome.runtime.sendMessage({ type: "caption-in-frame", videoId, languages }, (result) => {
        const detail = chrome.runtime.lastError?.message;
        window.parent.postMessage(
          {
            source: CAPTION_RESULT,
            videoId,
            requestId,
            result: result ?? { ok: false, code: "network", detail }
          },
          parentOrigin
        );
      });
    });
  }
})();
