import { translate } from "../../shared/src/i18n";
import type { Locale } from "../../shared/src/types";
import { detectLocale, readStoredLocale } from "../../shared/src/storage/preferences";

const BUTTON_ID = "yts-open-studio";

function localeFrom(value: unknown): Locale {
  return readStoredLocale(typeof value === "string" ? value : null) ?? detectLocale(navigator.language);
}

function ensureButton(locale: Locale): void {
  const onWatch = location.pathname === "/watch";
  const existing = document.getElementById(BUTTON_ID);
  if (!onWatch) {
    existing?.remove();
    return;
  }
  const label = translate(locale, "openStudio");
  if (existing instanceof HTMLButtonElement) {
    existing.textContent = label;
    existing.setAttribute("aria-label", label);
    return;
  }
  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-label", label);
  button.style.cssText = [
    "position:fixed",
    "right:20px",
    "bottom:20px",
    "z-index:2147483646",
    "background:#0d5c42",
    "color:#fff",
    "border:0",
    "border-radius:999px",
    "padding:12px 16px",
    "font:600 14px/1.2 Segoe UI,sans-serif",
    "box-shadow:0 10px 30px rgba(0,0,0,.28)",
    "cursor:pointer",
  ].join(";");
  button.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "open-panel" }, (response) => {
      if (!response?.ok) button.title = translate(locale, "extensionPermission");
    });
  });
  document.body.append(button);
}

function refresh(): void {
  chrome.storage.local.get("yts.language", (result) => {
    ensureButton(localeFrom(result["yts.language"]));
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "get-video") {
    sendResponse({ videoId: new URL(location.href).searchParams.get("v") ?? "", url: location.href });
    return true;
  }
  if (message?.type === "seek") {
    const video = document.querySelector("video");
    if (video instanceof HTMLVideoElement) {
      video.currentTime = Number(message.seconds) || 0;
      void video.play().catch(() => undefined);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }
  return undefined;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes["yts.language"]) refresh();
});

document.addEventListener("yt-navigate-finish", () => refresh());
refresh();
