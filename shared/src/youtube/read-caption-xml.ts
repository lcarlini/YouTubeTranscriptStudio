export type CaptionXmlResult =
  | { ok: true; xml: string; languageCode: string; title: string; author: string }
  | { ok: false; code: "no-captions" | "network"; detail?: string };

interface CaptionTrackPayload {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

interface PlayerPayload {
  videoDetails?: { title?: string; author?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrackPayload[] } };
  streamingData?: {
    adaptiveFormats?: Array<{
      audioTrack?: { id?: string; displayName?: string; audioIsDefault?: boolean; isAutoDubbed?: boolean };
    }>;
  };
}

/**
 * Runs inside a youtube.com document. YouTube answers this player call for that
 * origin and withholds caption tracks from every other origin.
 *
 * Injected with chrome.scripting.executeScript, so it must stay self-contained:
 * no imports and no references to module-level values.
 *
 * Caption URLs from the web player need a proof-of-origin token and download as
 * an empty body, so the ANDROID client is asked first and the web player is only
 * a fallback.
 */
export async function readCaptionXml(videoId: string, languages: string[]): Promise<CaptionXmlResult> {
  const notes: string[] = [];
  const base = (code: string | undefined) => (code ?? "").toLowerCase().split(/[-_.]/)[0] ?? "";

  const originalLanguage = (player: PlayerPayload | null): string => {
    const audio = (player?.streamingData?.adaptiveFormats ?? [])
      .map((format) => format.audioTrack)
      .filter((track): track is NonNullable<typeof track> => Boolean(track?.id));
    const original =
      audio.find((track) => /original/i.test(track.displayName ?? "")) ??
      audio.find((track) => !track.isAutoDubbed && track.audioIsDefault) ??
      audio.find((track) => !track.isAutoDubbed);
    if (original) return base(original.id);
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const asr = [...new Set(tracks.filter((track) => track.kind === "asr").map((track) => base(track.languageCode)))];
    return asr.length === 1 ? (asr[0] ?? "") : "";
  };

  const orderTracks = (player: PlayerPayload | null): CaptionTrackPayload[] => {
    const tracks = (player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).filter(
      (track) => Boolean(track.baseUrl && track.languageCode),
    );
    const original = originalLanguage(player);
    const preferred = (Array.isArray(languages) ? languages : ["en"]).map((language) => language.toLowerCase());
    const wanted = [...new Set([original, ...preferred.map(base)].filter(Boolean))];
    const ordered: CaptionTrackPayload[] = [];
    const add = (track: CaptionTrackPayload | undefined) => {
      if (track && !ordered.includes(track)) ordered.push(track);
    };
    for (const language of wanted) {
      add(tracks.find((track) => base(track.languageCode) === language && track.kind !== "asr"));
      add(tracks.find((track) => base(track.languageCode) === language));
    }
    tracks.forEach(add);
    return ordered;
  };

  const download = async (player: PlayerPayload | null, label: string): Promise<CaptionXmlResult | null> => {
    const tracks = orderTracks(player);
    if (tracks.length === 0) {
      notes.push(`${label}:no-tracks`);
      return null;
    }
    for (const track of tracks.slice(0, 4)) {
      try {
        const response = await fetch(track.baseUrl as string, { credentials: "omit" });
        if (!response.ok) {
          notes.push(`${label}:${track.languageCode}:http ${response.status}`);
          continue;
        }
        const xml = await response.text();
        if (!xml.trim()) {
          notes.push(`${label}:${track.languageCode}:empty`);
          continue;
        }
        return {
          ok: true,
          xml,
          languageCode: track.languageCode as string,
          title: player?.videoDetails?.title?.trim() || "YouTube video",
          author: player?.videoDetails?.author?.trim() || "",
        };
      } catch (error) {
        notes.push(`${label}:${track.languageCode}:${error instanceof Error ? error.message : "throw"}`);
      }
    }
    return null;
  };

  let sawTracks = false;
  try {
    const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en" } },
        videoId,
      }),
    });
    if (response.ok) {
      const player = (await response.json()) as PlayerPayload;
      sawTracks ||= Boolean(player.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length);
      const result = await download(player, "android");
      if (result) return result;
    } else {
      notes.push(`android:http ${response.status}`);
    }
  } catch (error) {
    notes.push(`android:${error instanceof Error ? error.message : "throw"}`);
  }

  if (typeof document !== "undefined") {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const node = document.getElementById("movie_player") as { getPlayerResponse?: () => PlayerPayload } | null;
      let player: PlayerPayload | null = null;
      try {
        player = node?.getPlayerResponse?.() ?? null;
      } catch {
        player = null;
      }
      if (player?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) {
        sawTracks = true;
        const result = await download(player, "web");
        if (result) return result;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return { ok: false, code: sawTracks ? "network" : "no-captions", detail: notes.join("; ") };
}
