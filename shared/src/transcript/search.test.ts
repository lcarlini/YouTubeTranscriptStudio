import { describe, expect, it } from "vitest";
import { findMatches } from "./search";
import { createSegment } from "./parse";

describe("findMatches", () => {
  const segments = [
    createSegment(0, 1, 2, "Elephants have long trunks"),
    createSegment(1, 4, 2, "Really long trunks"),
  ];

  it("counts every case-insensitive match", () => {
    const matches = findMatches(segments, "long");
    expect(matches).toHaveLength(2);
    expect(matches[0]?.segmentId).toBe(segments[0]?.id);
  });

  it("returns nothing for a blank query", () => {
    expect(findMatches(segments, "  ")).toEqual([]);
  });
});
