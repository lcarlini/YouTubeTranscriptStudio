const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

const HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
]);

export function parseYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (VIDEO_ID.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (!HOSTS.has(host)) return null;

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return VIDEO_ID.test(id) ? id : null;
  }

  if (url.pathname === "/watch" || url.pathname === "/watch/") {
    const id = url.searchParams.get("v") ?? "";
    return VIDEO_ID.test(id) ? id : null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && ["embed", "shorts", "live", "v"].includes(parts[0])) {
    return VIDEO_ID.test(parts[1]) ? parts[1] : null;
  }

  return null;
}

export function canonicalWatchUrl(videoId: string, seconds?: number): string {
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", videoId);
  if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
    url.searchParams.set("t", `${Math.floor(seconds)}s`);
  }
  return url.toString();
}

export function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}
