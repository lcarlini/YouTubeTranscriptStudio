import { describe, expect, it } from "vitest";
import { EXTENSION_ID } from "../identity";
import { isCaptionParentOrigin, transcriptFromCaptionResult } from "./caption-frame";
import { readCaptionXml } from "./read-caption-xml";

describe("caption frame", () => {
  it("accepts the published site, local pages, and this extension", () => {
    expect(isCaptionParentOrigin("https://lcarlini.github.io", EXTENSION_ID)).toBe(true);
    expect(isCaptionParentOrigin("http://localhost:5173", EXTENSION_ID)).toBe(true);
    expect(isCaptionParentOrigin("http://127.0.0.1:4173", EXTENSION_ID)).toBe(true);
    expect(isCaptionParentOrigin(`chrome-extension://${EXTENSION_ID}`, EXTENSION_ID)).toBe(true);
  });

  it("rejects other parents", () => {
    expect(isCaptionParentOrigin("https://example.com", EXTENSION_ID)).toBe(false);
    expect(isCaptionParentOrigin("https://www.youtube.com", EXTENSION_ID)).toBe(false);
    expect(isCaptionParentOrigin("null", EXTENSION_ID)).toBe(false);
  });

  it("turns a caption payload into transcript segments", () => {
    const transcript = transcriptFromCaptionResult("jNQXAC9IVRw", {
      ok: true,
      xml: `<timedtext><p t="1000" d="2000">Hello zoo</p></timedtext>`,
      languageCode: "en",
      title: "Me at the zoo",
      author: "jawed",
    });
    expect(transcript.captionLanguage).toBe("en");
    expect(transcript.segments[0]?.text).toBe("Hello zoo");
    expect(transcript.segments[0]?.start).toBe(1);
  });

  it("reads the preferred manual caption track", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("youtubei")) {
        return new Response(JSON.stringify({
          videoDetails: { title: "Me at the zoo", author: "jawed" },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                { baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr", languageCode: "en", kind: "asr" },
                { baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en", languageCode: "en" },
              ],
            },
          },
        }));
      }
      if (url.includes("kind=asr")) return new Response("<timedtext></timedtext>");
      return new Response(`<timedtext><p t="0" d="1000">Manual line</p></timedtext>`);
    }) as typeof fetch;
    try {
      const result = await readCaptionXml("jNQXAC9IVRw", ["en"]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.xml).toContain("Manual line");
    } finally {
      globalThis.fetch = original;
    }
  });
});
