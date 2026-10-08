import { mountStudio } from "../../shared/src/ui/studio-app";
import "../../shared/src/ui/app.css";
import { canonicalWatchUrl } from "../../shared/src/youtube/url";
import { tryExtensionFetch } from "./extension-bridge";

const root = document.querySelector("#app");
if (root instanceof HTMLElement) {
  mountStudio(root, {
    mode: "web",
    devProxy: import.meta.env.DEV,
    getContextVideo: async () => null,
    openAtTimestamp: (videoId, seconds) => {
      window.open(canonicalWatchUrl(videoId, seconds), "_blank", "noopener");
    },
    tryExtensionFetch,
  });
}
