import type { TranscriptSegment } from "../types";

function termsOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 2);
}

function scoreText(text: string, terms: string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let from = 0;
    while (from < haystack.length) {
      const at = haystack.indexOf(term, from);
      if (at < 0) break;
      score += 1;
      from = at + term.length;
    }
  }
  return score;
}

export function retrieveSegments(
  segments: TranscriptSegment[],
  query: string,
  limit = 8,
): TranscriptSegment[] {
  if (segments.length === 0) return [];
  const terms = termsOf(query);
  if (terms.length === 0) return segments.slice(0, Math.min(limit, segments.length));

  const scored = segments.map((segment, index) => ({
    index,
    score: scoreText(segment.text, terms),
  }));
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const positive = ranked.filter((item) => item.score > 0).slice(0, limit);
  const chosen = positive.length > 0 ? positive : ranked.slice(0, Math.min(4, ranked.length));
  const indexes = new Set<number>();
  for (const item of chosen) {
    indexes.add(item.index);
    if (item.index > 0) indexes.add(item.index - 1);
    if (item.index + 1 < segments.length) indexes.add(item.index + 1);
  }
  return [...indexes]
    .sort((a, b) => a - b)
    .slice(0, limit + 4)
    .map((index) => segments[index]);
}

export function nearestSegment(
  segments: TranscriptSegment[],
  start: number,
): TranscriptSegment | undefined {
  let best: TranscriptSegment | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const segment of segments) {
    const delta = Math.abs(segment.start - start);
    if (delta < bestDelta) {
      best = segment;
      bestDelta = delta;
    }
  }
  return best;
}
