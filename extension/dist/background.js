// ../shared/src/errors.ts
var StudioError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "StudioError";
    this.code = code;
  }
};

// ../shared/src/transcript/parse.ts
function decodeCaptionText(value) {
  return value.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits))).replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/\s+/g, " ").trim();
}
function createSegment(index, start, duration, text) {
  const clean = decodeCaptionText(text);
  return {
    id: `s${index}-${Math.round(Math.max(0, start) * 1e3)}`,
    start: roundSeconds(start),
    duration: roundSeconds(Math.max(0, duration)),
    text: clean
  };
}
function roundSeconds(value) {
  return Math.round(value * 1e3) / 1e3;
}
function readAttr(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? match[1] ?? match[2] ?? match[3] ?? "" : null;
}
function parseTimedTextXml(xml) {
  const segments = [];
  const pattern = /<(p|text)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while (match = pattern.exec(xml)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] ?? "";
    const inner = match[3] ?? "";
    let start = 0;
    let duration = 0;
    if (tag === "p") {
      start = Number(readAttr(attrs, "t") ?? "0") / 1e3;
      duration = Number(readAttr(attrs, "d") ?? "0") / 1e3;
    } else {
      start = Number(readAttr(attrs, "start") ?? "0");
      duration = Number(readAttr(attrs, "dur") ?? "0");
    }
    const text = decodeCaptionText(inner);
    if (!text || Number.isNaN(start)) continue;
    segments.push(createSegment(segments.length, start, duration, text));
  }
  return segments;
}
function parseJson3(payload) {
  const data = JSON.parse(payload);
  const segments = [];
  for (const event of data.events ?? []) {
    const text = decodeCaptionText((event.segs ?? []).map((seg) => seg.utf8 ?? "").join(""));
    if (!text) continue;
    const start = (event.tStartMs ?? 0) / 1e3;
    const duration = (event.dDurationMs ?? 0) / 1e3;
    segments.push(createSegment(segments.length, start, duration, text));
  }
  return segments;
}
function parseCueBlock(body) {
  const normalized = body.replace(/\r/g, "");
  const lines = normalized.split("\n");
  const segments = [];
  const clock = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}`;
  const timing = new RegExp(`^(${clock})\\s+-->\\s+(${clock})`);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    const match = line.match(timing);
    if (!match) {
      index += 1;
      continue;
    }
    const start = parseFlexibleClock(match[1]);
    const end = parseFlexibleClock(match[2]);
    index += 1;
    const textLines = [];
    while (index < lines.length && (lines[index]?.trim() ?? "") !== "") {
      textLines.push(lines[index] ?? "");
      index += 1;
    }
    const text = decodeCaptionText(textLines.join(" "));
    if (text) {
      segments.push(createSegment(segments.length, start, Math.max(0, end - start), text));
    }
  }
  return segments;
}
function parseFlexibleClock(value) {
  const clean = value.trim().replace(",", ".");
  const [main, fraction = "0"] = clean.split(".");
  const parts = main.split(":").map(Number);
  let seconds = 0;
  if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else seconds = parts[0] ?? 0;
  const ms = Number(fraction.padEnd(3, "0").slice(0, 3)) / 1e3;
  return seconds + ms;
}
function parseVtt(payload) {
  return parseCueBlock(payload);
}
function parseSrt(payload) {
  return parseCueBlock(payload);
}
function parsePlainTranscript(payload) {
  const trimmed = payload.trim();
  if (!trimmed) return { segments: [], estimated: false };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const segments2 = parseJson3(trimmed);
      if (segments2.length) return { segments: segments2, estimated: false };
    } catch {
    }
  }
  if (/<timedtext|<transcript|<text\b|<p\b/i.test(trimmed)) {
    const segments2 = parseTimedTextXml(trimmed);
    if (segments2.length) return { segments: segments2, estimated: false };
  }
  if (/WEBVTT/i.test(trimmed) || /-->/.test(trimmed) && /\d{1,2}:\d{2}[.,]\d{1,3}/.test(trimmed)) {
    const vtt = parseVtt(trimmed);
    if (vtt.length) return { segments: vtt, estimated: false };
    const srt = parseSrt(trimmed);
    if (srt.length) return { segments: srt, estimated: false };
  }
  const lines = trimmed.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const segments = lines.map((line, index) => createSegment(index, index * 4, 4, line));
  return { segments, estimated: true };
}
function parseTranscriptPayload(payload) {
  return parsePlainTranscript(payload).segments;
}

// ../shared/src/youtube/url.ts
function canonicalWatchUrl(videoId, seconds) {
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", videoId);
  if (seconds !== void 0 && Number.isFinite(seconds) && seconds > 0) {
    url.searchParams.set("t", `${Math.floor(seconds)}s`);
  }
  return url.toString();
}
function thumbnailUrl(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// ../shared/src/youtube/fetch-transcript.ts
var INVIDIOUS_INSTANCES = ["https://inv.nadeko.net"];
function pickCaptionTrack(tracks, preferred) {
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
async function fetchYouTubeTranscript(videoId, options = {}) {
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
      timestampsEstimated: false
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
async function fetchDirect(videoId, preferred, options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const playerUrl = rewriteYouTubeUrl(
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    options.youtubeProxyPrefix
  );
  let response;
  try {
    response = await fetchImpl(playerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", hl: "en" } },
        videoId
      }),
      signal: options.signal
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
  const player = await response.json();
  const tracks = (player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).filter((track) => track.baseUrl && track.languageCode).map((track) => ({
    baseUrl: track.baseUrl,
    languageCode: track.languageCode,
    kind: track.kind
  }));
  if (tracks.length === 0) {
    throw new StudioError("no-captions", "This video does not expose captions.");
  }
  const selected = pickCaptionTrack(tracks, preferred);
  if (!selected) {
    throw new StudioError("unsupported-language", "No usable caption language was found.");
  }
  const captionUrl = rewriteYouTubeUrl(selected.baseUrl, options.youtubeProxyPrefix);
  let captionResponse;
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
async function fetchInvidious(videoId, preferred, fetchImpl, signal) {
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const listResponse = await fetchImpl(`${base}/api/v1/captions/${videoId}`, { signal });
      if (!listResponse.ok) continue;
      const payload = await listResponse.json();
      const tracks = (payload.captions ?? []).filter((track) => track.url && track.languageCode).map((track) => ({
        baseUrl: track.url,
        languageCode: track.languageCode
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
async function fetchMetadata(videoId, fetchImpl, signal) {
  const fallback = {
    title: "YouTube video",
    author: "",
    thumbnailUrl: thumbnailUrl(videoId)
  };
  try {
    const watch = canonicalWatchUrl(videoId);
    const response = await fetchImpl(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`,
      { signal }
    );
    if (!response.ok) return fallback;
    const data = await response.json();
    return {
      title: data.title?.trim() || fallback.title,
      author: data.author_name?.trim() || "",
      thumbnailUrl: data.thumbnail_url || fallback.thumbnailUrl
    };
  } catch {
    return fallback;
  }
}
function rewriteYouTubeUrl(url, proxyPrefix) {
  if (!proxyPrefix) return url;
  const parsed = new URL(url, "https://www.youtube.com");
  const prefix = proxyPrefix.replace(/\/$/, "");
  return `${prefix}${parsed.pathname}${parsed.search}`;
}
function isFetchFailure(error) {
  return error instanceof TypeError || error instanceof StudioError && error.code === "cors-blocked";
}

// src/background.ts
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => void 0);
});
chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== void 0) void chrome.sidePanel.open({ tabId: tab.id }).catch(() => void 0);
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "open-panel" && sender.tab?.id !== void 0) {
    void chrome.sidePanel.open({ tabId: sender.tab.id }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "permission" }));
    return true;
  }
  return void 0;
});
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "fetch-transcript" || typeof message.videoId !== "string") return void 0;
  const languages = Array.isArray(message.languages) ? message.languages.filter((item) => typeof item === "string") : ["en"];
  void fetchYouTubeTranscript(message.videoId, { preferredLanguages: languages, browserPage: false }).then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "failed" }));
  return true;
});
