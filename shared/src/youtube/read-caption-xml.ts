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
}

/**
 * Runs inside a youtube.com document. YouTube answers this player call for that
 * origin and withholds caption tracks from every other origin.
 */
export async function readCaptionXml(videoId: string, languages: string[]): Promise<CaptionXmlResult> {
  try {
    const rootLookup = () => (typeof document === "undefined" ? null : document.getElementById("movie_player"));
    let player: PlayerPayload | null = null;
    let discovery = "fetch";
    if (typeof document !== "undefined") {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const playerNode = rootLookup() as { getPlayerResponse?: () => PlayerPayload } | null;
        if (playerNode?.getPlayerResponse) {
          try {
            const candidate = playerNode.getPlayerResponse();
            const ready = candidate?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
            if (ready.some((track) => track.baseUrl && track.languageCode)) {
              player = candidate ?? null;
              discovery = "player";
              break;
            }
            discovery = "player-empty";
          } catch (error) {
            discovery = error instanceof Error ? `player ${error.message}` : "player-throw";
          }
        } else {
          discovery = `dom:${Boolean(playerNode)}`;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!player) {
      const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", hl: "en" } },
          videoId,
        }),
      });
      if (!response.ok) return { ok: false, code: "network", detail: `${discovery} http ${response.status}` };
      player = (await response.json()) as PlayerPayload;
      discovery = `${discovery}+fetch`;
    }
    const tracks = (player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).filter(
      (track) => Boolean(track.baseUrl && track.languageCode),
    );
    const preferred = (Array.isArray(languages) ? languages : ["en"]).map((language) => language.toLowerCase());
    let selected: CaptionTrackPayload | undefined;
    for (const language of preferred) {
      selected = tracks.find((track) => track.languageCode?.toLowerCase() === language && track.kind !== "asr");
      if (selected) break;
    }
    if (!selected) {
      for (const language of preferred) {
        selected = tracks.find((track) => (track.languageCode ?? "").toLowerCase().startsWith(language));
        if (selected) break;
      }
    }
    selected ??= tracks[0];
    if (!selected?.baseUrl || !selected.languageCode) return { ok: false, code: "no-captions", detail: discovery };
    const caption = await fetch(selected.baseUrl);
    if (!caption.ok) return { ok: false, code: "network", detail: `${discovery} caption ${caption.status}` };
    const xml = await caption.text();
    if (!xml.trim()) return { ok: false, code: "no-captions", detail: `${discovery} empty` };
    return {
      ok: true,
      xml,
      languageCode: selected.languageCode,
      title: player?.videoDetails?.title?.trim() || "YouTube video",
      author: player?.videoDetails?.author?.trim() || "",
    };
  } catch (error) {
    return { ok: false, code: "network", detail: error instanceof Error ? error.message : "throw" };
  }
}
