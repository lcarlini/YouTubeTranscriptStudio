import { describe, expect, it } from "vitest";
import { canonicalWatchUrl, parseYouTubeVideoId } from "./url";

describe("parseYouTubeVideoId", () => {
  it("accepts watch, short, embed, shorts, and bare ids", () => {
    expect(parseYouTubeVideoId("https://www.youtube.com/watch?v=jNQXAC9IVRw")).toBe("jNQXAC9IVRw");
    expect(parseYouTubeVideoId("https://youtu.be/jNQXAC9IVRw?t=12")).toBe("jNQXAC9IVRw");
    expect(parseYouTubeVideoId("https://www.youtube.com/embed/jNQXAC9IVRw")).toBe("jNQXAC9IVRw");
    expect(parseYouTubeVideoId("https://www.youtube.com/shorts/jNQXAC9IVRw")).toBe("jNQXAC9IVRw");
    expect(parseYouTubeVideoId("jNQXAC9IVRw")).toBe("jNQXAC9IVRw");
  });

  it("rejects empty, foreign, and malformed values", () => {
    expect(parseYouTubeVideoId("")).toBeNull();
    expect(parseYouTubeVideoId("https://vimeo.com/123")).toBeNull();
    expect(parseYouTubeVideoId("https://youtube.com/watch?v=short")).toBeNull();
    expect(parseYouTubeVideoId("not a url")).toBeNull();
  });

  it("builds a timestamped watch URL", () => {
    expect(canonicalWatchUrl("jNQXAC9IVRw", 65)).toBe("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=65s");
  });
});
