import type { TranscriptSegment } from "../types";

export interface TranscriptMatch {
  segmentId: string;
  startOffset: number;
  endOffset: number;
}

export function findMatches(segments: TranscriptSegment[], query: string): TranscriptMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: TranscriptMatch[] = [];
  for (const segment of segments) {
    const haystack = segment.text.toLowerCase();
    let from = 0;
    while (from <= haystack.length) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      matches.push({
        segmentId: segment.id,
        startOffset: at,
        endOffset: at + needle.length,
      });
      from = at + Math.max(needle.length, 1);
    }
  }
  return matches;
}

export function rangesForSegment(matches: TranscriptMatch[], segmentId: string): Array<[number, number]> {
  return matches
    .filter((match) => match.segmentId === segmentId)
    .map((match) => [match.startOffset, match.endOffset] as [number, number]);
}

/**
 * Groups every match by its segment in one pass. Use this instead of calling
 * rangesForSegment once per segment, which scans all matches each time.
 */
export function groupMatchesBySegment(matches: TranscriptMatch[]): Map<string, Array<[number, number]>> {
  const groups = new Map<string, Array<[number, number]>>();
  for (const match of matches) {
    const ranges = groups.get(match.segmentId);
    if (ranges) ranges.push([match.startOffset, match.endOffset]);
    else groups.set(match.segmentId, [[match.startOffset, match.endOffset]]);
  }
  return groups;
}
