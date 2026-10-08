import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearVideos, deleteVideo, listVideos, saveVideo } from "./history";
import type { VideoRecord } from "../types";

function record(videoId: string, processedAt: number): VideoRecord {
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: videoId,
    author: "Author",
    thumbnailUrl: "",
    captionLanguage: "en",
    processedAt,
    segments: [{ id: "s0", start: 0, duration: 1, text: "Hello" }],
    insights: null,
    study: null,
    chat: [],
    timestampsEstimated: false,
  };
}

describe("local history", () => {
  beforeEach(async () => {
    await clearVideos();
  });

  it("stores, reopens, deletes, and clears videos in IndexedDB", async () => {
    await saveVideo(record("aaaaaaaaaaa", 10));
    await saveVideo(record("bbbbbbbbbbb", 20));
    const listed = await listVideos();
    expect(listed.map((item) => item.videoId)).toEqual(["bbbbbbbbbbb", "aaaaaaaaaaa"]);
    await deleteVideo("bbbbbbbbbbb");
    expect((await listVideos()).map((item) => item.videoId)).toEqual(["aaaaaaaaaaa"]);
    await clearVideos();
    expect(await listVideos()).toEqual([]);
  });
});
