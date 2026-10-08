import { describe, expect, it } from "vitest";
import { fetchYouTubeTranscript, pickCaptionTrack, rewriteYouTubeUrl } from "./fetch-transcript";

const player = {
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=en", languageCode: "en" },
        { baseUrl: "https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=de", languageCode: "de" },
      ],
    },
  },
};

describe("fetchYouTubeTranscript", () => {
  it("rewrites YouTube hosts through the dev proxy", () => {
    expect(rewriteYouTubeUrl("https://www.youtube.com/api/timedtext?v=abc&lang=en", "/yt-proxy")).toBe(
      "/yt-proxy/api/timedtext?v=abc&lang=en",
    );
  });

  it("prefers a manual track in the requested language", () => {
    const track = pickCaptionTrack(
      [
        { baseUrl: "https://example.test/a", languageCode: "en", kind: "asr" },
        { baseUrl: "https://example.test/b", languageCode: "en" },
      ],
      ["en"],
    );
    expect(track?.baseUrl).toBe("https://example.test/b");
  });

  it("rejects tracks without a language code as unsupported", () => {
    expect(pickCaptionTrack([{ baseUrl: "https://example.test/a", languageCode: "" }], ["en"])).toBeNull();
  });

  it("parses a mocked player response into segments", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oembed")) {
        return new Response(JSON.stringify({ title: "Me at the zoo", author_name: "jawed", thumbnail_url: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg" }), { status: 200 });
      }
      if (url.includes("youtubei")) return new Response(JSON.stringify(player), { status: 200 });
      return new Response(`<timedtext><p t="1000" d="2000">Hello zoo</p></timedtext>`, { status: 200 });
    }) as typeof fetch;

    const result = await fetchYouTubeTranscript("jNQXAC9IVRw", { fetchImpl, preferredLanguages: ["en"] });
    expect(result.title).toBe("Me at the zoo");
    expect(result.captionLanguage).toBe("en");
    expect(result.segments[0]?.text).toBe("Hello zoo");
    expect(result.segments[0]?.start).toBe(1);
  });

  it("reports a browser CORS failure when YouTube cannot be read", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oembed")) return new Response(JSON.stringify({ title: "Zoo" }), { status: 200 });
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    await expect(fetchYouTubeTranscript("jNQXAC9IVRw", {
      fetchImpl,
      browserPage: true,
      preferredLanguages: ["en"],
    })).rejects.toMatchObject({ code: "cors-blocked" });
  });

  it("reports videos without captions", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oembed")) return new Response(JSON.stringify({ title: "Zoo" }), { status: 200 });
      if (url.includes("youtubei")) return new Response(JSON.stringify({ captions: {} }), { status: 200 });
      return new Response("[]", { status: 404 });
    }) as typeof fetch;

    await expect(fetchYouTubeTranscript("jNQXAC9IVRw", { fetchImpl })).rejects.toMatchObject({ code: "no-captions" });
  });
});
