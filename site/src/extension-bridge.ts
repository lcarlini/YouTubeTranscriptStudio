import { StudioError } from "../../shared/src/errors";
import { EXTENSION_ID } from "../../shared/src/identity";
import { requestCaptionsFromYouTubeFrame } from "../../shared/src/youtube/caption-frame";
import type { FetchedTranscript } from "../../shared/src/youtube/fetch-transcript";

interface BridgeResponse {
  ok?: boolean;
  data?: FetchedTranscript;
  code?: string;
}

interface ChromeBridge {
  sendMessage: (
    extensionId: string,
    message: unknown,
    callback: (response: BridgeResponse | undefined) => void,
  ) => void;
  lastError?: { message?: string };
}

export function extensionReachable(): Promise<boolean> {
  const runtime = chromeRuntime();
  if (!runtime?.sendMessage) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 700);
    try {
      runtime.sendMessage(EXTENSION_ID, { type: "ping" }, (response) => {
        clearTimeout(timer);
        resolve(!runtime.lastError && Boolean(response?.ok));
      });
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

export async function tryCaptionFrame(videoId: string, languages: string[]): Promise<FetchedTranscript | null> {
  if (!(await extensionReachable())) return null;
  return requestCaptionsFromYouTubeFrame(videoId, languages);
}

export function tryExtensionFetch(videoId: string, languages: string[]): Promise<FetchedTranscript | null> {
  const runtime = chromeRuntime();
  if (!runtime?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    try {
      runtime.sendMessage(EXTENSION_ID, { type: "fetch-transcript", videoId, languages }, (response) => {
        if (runtime.lastError || !response) {
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
    } catch {
      resolve(null);
    }
  });
}

function chromeRuntime(): ChromeBridge | undefined {
  return (globalThis as { chrome?: { runtime?: ChromeBridge } }).chrome?.runtime;
}
