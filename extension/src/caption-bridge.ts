import { EXTENSION_ID } from "../../shared/src/identity";
import { CAPTION_REQUEST, CAPTION_RESULT, isCaptionParentOrigin } from "../../shared/src/youtube/caption-frame";
import type { CaptionFrameRequest } from "../../shared/src/youtube/caption-frame";
import type { CaptionXmlResult } from "../../shared/src/youtube/read-caption-xml";

if (window.parent !== window) {
  const seen = new Set<string>();
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || !isCaptionParentOrigin(event.origin, EXTENSION_ID)) return;
    const data = event.data as Partial<CaptionFrameRequest> | null;
    if (!data || data.source !== CAPTION_REQUEST || typeof data.videoId !== "string" || typeof data.requestId !== "string") return;
    if (seen.has(data.requestId)) return;
    seen.add(data.requestId);
    const languages = Array.isArray(data.languages) ? data.languages.filter((item) => typeof item === "string") : ["en"];
    const parentOrigin = event.origin;
    const videoId = data.videoId;
    const requestId = data.requestId;
    chrome.runtime.sendMessage({ type: "caption-in-frame", videoId, languages }, (result: CaptionXmlResult | undefined) => {
      const detail = chrome.runtime.lastError?.message;
      window.parent.postMessage(
        {
          source: CAPTION_RESULT,
          videoId,
          requestId,
          result: result ?? { ok: false, code: "network", detail },
        },
        parentOrigin,
      );
    });
  });
}
