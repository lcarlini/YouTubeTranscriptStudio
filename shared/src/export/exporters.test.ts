import { describe, expect, it } from "vitest";
import type { ChatMessage, Insights, StudyPack, TranscriptSegment } from "../types";
import { createSegment } from "../transcript/parse";
import {
  exportAnkiCsv,
  exportMarkdown,
  exportSrt,
  exportTxt,
  exportVtt,
} from "./exporters";

const segments: TranscriptSegment[] = [createSegment(0, 1.2, 2, "Hello elephants")];
const insights: Insights = {
  tldr: "A short visit to the elephants.",
  takeaways: ["Trunks are long"],
  chapters: [{ start: 1.2, title: "Arrival" }],
  glossary: [{ term: "Trunk", definition: "A long nose" }],
  actionItems: ["Watch again"],
  followUps: ["Why are trunks long?"],
};
const study: StudyPack = {
  flashcards: [{ id: "c1", front: "What is long?", back: "The trunk" }],
  quiz: [],
};
const chat: ChatMessage[] = [{
  id: "m1",
  role: "assistant",
  content: "They mention trunks.",
  citations: [{ start: 1.2, end: 3.2, quote: "Hello elephants" }],
  insufficient: false,
  createdAt: 0,
}];

describe("exporters", () => {
  it("writes SRT, VTT, and TXT with timestamps", () => {
    expect(exportSrt(segments)).toContain("00:00:01,200 --> 00:00:03,200");
    expect(exportSrt(segments)).toContain("Hello elephants");
    expect(exportVtt(segments)).toContain("WEBVTT");
    expect(exportVtt(segments)).toContain("00:00:01.200 --> 00:00:03.200");
    expect(exportTxt("Zoo", "https://www.youtube.com/watch?v=jNQXAC9IVRw", segments)).toContain("[0:01] Hello elephants");
  });

  it("includes notes, glossary, flashcards, and optional chat in Markdown", () => {
    const markdown = exportMarkdown({
      title: "Me at the zoo",
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      segments,
      insights,
      study,
      chat,
    });
    expect(markdown).toContain("# Me at the zoo");
    expect(markdown).toContain("## TL;DR");
    expect(markdown).toContain("## Glossary");
    expect(markdown).toContain("**Trunk:**");
    expect(markdown).toContain("## Flashcards");
    expect(markdown).toContain("## Chat history");
    const withoutChat = exportMarkdown({
      title: "Me at the zoo",
      url: "https://youtu.be/jNQXAC9IVRw",
      segments,
      insights,
      study,
      chat: null,
    });
    expect(withoutChat).not.toContain("## Chat history");
  });

  it("escapes Anki CSV cells", () => {
    expect(exportAnkiCsv([{ id: "c", front: 'Say "hi"', back: "Line" }])).toContain('"Say ""hi"""');
  });
});
