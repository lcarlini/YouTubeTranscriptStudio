import { StudioError } from "../errors";
import { parseTranscriptPayload } from "../transcript/parse";
import type { FetchedTranscript } from "./fetch-transcript";
import type { CaptionXmlResult } from "./read-caption-xml";
import { canonicalWatchUrl, thumbnailUrl } from "./url";

export const CAPTION_REQUEST = "yts-caption-request";
export const CAPTION_RESULT = "yts-caption-result";

export interface CaptionFrameRequest {
  source: typeof CAPTION_REQUEST;
  videoId: string;
  languages: string[];
  requestId: string;
}

export interface CaptionFrameResult {
  source: typeof CAPTION_RESULT;
  videoId: string;
  requestId: string;
  result: CaptionXmlResult;
}

export function isCaptionParentOrigin(origin: string, extensionId: string): boolean {
  if (origin === `chrome-extension://${extensionId}`) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname === "lcarlini.github.io" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

export function transcriptFromCaptionResult(videoId: string, result: CaptionXmlResult): FetchedTranscript {
  if (!result.ok) {
    throw new StudioError(
      result.code,
      result.code === "no-captions" ? "This video does not expose captions." : "The transcript request failed.",
    );
  }
  const segments = parseTranscriptPayload(result.xml);
  if (segments.length === 0) {
    throw new StudioError("no-captions", "The caption track was empty.");
  }
  return {
    videoId,
    url: canonicalWatchUrl(videoId),
    title: result.title || "YouTube video",
    author: result.author,
    thumbnailUrl: thumbnailUrl(videoId),
    captionLanguage: result.languageCode,
    segments,
    timestampsEstimated: false,
  };
}

export function requestCaptionsFromYouTubeFrame(
  videoId: string,
  languages: string[],
  timeoutMs = 12000,
): Promise<FetchedTranscript | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  const requestId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.title = "YouTube captions";
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;width:1px;height:1px;left:-10000px;top:0;border:0;opacity:0;pointer-events:none";
    iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?enablejsapi=1`;
    let settled = false;
    const finish = (value: FetchedTranscript | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.clearTimeout(retrySoon);
      window.clearTimeout(retryLater);
      window.removeEventListener("message", onMessage);
      iframe.remove();
      if (error) reject(error);
      else resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== "https://www.youtube.com") return;
      const data = event.data as Partial<CaptionFrameResult> | null;
      if (!data || data.source !== CAPTION_RESULT || data.requestId !== requestId || data.videoId !== videoId) return;
      if (!data.result) return;
      try {
        finish(transcriptFromCaptionResult(videoId, data.result));
      } catch (error) {
        finish(null, error);
      }
    };
    const send = () => {
      if (settled) return;
      iframe.contentWindow?.postMessage(
        { source: CAPTION_REQUEST, videoId, languages, requestId } satisfies CaptionFrameRequest,
        "https://www.youtube.com",
      );
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    const retrySoon = window.setTimeout(send, 700);
    const retryLater = window.setTimeout(send, 2000);
    window.addEventListener("message", onMessage);
    iframe.addEventListener("load", send);
    (document.body ?? document.documentElement).appendChild(iframe);
  });
}
