import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../types";
import { condenseTranscript } from "./chunk";

function segments(count: number, text: (index: number) => string): TranscriptSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `s${index}`,
    start: index * 5,
    duration: 5,
    text: text(index),
  })) as TranscriptSegment[];
}

describe("condenseTranscript", () => {
  it("returns the whole transcript when it already fits", () => {
    const result = condenseTranscript(segments(3, (i) => `line ${i}`), 10_000);
    expect(result.split("\n")).toHaveLength(3);
    expect(result).toContain("line 2");
  });

  it("stays within the limit and keeps only whole lines when it has to sample", () => {
    const result = condenseTranscript(segments(2000, (i) => `words ${i} ${"x".repeat(60)}`), 5000);
    expect(result.length).toBeLessThanOrEqual(5000);
    for (const line of result.split("\n")) {
      expect(line).toMatch(/^\[[\d:]+\] words \d+ x+$/);
    }
  });

  it("spreads the sample over the whole video, from start to end", () => {
    const result = condenseTranscript(segments(2000, (i) => `words ${i} ${"x".repeat(60)}`), 5000);
    expect(result).toContain("words 0 ");
    const last = result.split("\n").at(-1) ?? "";
    expect(Number(/words (\d+)/.exec(last)?.[1])).toBeGreaterThan(1000);
  });

  it("cuts a single over-long line so the result still fits", () => {
    const result = condenseTranscript([{ id: "a", start: 0, duration: 5, text: "y".repeat(500) }] as TranscriptSegment[], 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.length).toBeGreaterThan(0);
  });
});
