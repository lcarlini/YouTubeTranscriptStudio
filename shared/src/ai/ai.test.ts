import { describe, expect, it } from "vitest";
import { createSegment } from "../transcript/parse";
import { buildProcessingChunks, condenseTranscript } from "./chunk";
import { mergeInsights, parseChatResponse, parseInsights, parseStudyPack } from "./parse-model";
import { retrieveSegments } from "./retrieve";

const segments = Array.from({ length: 12 }, (_, index) =>
  createSegment(index, index * 10, 4, index === 3 ? "The trunk chapter explains elephants" : `Segment number ${index} about the zoo`),
);

describe("chunking and retrieval", () => {
  it("covers the start and end of a long transcript", () => {
    const chunks = buildProcessingChunks(segments, 3, 40);
    expect(chunks.length).toBeLessThanOrEqual(3);
    expect(chunks[0]?.text).toContain("Segment number 0");
    expect(chunks.at(-1)?.text).toContain("Segment number 11");
  });

  it("condenses without dropping the opening line when the text is short", () => {
    expect(condenseTranscript(segments.slice(0, 2), 500)).toContain("[0:00]");
  });

  it("retrieves the segment that contains the query terms", () => {
    const found = retrieveSegments(segments, "What does the trunk chapter say?");
    expect(found.some((segment) => segment.text.includes("trunk"))).toBe(true);
  });
});

describe("model output parsers", () => {
  it("requires citations and refuses unsupported answers", () => {
    expect(parseChatResponse("INSUFFICIENT").insufficient).toBe(true);
    expect(parseChatResponse("ANSWER:\nThey are large.\n").insufficient).toBe(true);
    const parsed = parseChatResponse('ANSWER:\nTrunks are long.\nEVIDENCE:\n- [0:12] "really long trunks"');
    expect(parsed.insufficient).toBe(false);
    expect(parsed.citations[0]?.start).toBe(12);
    expect(parsed.answer).toContain("Trunks are long.");
  });

  it("parses and merges insight sections", () => {
    const first = parseInsights(`TLDR: A zoo visit.\nTAKEAWAYS:\n- Trunks are long\nCHAPTERS:\n- [0:01] Arrival\nTERMS:\n- Trunk: a long nose\nACTIONS:\n- None\nQUESTIONS:\n- Why trunks?`);
    const second = parseInsights(`TLDR: More about elephants.\nTAKEAWAYS:\n- Trunks are long\n- They live in groups\nCHAPTERS:\n- [1:20] Groups\nTERMS:\n- Herd: a group\nACTIONS:\n- Rewatch\nQUESTIONS:\n- Where do they live?`);
    expect(first?.chapters[0]?.title).toBe("Arrival");
    const merged = mergeInsights([first!, second!]);
    expect(merged.takeaways).toContain("They live in groups");
    expect(merged.chapters.map((chapter) => chapter.title)).toEqual(["Arrival", "Groups"]);
    expect(merged.glossary).toHaveLength(2);
  });

  it("parses flashcards and quiz answers", () => {
    const pack = parseStudyPack(`FLASHCARDS:\nQ: What is long?\nA: The trunk\nQUIZ:\nQ: Where are they?\nA) Zoo\nB) Office\nC) Kitchen\nD) Garage\nANSWER: A\nWHY: The speaker is at the zoo.`);
    expect(pack?.flashcards[0]?.back).toBe("The trunk");
    expect(pack?.quiz[0]?.answerIndex).toBe(0);
    expect(pack?.quiz[0]?.choices).toHaveLength(4);
  });
});
