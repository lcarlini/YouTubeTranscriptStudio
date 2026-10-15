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

// ../shared/src/youtube/caption-frame.ts
function transcriptFromCaptionResult(videoId, result) {
  if (!result.ok) {
    throw new StudioError(
      result.code,
      result.code === "no-captions" ? "This video does not expose captions." : "The transcript request failed."
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
    timestampsEstimated: false
  };
}

// ../shared/src/youtube/read-caption-xml.ts
async function readCaptionXml(videoId, languages) {
  const notes = [];
  const base = (code) => (code ?? "").toLowerCase().split(/[-_.]/)[0] ?? "";
  const originalLanguage = (player) => {
    const audio = (player?.streamingData?.adaptiveFormats ?? []).map((format) => format.audioTrack).filter((track) => Boolean(track?.id));
    const original = audio.find((track) => /original/i.test(track.displayName ?? "")) ?? audio.find((track) => !track.isAutoDubbed && track.audioIsDefault) ?? audio.find((track) => !track.isAutoDubbed);
    if (original) return base(original.id);
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const asr = [...new Set(tracks.filter((track) => track.kind === "asr").map((track) => base(track.languageCode)))];
    return asr.length === 1 ? asr[0] ?? "" : "";
  };
  const orderTracks = (player) => {
    const tracks = (player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).filter(
      (track) => Boolean(track.baseUrl && track.languageCode)
    );
    const original = originalLanguage(player);
    const preferred = (Array.isArray(languages) ? languages : ["en"]).map((language) => language.toLowerCase());
    const wanted = [...new Set([original, ...preferred.map(base)].filter(Boolean))];
    const ordered = [];
    const add = (track) => {
      if (track && !ordered.includes(track)) ordered.push(track);
    };
    for (const language of wanted) {
      add(tracks.find((track) => base(track.languageCode) === language && track.kind !== "asr"));
      add(tracks.find((track) => base(track.languageCode) === language));
    }
    tracks.forEach(add);
    return ordered;
  };
  const download = async (player, label) => {
    const tracks = orderTracks(player);
    if (tracks.length === 0) {
      notes.push(`${label}:no-tracks`);
      return null;
    }
    for (const track of tracks.slice(0, 4)) {
      try {
        const response = await fetch(track.baseUrl, { credentials: "omit" });
        if (!response.ok) {
          notes.push(`${label}:${track.languageCode}:http ${response.status}`);
          continue;
        }
        const xml = await response.text();
        if (!xml.trim()) {
          notes.push(`${label}:${track.languageCode}:empty`);
          continue;
        }
        return {
          ok: true,
          xml,
          languageCode: track.languageCode,
          title: player?.videoDetails?.title?.trim() || "YouTube video",
          author: player?.videoDetails?.author?.trim() || ""
        };
      } catch (error) {
        notes.push(`${label}:${track.languageCode}:${error instanceof Error ? error.message : "throw"}`);
      }
    }
    return null;
  };
  let sawTracks = false;
  try {
    const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en" } },
        videoId
      })
    });
    if (response.ok) {
      const player = await response.json();
      sawTracks ||= Boolean(player.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length);
      const result = await download(player, "android");
      if (result) return result;
    } else {
      notes.push(`android:http ${response.status}`);
    }
  } catch (error) {
    notes.push(`android:${error instanceof Error ? error.message : "throw"}`);
  }
  if (typeof document !== "undefined") {
    const deadline = Date.now() + 4e3;
    while (Date.now() < deadline) {
      const node = document.getElementById("movie_player");
      let player = null;
      try {
        player = node?.getPlayerResponse?.() ?? null;
      } catch {
        player = null;
      }
      if (player?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) {
        sawTracks = true;
        const result = await download(player, "web");
        if (result) return result;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return { ok: false, code: sawTracks ? "network" : "no-captions", detail: notes.join("; ") };
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
  if (message?.type === "caption-in-frame" && sender.tab?.id !== void 0 && typeof message.videoId === "string") {
    const languages = Array.isArray(message.languages) ? message.languages.filter((item) => typeof item === "string") : ["en"];
    void readCaptionsInFrame(sender.tab.id, sender.frameId, message.videoId, languages).then((result) => sendResponse(result)).catch((error) => sendResponse({ ok: false, code: "network", detail: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "fetch-transcript" && typeof message.videoId === "string") {
    respondWithTranscript(message, sendResponse);
    return true;
  }
  return void 0;
});
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ping") {
    sendResponse({ ok: true });
    return void 0;
  }
  if (message?.type !== "fetch-transcript" || typeof message.videoId !== "string") return void 0;
  respondWithTranscript(message, sendResponse);
  return true;
});
function respondWithTranscript(message, sendResponse) {
  const languages = Array.isArray(message.languages) ? message.languages.filter((item) => typeof item === "string") : ["en"];
  void fetchTranscriptFromYouTubeFrame(message.videoId, languages).then((data) => sendResponse({ ok: true, data })).catch((error) => {
    const code = error instanceof StudioError ? error.code : "network";
    sendResponse({ ok: false, code, error: error instanceof Error ? error.message : "failed" });
  });
}
async function readCaptionsInFrame(tabId, frameId, videoId, languages) {
  const injected = await chrome.scripting.executeScript({
    target: frameId === void 0 ? { tabId } : { tabId, frameIds: [frameId] },
    world: "MAIN",
    func: readCaptionXml,
    args: [videoId, languages]
  });
  return injected[0]?.result ?? { ok: false, code: "network" };
}
async function fetchTranscriptFromYouTubeFrame(videoId, languages) {
  const created = await openYouTubePopup(`https://www.youtube.com/embed/${encodeURIComponent(videoId)}?enablejsapi=1`);
  const tabId = created.tabs?.[0]?.id;
  if (created.id === void 0 || tabId === void 0) {
    throw new StudioError("network", "The transcript request failed.");
  }
  try {
    await waitForTabComplete(tabId);
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: readCaptionXml,
      args: [videoId, languages]
    });
    const payload = injected[0]?.result;
    if (!payload) throw new StudioError("network", "The transcript request failed.");
    if (!payload.ok) {
      throw new StudioError(
        payload.code === "no-captions" ? "no-captions" : "network",
        payload.detail || "The transcript request failed."
      );
    }
    return transcriptFromCaptionResult(videoId, payload);
  } finally {
    await chrome.windows.remove(created.id).catch(() => void 0);
  }
}
async function openYouTubePopup(url) {
  const created = await chrome.windows.create({ url, type: "popup", focused: false, width: 480, height: 320 });
  if (!created) throw new StudioError("network", "The transcript request failed.");
  return created;
}
function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const timeout = setTimeout(() => finish(new Error("The YouTube frame did not load.")), 2e4);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch(() => void 0);
  });
}
