import type { TranscriptSegment } from "../types";

export function decodeCaptionText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

export function createSegment(
  index: number,
  start: number,
  duration: number,
  text: string,
): TranscriptSegment {
  const clean = decodeCaptionText(text);
  return {
    id: `s${index}-${Math.round(Math.max(0, start) * 1000)}`,
    start: roundSeconds(start),
    duration: roundSeconds(Math.max(0, duration)),
    text: clean,
  };
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function readAttr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

export function parseTimedTextXml(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const pattern = /<(p|text)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    const tag = match[1].toLowerCase();
    const attrs = match[2] ?? "";
    const inner = match[3] ?? "";
    let start = 0;
    let duration = 0;
    if (tag === "p") {
      start = Number(readAttr(attrs, "t") ?? "0") / 1000;
      duration = Number(readAttr(attrs, "d") ?? "0") / 1000;
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

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
}

export function parseJson3(payload: string): TranscriptSegment[] {
  const data = JSON.parse(payload) as { events?: Json3Event[] };
  const segments: TranscriptSegment[] = [];
  for (const event of data.events ?? []) {
    const text = decodeCaptionText((event.segs ?? []).map((seg) => seg.utf8 ?? "").join(""));
    if (!text) continue;
    const start = (event.tStartMs ?? 0) / 1000;
    const duration = (event.dDurationMs ?? 0) / 1000;
    segments.push(createSegment(segments.length, start, duration, text));
  }
  return segments;
}

function parseCueBlock(body: string): TranscriptSegment[] {
  const normalized = body.replace(/\r/g, "");
  const lines = normalized.split("\n");
  const segments: TranscriptSegment[] = [];
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
    const textLines: string[] = [];
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

function parseFlexibleClock(value: string): number {
  const clean = value.trim().replace(",", ".");
  const [main, fraction = "0"] = clean.split(".");
  const parts = main.split(":").map(Number);
  let seconds = 0;
  if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else seconds = parts[0] ?? 0;
  const ms = Number(fraction.padEnd(3, "0").slice(0, 3)) / 1000;
  return seconds + ms;
}

export function parseVtt(payload: string): TranscriptSegment[] {
  return parseCueBlock(payload);
}

export function parseSrt(payload: string): TranscriptSegment[] {
  return parseCueBlock(payload);
}

export function parsePlainTranscript(payload: string): { segments: TranscriptSegment[]; estimated: boolean } {
  const trimmed = payload.trim();
  if (!trimmed) return { segments: [], estimated: false };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const segments = parseJson3(trimmed);
      if (segments.length) return { segments, estimated: false };
    } catch {
      // Fall through to the other caption formats.
    }
  }

  if (/<timedtext|<transcript|<text\b|<p\b/i.test(trimmed)) {
    const segments = parseTimedTextXml(trimmed);
    if (segments.length) return { segments, estimated: false };
  }

  if (/WEBVTT/i.test(trimmed) || /-->/.test(trimmed) && /\d{1,2}:\d{2}[.,]\d{1,3}/.test(trimmed)) {
    const vtt = parseVtt(trimmed);
    if (vtt.length) return { segments: vtt, estimated: false };
    const srt = parseSrt(trimmed);
    if (srt.length) return { segments: srt, estimated: false };
  }

  const lines = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const segments = lines.map((line, index) => createSegment(index, index * 4, 4, line));
  return { segments, estimated: true };
}

export function parseTranscriptPayload(payload: string): TranscriptSegment[] {
  return parsePlainTranscript(payload).segments;
}
