import { EXTENSION_ID } from "../../shared/src/identity";
import type { FetchedTranscript } from "../../shared/src/youtube/fetch-transcript";

interface BridgeResponse {
  ok?: boolean;
  data?: FetchedTranscript;
}

interface ChromeBridge {
  sendMessage: (
    extensionId: string,
    message: unknown,
    callback: (response: BridgeResponse | undefined) => void,
  ) => void;
  lastError?: { message?: string };
}

export function tryExtensionFetch(videoId: string, languages: string[]): Promise<FetchedTranscript | null> {
  const runtime = (globalThis as { chrome?: { runtime?: ChromeBridge } }).chrome?.runtime;
  if (!runtime?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      runtime.sendMessage(EXTENSION_ID, { type: "fetch-transcript", videoId, languages }, (response) => {
        if (runtime.lastError || !response?.ok || !response.data) resolve(null);
        else resolve(response.data);
      });
    } catch {
      resolve(null);
    }
  });
}
