import { describe, expect, it } from "vitest";
import { parseJson3, parsePlainTranscript, parseSrt, parseTimedTextXml, parseVtt } from "./parse";

const XML = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">
<body>
<p t="1200" d="2160">All right, so here we are</p>
<p t="5318" d="2656">the cool thing about these guys</p>
</body>
</timedtext>`;

describe("caption parsers", () => {
  it("parses YouTube srv3 captions and keeps timestamps", () => {
    const segments = parseTimedTextXml(XML);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.start).toBe(1.2);
    expect(segments[0]?.duration).toBe(2.16);
    expect(segments[0]?.text).toBe("All right, so here we are");
  });

  it("decodes classic timedtext entities", () => {
    const segments = parseTimedTextXml(`<transcript><text start="1.5" dur="2.0">that&#39;s cool</text></transcript>`);
    expect(segments[0]?.text).toBe("that's cool");
    expect(segments[0]?.start).toBe(1.5);
  });

  it("parses json3 events", () => {
    const segments = parseJson3(JSON.stringify({
      events: [{ tStartMs: 900, dDurationMs: 1200, segs: [{ utf8: "Hello " }, { utf8: "there" }] }],
    }));
    expect(segments[0]?.text).toBe("Hello there");
    expect(segments[0]?.start).toBe(0.9);
  });

  it("parses WebVTT and SRT cues", () => {
    const vtt = parseVtt("WEBVTT\n\n00:00:01.200 --> 00:00:03.000\nHello zoo\n");
    const srt = parseSrt("1\n00:00:01,200 --> 00:00:03,000\nHello zoo\n");
    expect(vtt[0]?.start).toBe(1.2);
    expect(srt[0]?.text).toBe("Hello zoo");
    expect(srt[0]?.duration).toBeCloseTo(1.8);
  });

  it("estimates timestamps for plain text", () => {
    const parsed = parsePlainTranscript("First line\n\nSecond line");
    expect(parsed.estimated).toBe(true);
    expect(parsed.segments[1]?.start).toBe(4);
  });
});
