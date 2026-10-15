import { describe, expect, it } from "vitest";
import { transcriptParts } from "./chunk";
import { cleanSummaryText } from "./parse-model";
import type { TranscriptSegment } from "../types";

function segments(count: number): TranscriptSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `s${index}`,
    start: index * 4,
    duration: 4,
    text: `Line number ${index} about the game and its story.`,
  }));
}

describe("transcriptParts", () => {
  it("covers every segment of a long video, not a sample", () => {
    const all = segments(900);
    const parts = transcriptParts(all, 4500);
    const covered = parts.flatMap((part) => part.segments.map((segment) => segment.id));
    expect(parts.length).toBeGreaterThan(5);
    expect(covered).toEqual(all.map((segment) => segment.id));
    expect(parts.every((part) => part.text.length <= 4500 + 200)).toBe(true);
  });

  it("prefixes every line with its timestamp", () => {
    const [first] = transcriptParts(segments(2));
    expect(first.text.split("\n")[0]).toMatch(/^\[0:00\] Line number 0/);
  });
});

describe("cleanSummaryText", () => {
  it("removes labels, fences, quotes, and extra whitespace the model adds", () => {
    expect(cleanSummaryText("Summary:  \"The speaker   reviews the game.\"")).toBe("The speaker reviews the game.");
    expect(cleanSummaryText("The game returns. The game returns. New boss fight.")).toBe("The game returns. New boss fight.");
    expect(cleanSummaryText("Aqui está a sinopse do vídeo: O jogo volta com chefes novos.")).toBe("O jogo volta com chefes novos.");
    expect(cleanSummaryText("```text\nTL;DR: Short overview.\n```")).toBe("Short overview.");
  });

  it("keeps plain prose unchanged", () => {
    expect(cleanSummaryText("Two sentences. Here they are.")).toBe("Two sentences. Here they are.");
  });
});
