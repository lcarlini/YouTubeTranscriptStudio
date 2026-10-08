import { StudioError } from "../errors";
import { parseTranscriptPayload } from "../transcript/parse";
import type { TranscriptSegment } from "../types";
import { canonicalWatchUrl, thumbnailUrl } from "./url";

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}

export interface FetchedTranscript {
  videoId: string;
  url: string;
  title: string;
  author: string;
  thumbnailUrl: string;
  captionLanguage: string;
  segments: TranscriptSegment[];
  timestampsEstimated: boolean;
}

export interface FetchTranscriptOptions {
  preferredLanguages?: string[];
  youtubeProxyPrefix?: string | null;
  browserPage?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

interface OEmbedPayload {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}

interface PlayerPayload {
  playabilityStatus?: { status?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl?: string;
        languageCode?: string;
        kind?: string;
      }>;
    };
  };
}

const INVIDIOUS_INSTANCES = ["https://inv.nadeko.net"];

export function preferredCaptionLanguages(locale: string): string[] {
  const base = locale.toLowerCase().split("-")[0] || "en";
  return base === "en" ? ["en"] : [base, "en"];
}

export function pickCaptionTrack(tracks: CaptionTrack[], preferred: string[]): CaptionTrack | null {
  const usable = tracks.filter((track) => track.baseUrl && /^[a-z]{2,3}(?:-[a-z0-9]+)?$/i.test(track.languageCode));
  if (usable.length === 0) return null;
  for (const language of preferred) {
    const manual = usable.find((track) => track.languageCode.toLowerCase() === language && track.kind !== "asr");
    if (manual) return manual;
  }
  for (const language of preferred) {
    const any = usable.find((track) => track.languageCode.toLowerCase().startsWith(language));
    if (any) return any;
  }
  return usable[0] ?? null;
}

export async function fetchYouTubeTranscript(
  videoId: string,
  options: FetchTranscriptOptions = {},
): Promise<FetchedTranscript> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const preferred = options.preferredLanguages ?? ["en"];
  const meta = await fetchMetadata(videoId, fetchImpl, options.signal);
  try {
    const direct = await fetchDirect(videoId, preferred, options);
    return {
      videoId,
      url: canonicalWatchUrl(videoId),
      ...meta,
      ...direct,
      timestampsEstimated: false,
    };
  } catch (error) {
    const fallback = await fetchInvidious(videoId, preferred, fetchImpl, options.signal);
    if (fallback) {
      return { videoId, url: canonicalWatchUrl(videoId), ...meta, ...fallback, timestampsEstimated: false };
    }
    if (error instanceof StudioError) throw error;
    if (options.browserPage && isFetchFailure(error)) {
      throw new StudioError("cors-blocked", "The browser blocked a direct request to YouTube.");
    }
    if (isFetchFailure(error)) {
      throw new StudioError("network", "The transcript request failed.");
    }
    throw error instanceof Error ? error : new StudioError("network", "The transcript request failed.");
  }
}

async function fetchDirect(
  videoId: string,
  preferred: string[],
  options: FetchTranscriptOptions,
): Promise<{ segments: TranscriptSegment[]; captionLanguage: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const playerUrl = rewriteYouTubeUrl(
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    options.youtubeProxyPrefix,
  );
  let response: Response;
  try {
    response = await fetchImpl(playerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", hl: "en" } },
        videoId,
      }),
      signal: options.signal,
    });
  } catch (error) {
    if (options.browserPage) {
      throw new StudioError("cors-blocked", "The browser blocked a direct request to YouTube.");
    }
    throw new StudioError("network", error instanceof Error ? error.message : "Network error");
  }

  if (!response.ok) {
    throw new StudioError("network", `YouTube returned ${response.status} while loading captions.`);
  }

  const player = (await response.json()) as PlayerPayload;
  const tracks = (player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [])
    .filter((track) => track.baseUrl && track.languageCode)
    .map((track) => ({
      baseUrl: track.baseUrl as string,
      languageCode: track.languageCode as string,
      kind: track.kind,
    }));

  if (tracks.length === 0) {
    throw new StudioError("no-captions", "This video does not expose captions.");
  }

  const selected = pickCaptionTrack(tracks, preferred);
  if (!selected) {
    throw new StudioError("unsupported-language", "No usable caption language was found.");
  }

  const captionUrl = rewriteYouTubeUrl(selected.baseUrl, options.youtubeProxyPrefix);
  let captionResponse: Response;
  try {
    captionResponse = await fetchImpl(captionUrl, { signal: options.signal });
  } catch (error) {
    if (options.browserPage) {
      throw new StudioError("cors-blocked", "The browser blocked a direct request to YouTube.");
    }
    throw new StudioError("network", error instanceof Error ? error.message : "Network error");
  }
  if (!captionResponse.ok) {
    throw new StudioError("network", "The caption track could not be downloaded.");
  }
  const body = await captionResponse.text();
  const segments = parseTranscriptPayload(body);
  if (segments.length === 0) {
    throw new StudioError("no-captions", "The caption track was empty.");
  }
  return { segments, captionLanguage: selected.languageCode };
}

async function fetchInvidious(
  videoId: string,
  preferred: string[],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ segments: TranscriptSegment[]; captionLanguage: string } | null> {
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const listResponse = await fetchImpl(`${base}/api/v1/captions/${videoId}`, { signal });
      if (!listResponse.ok) continue;
      const payload = (await listResponse.json()) as {
        captions?: Array<{ label?: string; languageCode?: string; url?: string }>;
      };
      const tracks: CaptionTrack[] = (payload.captions ?? [])
        .filter((track) => track.url && track.languageCode)
        .map((track) => ({
          baseUrl: track.url as string,
          languageCode: track.languageCode as string,
        }));
      const selected = pickCaptionTrack(tracks, preferred) ?? tracks[0];
      if (!selected) continue;
      const url = selected.baseUrl.startsWith("http") ? selected.baseUrl : `${base}${selected.baseUrl}`;
      const bodyResponse = await fetchImpl(url, { signal });
      if (!bodyResponse.ok) continue;
      const text = await bodyResponse.text();
      const segments = parseTranscriptPayload(text);
      if (segments.length === 0) continue;
      return { segments, captionLanguage: selected.languageCode };
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchMetadata(
  videoId: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Pick<FetchedTranscript, "title" | "author" | "thumbnailUrl">> {
  const fallback = {
    title: "YouTube video",
    author: "",
    thumbnailUrl: thumbnailUrl(videoId),
  };
  try {
    const watch = canonicalWatchUrl(videoId);
    const response = await fetchImpl(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`,
      { signal },
    );
    if (!response.ok) return fallback;
    const data = (await response.json()) as OEmbedPayload;
    return {
      title: data.title?.trim() || fallback.title,
      author: data.author_name?.trim() || "",
      thumbnailUrl: data.thumbnail_url || fallback.thumbnailUrl,
    };
  } catch {
    return fallback;
  }
}

export function rewriteYouTubeUrl(url: string, proxyPrefix?: string | null): string {
  if (!proxyPrefix) return url;
  const parsed = new URL(url, "https://www.youtube.com");
  const prefix = proxyPrefix.replace(/\/$/, "");
  return `${prefix}${parsed.pathname}${parsed.search}`;
}

function isFetchFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof StudioError && error.code === "cors-blocked");
}
