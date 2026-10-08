import type { TranscriptSegment } from "../types";
import { formatTimestamp } from "../transcript/time";

export interface TranscriptChunk {
  index: number;
  segments: TranscriptSegment[];
  text: string;
}

export function groupSegments(segments: TranscriptSegment[], maxChars: number): TranscriptSegment[][] {
  const groups: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];
  let size = 0;
  for (const segment of segments) {
    const length = segment.text.length + 12;
    if (current.length > 0 && size + length > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(segment);
    size += length;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export function sampleEvenly<T>(items: T[], count: number): T[] {
  if (count <= 0) return [];
  if (items.length <= count) return [...items];
  const picked: T[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    const at = Math.round((index * (items.length - 1)) / (count - 1));
    if (seen.has(at)) continue;
    seen.add(at);
    picked.push(items[at]);
  }
  return picked;
}

export function buildProcessingChunks(
  segments: TranscriptSegment[],
  maxChunks = 4,
  chunkChars = 1400,
): TranscriptChunk[] {
  const groups = groupSegments(segments, chunkChars);
  const picked = sampleEvenly(groups, Math.min(maxChunks, groups.length));
  return picked.map((chunkSegments, index) => ({
    index,
    segments: chunkSegments,
    text: chunkSegments.map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`).join("\n"),
  }));
}

export function condenseTranscript(segments: TranscriptSegment[], maxChars: number): string {
  const lines = segments.map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text.replace(/\s+/g, " ").trim()}`);
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;
  const step = Math.max(1, Math.ceil(lines.length / Math.max(1, Math.floor(maxChars / 90))));
  const sampled: string[] = [];
  for (let index = 0; index < lines.length; index += step) {
    sampled.push(lines[index]);
    if (sampled.join("\n").length >= maxChars) break;
  }
  return sampled.join("\n").slice(0, maxChars);
}
