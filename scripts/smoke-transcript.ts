import { fetchYouTubeTranscript } from "../shared/src/youtube/fetch-transcript.ts";

const video = await fetchYouTubeTranscript("jNQXAC9IVRw");
console.log(JSON.stringify({
  title: video.title,
  language: video.captionLanguage,
  count: video.segments.length,
  first: video.segments[0]?.text ?? "",
}));
