import {
  CHAT_SYSTEM,
  OVERVIEW_SYSTEM,
  PART_SYSTEM,
  REMOTE_CHAT_SYSTEM,
  REMOTE_SUMMARY_SYSTEM,
  STUDY_SYSTEM,
  buildChatUserPrompt,
  buildInsightsUserPrompt,
  buildMergeUserPrompt,
  buildRemoteChatUserPrompt,
  buildRemoteSummaryUserPrompt,
  languageName,
  buildStudyUserPrompt,
} from "../ai/prompts";
import { condenseTranscript, transcriptParts } from "../ai/chunk";
import { LocalModelClient } from "../ai/client";
import {
  isModelListed,
  remoteComplete,
  remoteEnabled,
  remoteModels,
  remoteWarm,
  normalizeBaseUrl,
  type RemoteSettings,
} from "../ai/remote";
import {
  cleanSummaryText,
  parseChatResponse,
  parseRemoteSummary,
  parseStudyPack,
  timestampsIn,
} from "../ai/parse-model";
import { nearestSegment, retrieveSegments } from "../ai/retrieve";
import {
  downloadTextFile,
  exportAnkiCsv,
  exportMarkdown,
  exportPlainTranscript,
  exportSrt,
  exportStudyMarkdown,
  exportTxt,
  exportVtt,
  fileSlug,
} from "../export/exporters";
import { StudioError, isStudioError } from "../errors";
import type { MessageKey } from "../i18n";
import { translate } from "../i18n";
import { clearVideos, deleteVideo, listVideos, saveVideo } from "../storage/history";
import {
  PREF_INCLUDE_CHAT,
  PREF_LANGUAGE,
  PREF_TAB,
  PREF_THEME,
  initialLocale,
  initialTab,
  initialTheme,
  localGet,
  localSet,
  readStoredRemote,
  writeStoredRemote,
} from "../storage/preferences";
import { findMatches, rangesForSegment } from "../transcript/search";
import { parsePlainTranscript } from "../transcript/parse";
import { formatTimestamp, parseClock } from "../transcript/time";
import type { ChatMessage, Citation, Insights, KeyPoint, TabId, Theme, TranscriptSegment, VideoRecord } from "../types";
import { fetchYouTubeTranscript, preferredCaptionLanguages } from "../youtube/fetch-transcript";
import type { FetchedTranscript } from "../youtube/fetch-transcript";
import { canonicalWatchUrl, parseYouTubeVideoId, thumbnailUrl } from "../youtube/url";
import { appendHighlighted, clear, copyText, el, formatMegabytes, isEditableTarget } from "./dom";
import { hasTimes, parseInline, parseRichText, type RichBlock, type RichInline } from "./rich-text";

const TABS: TabId[] = ["insights", "transcript", "chat", "study", "export"];
/** Questions like "resuma este vídeo" are answered from the summary, not from keyword matches. */
const SUMMARY_INTENT = /\b(resum\w*|summar\w*|resumen\w*|tl;?dr|overview)\b/i;
/** Transcript text per API request. Portuguese with timestamps is about 2.9 characters per token, so this is about 5k tokens and leaves room for the 8k-token context. */
/** Chat sees this much transcript; answers are short, so the longer context costs little. */
const REMOTE_CONTEXT_CHARS = 14000;
/**
 * One API request holds this much transcript. ~8k-token models (Llama 3.1 8B) keep
 * room for the JSON answer; longer videos are evenly condensed instead of split into
 * N sequential/parallel calls (one GPU still runs those one-by-one and feels slower).
 */
const REMOTE_SUMMARY_CHARS = 14000;
const SUMMARY_VERSION = 5;
const CLOCK_PREFIX = /^\[((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]\s*/;
const REPO = "https://github.com/lcarlini/YouTubeTranscriptStudio";
const PAGES = "https://lcarlini.github.io/YouTubeTranscriptStudio/";

export interface StudioHost {
  mode: "web" | "extension";
  devProxy: boolean;
  wasmPaths?: string;
  getContextVideo: () => Promise<string | null>;
  openAtTimestamp: (videoId: string, seconds: number) => void;
  tryCaptionFrame?: (videoId: string, languages: string[]) => Promise<FetchedTranscript | null>;
  tryExtensionFetch?: (videoId: string, languages: string[]) => Promise<FetchedTranscript | null>;
  onLocaleChange?: (locale: "en" | "pt-BR" | "es") => void;
  /** Extension only: asks the browser for permission to call a user-chosen API origin. */
  requestOrigin?: (url: string) => Promise<boolean>;
}

export function mountStudio(root: HTMLElement, host: StudioHost): void {
  new StudioApp(root, host);
}

class StudioApp {
  private locale = initialLocale();
  private tab = initialTab();
  private theme: Theme = initialTheme();
  private insightsProgress = "";
  private urlInput = "";
  private phase: "idle" | "loading" | "ready" | "error" = "idle";
  private formError: string | null = null;
  private video: VideoRecord | null = null;
  private history: VideoRecord[] = [];
  private search = "";
  private matchIndex = 0;
  private highlightedId: string | null = null;
  private chatDraft = "";
  private chatBusy = false;
  private insightsBusy = false;
  private studyBusy = false;
  private cardIndex = 0;
  private cardFlipped = false;
  private quizIndex = 0;
  private quizChoice: number | null = null;
  private quizChecked = false;
  private includeChat = localGet(PREF_INCLUDE_CHAT) === "1";
  private confirmClear = false;
  private confirmDeleteId: string | null = null;
  private saveTimer = 0;
  private readonly model: LocalModelClient;
  private remote: RemoteSettings = readStoredRemote();
  private paintedVideoId: string | null | undefined = undefined;
  private readonly nodes: Shell;
  /** Cold-start warm of Ollama or the in-browser model; shared so summary waits for it. */
  private warmPromise: Promise<void> | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: StudioHost,
  ) {
    localSet(PREF_LANGUAGE, this.locale);
    document.documentElement.lang = this.locale;
    this.nodes = this.build();
    this.model = new LocalModelClient(() => this.paintModel(), host.wasmPaths);
    this.applyI18n();
    this.applyTheme();
    this.setTab(this.tab);
    this.paintModel();
    this.bind();
    void this.refreshHistory();
    // Warm the model while the side panel paints and the current-tab transcript loads.
    void this.ensureWarm();
    if (host.mode === "extension") void this.preloadExtensionVideo();
  }

  private t(key: MessageKey, vars?: Record<string, string | number>): string {
    return translate(this.locale, key, vars);
  }

  private build(): Shell {
    this.root.className = this.host.mode === "extension" ? "page is-extension" : "page";
    const url = el("input", { id: "video-url", type: "url", autocomplete: "off", spellcheck: "false", "data-i18n-placeholder": "urlPlaceholder" });
    const formError = el("p", { class: "alert", role: "alert" });
    formError.hidden = true;
    const process = el("button", { class: "btn btn-primary", type: "submit" });
    const pasteInput = el("textarea", { "data-i18n-placeholder": "pastePlaceholder", rows: "6" });
    const file = el("input", { type: "file", accept: ".srt,.vtt,.txt,text/vtt,text/plain" });
    const segmentList = el("div", { class: "segment-list" });
    const search = el("input", { type: "search", "data-i18n-placeholder": "searchPlaceholder" });
    const searchMeta = el("p", { class: "muted", role: "status" });
    const estimated = el("p", { class: "alert" });
    estimated.hidden = true;
    const videoTitle = el("h2");
    const videoMeta = el("p", { class: "muted" });
    const insightsBody = el("div", { class: "stack" });
    const chatLog = el("div", { class: "chat-log", role: "log", "aria-live": "polite" });
    const chatInput = el("textarea", { "data-i18n-placeholder": "askPlaceholder", rows: "1" });
    const studyBody = el("div", { class: "stack" });
    const modelPill = el("p", { class: "model-pill", role: "status", "data-i18n-label": "statusLabel" });
    const historyList = el("div", { class: "history-list" });
    const includeChat = el("input", { type: "checkbox" });
    includeChat.checked = this.includeChat;
    const dialog = el("dialog");
    const cacheValue = el("strong");
    const deviceValue = el("strong");
    const fallback = el("p", { class: "muted" });
    const apiUrl = el("input", { type: "url", autocomplete: "off", spellcheck: "false", "data-i18n-placeholder": "apiUrlPlaceholder" });
    apiUrl.value = this.remote.baseUrl;
    const apiModel = el("input", { type: "text", autocomplete: "off", spellcheck: "false", "data-i18n-placeholder": "apiModelPlaceholder" });
    apiModel.value = this.remote.model;
    const apiKey = el("input", { type: "password", autocomplete: "off", "data-i18n-placeholder": "apiKeyPlaceholder" });
    apiKey.value = this.remote.apiKey;
    const apiStatus = el("p", { class: "muted", role: "status" });
    const tabs = {} as Record<TabId, HTMLButtonElement>;
    const panels = {} as Record<TabId, HTMLElement>;

    const tablist = el("div", { class: "tabs", role: "tablist", "data-i18n-label": "tabsLabel" });
    for (const id of TABS) {
      const button = el("button", {
        class: "tab",
        type: "button",
        role: "tab",
        id: `tab-${id}`,
        "aria-controls": `panel-${id}`,
        "data-i18n": tabKey(id),
        "data-action": "tab",
        "data-tab": id,
      });
      const panel = el("section", {
        class: "panel",
        role: "tabpanel",
        id: `panel-${id}`,
        "aria-labelledby": `tab-${id}`,
        tabindex: "0",
      });
      tabs[id] = button;
      panels[id] = panel;
      tablist.append(button);
    }

    panels.transcript.append(
      el("div", { class: "toolbar" }, [
        el("label", { class: "search" }, [
          el("span", { class: "visually-hidden", "data-i18n": "searchLabel" }),
          search,
        ]),
        searchMeta,
        el("button", { class: "btn btn-ghost", type: "button", "data-action": "prev-match", "data-i18n": "prevMatch" }),
        el("button", { class: "btn btn-ghost", type: "button", "data-action": "next-match", "data-i18n": "nextMatch" }),
        el("button", { class: "btn btn-ghost", type: "button", "data-action": "copy-all", "data-i18n": "copyTranscript" }),
      ]),
      el("p", { class: "muted", "data-i18n": "editHint" }),
      estimated,
      segmentList,
    );
    const insightsCopy = el("button", { class: "btn btn-ghost", type: "button", "data-action": "copy-summary", "data-i18n": "copySummary" });
    insightsCopy.disabled = true;
    panels.insights.append(
      el("div", { class: "toolbar" }, [
        el("button", { class: "btn btn-primary", type: "button", "data-action": "insights", "data-i18n": "generateInsights" }),
        insightsCopy,
      ]),
      insightsBody,
    );
    panels.chat.append(
      chatLog,
      el("div", { class: "chat-dock" }, [
        el("div", { class: "suggestions" }, [
          el("span", { class: "visually-hidden", "data-i18n": "suggestions" }),
          ...(["suggestSummary", "suggestTopics", "suggestExplain", "suggestStudy"] as const).map((key) =>
            el("button", { class: "chip", type: "button", "data-action": "suggest", "data-suggest": key, "data-i18n": key }),
          ),
        ]),
        el("form", { class: "composer" }, [
          el("label", { class: "composer-field" }, [
            el("span", { class: "visually-hidden", "data-i18n": "askLabel" }),
            chatInput,
          ]),
          el("button", { class: "btn btn-primary send", type: "submit", "data-i18n": "send" }),
        ]),
      ]),
    );
    panels.study.append(
      el("div", { class: "toolbar" }, [
        el("button", { class: "btn btn-primary", type: "button", "data-action": "study", "data-i18n": "generateStudy" }),
        el("button", { class: "btn btn-ghost", type: "button", "data-action": "download", "data-format": "anki", "data-i18n": "exportAnki" }),
        el("button", { class: "btn btn-ghost", type: "button", "data-action": "download", "data-format": "study-md", "data-i18n": "exportStudyMd" }),
      ]),
      studyBody,
    );
    panels.export.append(
      el("p", { "data-i18n": "exportHelp" }),
      el("div", { class: "inline" }, [
        el("button", { class: "btn btn-primary", type: "button", "data-action": "download", "data-format": "srt", "data-i18n": "downloadSrt" }),
        el("button", { class: "btn btn-ghost", type: "button", "data-action": "download", "data-format": "txt", "data-i18n": "downloadTxt" }),
        el("button", { class: "btn btn-ghost", type: "button", "data-action": "download", "data-format": "vtt", "data-i18n": "downloadVtt" }),
        el("button", { class: "btn btn-ghost", type: "button", "data-action": "download", "data-format": "md", "data-i18n": "downloadMd" }),
      ]),
      el("label", { class: "inline" }, [
        includeChat,
        el("span", { "data-i18n": "includeChat" }),
      ]),
    );

    const videoHead = el("article", { class: "video-head" }, [
      el("img", { alt: "", width: "168", height: "94" }),
      el("div", {}, [
        videoTitle,
        videoMeta,
        el("div", { class: "inline" }, [
          el("a", { "data-i18n": "openOnYouTube", target: "_blank", rel: "noreferrer" }),
          el("span", { class: "muted", "data-i18n": "savedInBrowser" }),
        ]),
      ]),
    ]);

    const workspace = el("section", { class: "workspace" }, [videoHead, tablist, ...TABS.map((id) => panels[id])]);
    workspace.hidden = true;

    dialog.append(
      el("div", { class: "settings-card" }, [
        el("h2", { "data-i18n": "settingsTitle" }),
        el("label", { class: "field lang" }, [
          el("span", { "data-i18n": "languageLabel" }),
          el("select", { "data-i18n-label": "languageLabel" }, [
            el("option", { value: "en" }, ["English"]),
            el("option", { value: "pt-BR" }, ["Português (Brasil)"]),
            el("option", { value: "es" }, ["Español"]),
          ]),
        ]),
        el("p", { "data-i18n": "settingsIntro" }),
        el("p", {}, [el("span", { "data-i18n": "statusLabel" }), " ", el("strong", { class: "settings-status" })]),
        el("p", {}, [el("span", { "data-i18n": "modelDevice" }), " ", deviceValue]),
        fallback,
        el("h3", { "data-i18n": "apiTitle" }),
        el("p", { class: "muted", "data-i18n": "apiIntro" }),
        el("label", { class: "field" }, [el("span", { "data-i18n": "apiUrlLabel" }), apiUrl]),
        el("label", { class: "field" }, [el("span", { "data-i18n": "apiModelLabel" }), apiModel]),
        el("label", { class: "field" }, [el("span", { "data-i18n": "apiKeyLabel" }), apiKey]),
        apiStatus,
        el("div", { class: "inline" }, [
          el("button", { class: "btn btn-primary", type: "button", "data-action": "api-save", "data-i18n": "apiSave" }),
          el("button", { class: "btn btn-ghost", type: "button", "data-action": "api-test", "data-i18n": "apiTest" }),
        ]),
        el("p", {}, [el("span", { "data-i18n": "cacheUsage" }), " ", cacheValue]),
        el("div", { class: "inline" }, [
          el("button", { class: "btn btn-primary", type: "button", "data-action": "load-model", "data-i18n": "loadModel" }),
          el("button", { class: "btn btn-ghost", type: "button", "data-action": "retry-model", "data-i18n": "retryModel" }),
          el("button", { class: "btn btn-danger", type: "button", "data-action": "clear-cache", "data-i18n": "clearCache" }),
          el("button", { class: "btn btn-ghost", type: "button", "data-action": "close-settings", "data-i18n": "close" }),
        ]),
        el("h3", { "data-i18n": "shortcuts" }),
        el("ul", {}, [
          el("li", {}, [el("span", { "data-i18n": "shortcutSearch" }), " — /"]),
          el("li", {}, [el("span", { "data-i18n": "shortcutCopy" }), " — Ctrl+Shift+C"]),
          el("li", {}, [el("span", { "data-i18n": "shortcutTabs" }), " — Alt+1–5"]),
        ]),
      ]),
    );

    const toasts = el("div", { class: "toast-region", "aria-live": "polite" });
    const themeButton = el("button", { class: "btn btn-ghost theme-toggle", type: "button", "data-action": "theme" });
    this.root.append(
      el("a", { class: "skip", href: "#content", "data-i18n": "skip" }),
      el("header", { class: "topbar" }, [
        el("a", { class: "brand", href: "#content" }, [
          el("span", { class: "brand-mark", "aria-hidden": "true" }, ["YT"]),
          el("span", { class: "brand-name", "data-i18n": "brand" }),
        ]),
        el("div", { class: "top-actions" }, [
          modelPill,
          themeButton,
          el("button", { class: "btn btn-ghost", type: "button", "data-action": "settings", "data-i18n": "settings" }),
        ]),
      ]),
      el("main", { id: "content" }, [
        el("section", { class: "hero" }, [
          el("p", { class: "eyebrow", "data-i18n": "heroEyebrow" }),
          el("h1", { "data-i18n": "heroTitle" }),
          el("p", { class: "lede", "data-i18n": "heroBody" }),
          el("button", { class: "btn btn-primary", type: "button", "data-action": "jump-url", "data-i18n": "heroCta" }),
        ]),
        el("section", { class: "feature-grid" }, [
          feature("featureTranscript", "featureTranscriptBody"),
          feature("featureExport", "featureExportBody"),
          feature("featureAi", "featureAiBody"),
          feature("featureExtension", "featureExtensionBody"),
        ]),
        el("section", { class: "studio", id: "studio" }, [
          el("form", { class: "url-row" }, [
            el("label", { class: "field" }, [el("span", { "data-i18n": "urlLabel" }), url]),
            process,
            this.host.mode === "extension"
              ? el("button", { class: "btn btn-ghost", type: "button", "data-action": "use-current", "data-i18n": "useCurrentVideo" })
              : null,
          ]),
          formError,
          // The summary sits right under the URL field; history and pasting come after it.
          workspace,
          el("details", { class: "paste" }, [
            el("summary", { "data-i18n": "pasteSummary" }),
            el("p", { class: "muted", "data-i18n": "pasteHelp" }),
            el("form", {}, [
              pasteInput,
              el("div", { class: "inline" }, [
                el("button", { class: "btn btn-primary", type: "submit", "data-i18n": "usePaste" }),
                el("label", { class: "btn btn-ghost" }, [el("span", { "data-i18n": "uploadCaptions" }), file]),
              ]),
            ]),
          ]),
          el("details", { class: "history", open: true }, [
            el("summary", { "data-i18n": "recentTitle" }),
            el("div", { class: "toolbar" }, [
              el("p", { class: "muted", "data-i18n": "historyNote" }),
              el("button", { class: "btn btn-ghost", type: "button", "data-action": "clear-history", "data-i18n": "clearHistory" }),
            ]),
            historyList,
          ]),
        ]),
      ]),
      el("footer", { class: "footer" }, [
        el("p", { "data-i18n": "privacy" }),
        el("nav", { class: "inline" }, [
          el("a", { href: `${REPO}/blob/main/LICENSE`, "data-i18n": "footerLicense" }),
          el("a", { href: REPO, "data-i18n": "footerRepo" }),
          el("a", { href: PAGES, "data-i18n": "footerPages" }),
        ]),
      ]),
      dialog,
      toasts,
    );

    const style = document.createElement("style");
    style.textContent = ".visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}";
    this.root.append(style);
    (this.root.querySelector("select") as HTMLSelectElement).value = this.locale;

    return {
      url,
      formError,
      process,
      paste: this.root.querySelector(".paste") as HTMLDetailsElement,
      pasteInput,
      file,
      segmentList,
      search,
      searchMeta,
      estimated,
      videoTitle,
      videoMeta,
      videoLink: videoHead.querySelector("a") as HTMLAnchorElement,
      videoImage: videoHead.querySelector("img") as HTMLImageElement,
      insightsBody,
      insightsButton: panels.insights.querySelector("[data-action='insights']") as HTMLButtonElement,
      insightsCopy,
      themeButton,
      chatLog,
      chatInput,
      studyBody,
      studyButton: panels.study.querySelector("[data-action='study']") as HTMLButtonElement,
      modelPill,
      history: this.root.querySelector(".history") as HTMLDetailsElement,
      historyList,
      includeChat,
      dialog,
      cacheValue,
      deviceValue,
      fallback,
      apiUrl,
      apiModel,
      apiKey,
      apiStatus,
      settingsStatus: dialog.querySelector(".settings-status") as HTMLElement,
      tabs,
      panels,
      workspace,
      toasts,
    };
  }

  private bind(): void {
    this.root.addEventListener("click", (event) => void this.onClick(event));
    this.root.addEventListener("submit", (event) => void this.onSubmit(event));
    this.root.addEventListener("input", (event) => this.onInput(event));
    this.root.addEventListener("change", (event) => void this.onChange(event));
    this.root.addEventListener("keydown", (event) => this.onKeydown(event));
    document.addEventListener("keydown", (event) => this.onGlobalKeydown(event));
    this.nodes.dialog.addEventListener("close", () => undefined);
  }

  private async onClick(event: MouseEvent): Promise<void> {
    const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.action;
    if (action === "jump-url") {
      this.nodes.url.focus();
      this.root.querySelector("#studio")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (action === "tab" && target.dataset.tab) {
      this.setTab(target.dataset.tab as TabId);
    } else if (action === "settings") {
      await this.refreshCacheLabel();
      this.paintModel();
      this.nodes.dialog.showModal();
    } else if (action === "close-settings") {
      this.nodes.dialog.close();
    } else if (action === "api-save") {
      await this.saveRemote();
    } else if (action === "api-test") {
      await this.testRemote();
    } else if (action === "use-current") {
      await this.useCurrentVideo(true);
    } else if (action === "copy-all") {
      await this.copyAll();
    } else if (action === "copy-segment" && target.dataset.segmentId) {
      const segment = this.video?.segments.find((item) => item.id === target.dataset.segmentId);
      if (!segment) return;
      await this.copyValue(`[${formatTimestamp(segment.start)}] ${segment.text}`, "segmentCopied");
    } else if (action === "timestamp" && target.dataset.start && this.video?.url) {
      this.host.openAtTimestamp(this.video.videoId, Number(target.dataset.start));
    } else if (action === "prev-match") {
      this.moveMatch(-1);
    } else if (action === "next-match") {
      this.moveMatch(1);
    } else if (action === "theme") {
      this.theme = this.theme === "dark" ? "light" : "dark";
      localSet(PREF_THEME, this.theme);
      this.applyTheme();
    } else if (action === "copy-summary") {
      await this.copySummary();
    } else if (action === "insights") {
      await this.runInsights();
    } else if (action === "study") {
      await this.runStudy();
    } else if (action === "suggest" && target.dataset.suggest) {
      this.chatDraft = this.t(target.dataset.suggest as MessageKey);
      this.nodes.chatInput.value = this.chatDraft;
      await this.sendChat();
    } else if (action === "citation") {
      this.highlightedId = target.dataset.segmentId ?? null;
      this.setTab("transcript");
      this.paintTranscriptList();
      this.root.querySelector(".segment.is-active")?.scrollIntoView({ block: "center" });
    } else if (action === "followup" && target.dataset.question) {
      this.chatDraft = target.dataset.question;
      this.nodes.chatInput.value = this.chatDraft;
      this.setTab("chat");
      await this.sendChat();
    } else if (action === "download") {
      this.download(target.dataset.format ?? "");
    } else if (action === "open-history" && target.dataset.videoId) {
      const record = this.history.find((item) => item.videoId === target.dataset.videoId);
      if (!record) return;
      this.video = structuredClone(record);
      this.urlInput = record.url;
      this.nodes.url.value = record.url;
      this.phase = "ready";
      this.formError = null;
      this.cardIndex = 0;
      this.quizIndex = 0;
      this.paintSession();
    } else if (action === "delete-history" && target.dataset.videoId) {
      this.confirmDeleteId = target.dataset.videoId;
      this.paintHistory();
    } else if (action === "confirm-delete" && target.dataset.videoId) {
      await deleteVideo(target.dataset.videoId);
      if (this.video?.videoId === target.dataset.videoId) {
        this.video = null;
        this.phase = "idle";
      }
      this.confirmDeleteId = null;
      await this.refreshHistory();
      this.paintSession();
      this.toast(this.t("removedVideo"), "ok");
    } else if (action === "cancel-delete") {
      this.confirmDeleteId = null;
      this.paintHistory();
    } else if (action === "clear-history") {
      this.confirmClear = true;
      this.paintHistory();
    } else if (action === "confirm-clear") {
      await clearVideos();
      this.video = null;
      this.phase = "idle";
      this.confirmClear = false;
      await this.refreshHistory();
      this.paintSession();
      this.toast(this.t("historyCleared"), "ok");
    } else if (action === "cancel-clear") {
      this.confirmClear = false;
      this.paintHistory();
    } else if (action === "flip-card") {
      this.cardFlipped = !this.cardFlipped;
      this.paintStudy();
    } else if (action === "prev-card") {
      this.stepCard(-1);
    } else if (action === "next-card") {
      this.stepCard(1);
    } else if (action === "quiz-choice") {
      this.quizChoice = Number(target.dataset.choice);
      this.quizChecked = false;
      this.paintStudy();
    } else if (action === "check-quiz") {
      this.quizChecked = this.quizChoice !== null;
      this.paintStudy();
    } else if (action === "next-quiz") {
      const total = this.video?.study?.quiz.length ?? 0;
      this.quizIndex = total === 0 ? 0 : (this.quizIndex + 1) % total;
      this.quizChoice = null;
      this.quizChecked = false;
      this.paintStudy();
    } else if (action === "load-model" || action === "retry-model") {
      await this.warmModel();
    } else if (action === "clear-cache") {
      try {
        await this.model.clearCache();
        this.toast(this.t("cacheCleared"), "ok");
        await this.refreshCacheLabel();
      } catch {
        this.toast(this.t("cacheFailed"), "err");
      }
    }
  }

  private async onSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.classList.contains("url-row")) await this.processUrl();
    else if (form.classList.contains("composer")) await this.sendChat();
    else await this.importPasted(this.nodes.pasteInput.value);
  }

  private onInput(event: Event): void {
    const target = event.target;
    const editable = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-segment-id]") : null;
    if (target === this.nodes.url) this.urlInput = this.nodes.url.value;
    else if (target === this.nodes.search) {
      this.search = this.nodes.search.value;
      this.matchIndex = 0;
      this.paintTranscriptList();
    } else if (target === this.nodes.chatInput) {
      this.chatDraft = this.nodes.chatInput.value;
    } else if (target === this.nodes.pasteInput) {
      return;
    } else if (editable?.dataset.segmentId && this.video) {
      const segment = this.video.segments.find((item) => item.id === editable.dataset.segmentId);
      if (!segment) return;
      segment.text = editable.textContent ?? "";
      window.clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => void this.persist(), 400);
    }
  }

  private async onChange(event: Event): Promise<void> {
    const target = event.target;
    if (target instanceof HTMLSelectElement) {
      const value = target.value;
      if (value === "en" || value === "pt-BR" || value === "es") {
        this.locale = value;
        localSet(PREF_LANGUAGE, value);
        document.documentElement.lang = value;
        this.host.onLocaleChange?.(value);
        this.applyI18n();
        this.paintSession();
      }
    } else if (target === this.nodes.includeChat) {
      this.includeChat = this.nodes.includeChat.checked;
      localSet(PREF_INCLUDE_CHAT, this.includeChat ? "1" : "0");
    } else if (target === this.nodes.file && this.nodes.file.files?.[0]) {
      const text = await this.nodes.file.files[0].text();
      this.nodes.pasteInput.value = text;
    }
  }

  private onKeydown(event: KeyboardEvent): void {
    const target = event.target;
    if (target instanceof HTMLElement && target.dataset.segmentId && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
    }
    if (target === this.nodes.chatInput && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.nodes.chatInput.form?.requestSubmit();
      return;
    }
    if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "tab") return;
    const current = TABS.indexOf(this.tab);
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "ArrowRight" ? (current + 1) % TABS.length
      : event.key === "ArrowLeft" ? (current - 1 + TABS.length) % TABS.length
        : event.key === "Home" ? 0 : TABS.length - 1;
    this.setTab(TABS[next]);
    this.nodes.tabs[TABS[next]].focus();
  }

  private onGlobalKeydown(event: KeyboardEvent): void {
    if (event.key === "/" && !event.metaKey && !event.ctrlKey && !isEditableTarget(event.target)) {
      event.preventDefault();
      this.setTab("transcript");
      this.nodes.search.focus();
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void this.copyAll();
    }
    if (event.altKey && /^[1-5]$/.test(event.key)) {
      event.preventDefault();
      this.setTab(TABS[Number(event.key) - 1]);
    }
  }

  private async processUrl(): Promise<void> {
    const raw = this.nodes.url.value.trim();
    this.urlInput = raw;
    if (!raw) {
      this.setFormError(this.t("urlEmpty"));
      return;
    }
    const videoId = parseYouTubeVideoId(raw);
    if (!videoId) {
      this.setFormError(this.t("urlInvalid"));
      return;
    }
    await this.loadVideo(videoId);
  }

  private async loadVideo(videoId: string): Promise<void> {
    this.phase = "loading";
    this.formError = null;
    this.paintProcess();
    this.nodes.formError.hidden = true;
    if (!this.video) {
      this.nodes.workspace.hidden = false;
      this.paintSkeleton();
    }
    try {
      const languages = preferredCaptionLanguages(this.locale);
      // Prefer the watch-tab captions first (fast). Only open the embed popup if that fails.
      // History refresh runs in parallel with the caption fetch so the shell feels ready sooner.
      const historyReady = this.refreshHistory();
      let fetched: FetchedTranscript | null = null;
      for (const [name, strategy] of [
        ["caption-frame", this.host.tryCaptionFrame],
        ["extension-fetch", this.host.tryExtensionFetch],
      ] as const) {
        if (!strategy) continue;
        try {
          fetched = await strategy(videoId, languages);
        } catch (error) {
          console.warn(`[YTS] ${name} failed`, error);
        }
        if (fetched) break;
      }
      fetched ??= await fetchYouTubeTranscript(videoId, {
        preferredLanguages: languages,
        youtubeProxyPrefix: this.host.devProxy ? "/yt-proxy" : null,
        browserPage: this.host.mode === "web" && !this.host.devProxy,
      });
      this.video = toRecord(fetched);
      this.phase = "ready";
      this.cardIndex = 0;
      this.quizIndex = 0;
      this.highlightedId = null;
      this.search = "";
      this.nodes.search.value = "";
      await Promise.all([this.persist(), historyReady]);
      await this.refreshHistory();
      this.toast(this.t("savedInBrowser"), "ok");
      // Summary starts as soon as the transcript is ready; ensureWarm overlaps with the fetch above.
      if (!this.video.insights) void this.runInsights();
    } catch (error) {
      this.phase = this.video ? "ready" : "error";
      this.setFormError(this.t(messageKey(error)));
      this.nodes.paste.open = true;
      this.toast(this.formError ?? this.t("networkError"), "err");
    }
    this.paintSession();
  }

  private async importPasted(raw: string): Promise<void> {
    const parsed = parsePlainTranscript(raw);
    if (parsed.segments.length === 0) {
      this.setFormError(this.t("pasteEmpty"));
      return;
    }
    const videoId = parseYouTubeVideoId(this.nodes.url.value) ?? `local-${Date.now().toString(36)}`;
    let title = this.t("pasteSummary");
    let author = "";
    let thumb = parseYouTubeVideoId(this.nodes.url.value) ? thumbnailUrl(videoId) : "";
    if (parseYouTubeVideoId(videoId)) {
      try {
        const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalWatchUrl(videoId))}&format=json`);
        if (response.ok) {
          const data = (await response.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
          title = data.title || title;
          author = data.author_name || "";
          thumb = data.thumbnail_url || thumb;
        }
      } catch {
        // The pasted transcript is still usable without remote metadata.
      }
    }
    this.video = {
      videoId,
      url: parseYouTubeVideoId(videoId) ? canonicalWatchUrl(videoId) : "",
      title,
      author,
      thumbnailUrl: thumb,
      captionLanguage: this.locale,
      processedAt: Date.now(),
      segments: parsed.segments,
      insights: null,
      study: null,
      chat: [],
      timestampsEstimated: parsed.estimated,
    };
    this.phase = "ready";
    this.formError = null;
    await this.persist();
    await this.refreshHistory();
    this.paintSession();
    this.toast(this.t("savedInBrowser"), "ok");
    // With an API configured the in-browser model is never used, so do not
    // load it on the GPU in the background (it competes with the display).
    if (!remoteEnabled(this.remote)) void this.warmModel();
  }

  private async useCurrentVideo(reportEmpty: boolean): Promise<void> {
    try {
      const videoId = await this.host.getContextVideo();
      if (!videoId) {
        if (reportEmpty) this.setFormError(this.t("noActiveVideo"));
        return;
      }
      this.nodes.url.value = canonicalWatchUrl(videoId);
      this.urlInput = this.nodes.url.value;
      await this.loadVideo(videoId);
    } catch {
      this.setFormError(this.t("extensionPermission"));
    }
  }

  private async preloadExtensionVideo(): Promise<void> {
    await this.useCurrentVideo(false);
  }

  private readRemoteForm(): RemoteSettings {
    return {
      baseUrl: this.nodes.apiUrl.value.trim(),
      model: this.nodes.apiModel.value.trim(),
      apiKey: this.nodes.apiKey.value.trim(),
    };
  }

  /** An empty URL switches the app back to the in-browser model. */
  private async saveRemote(): Promise<void> {
    const next = this.readRemoteForm();
    if (next.baseUrl) {
      try {
        next.baseUrl = normalizeBaseUrl(next.baseUrl);
      } catch {
        this.nodes.apiStatus.textContent = this.t("apiBadUrl");
        return;
      }
      if (!next.model) {
        this.nodes.apiStatus.textContent = this.t("apiNeedsModel");
        return;
      }
      // Asked before any await, so the browser still treats the click as a user gesture.
      const granted = this.host.requestOrigin ? await this.host.requestOrigin(next.baseUrl) : true;
      if (!granted) {
        this.nodes.apiStatus.textContent = this.t("apiPermissionDenied");
        return;
      }
    }
    this.remote = next;
    writeStoredRemote(next);
    this.nodes.apiUrl.value = next.baseUrl;
    this.nodes.apiStatus.textContent = next.baseUrl
      ? this.t("apiSaved", { model: next.model })
      : this.t("apiCleared");
    this.paintModel();
  }

  private async testRemote(): Promise<void> {
    const form = this.readRemoteForm();
    if (!form.baseUrl) {
      this.nodes.apiStatus.textContent = this.t("apiNoUrl");
      return;
    }
    this.nodes.apiStatus.textContent = this.t("apiTesting");
    try {
      const settings = { ...form, baseUrl: normalizeBaseUrl(form.baseUrl) };
      const ids = await remoteModels(settings);
      this.nodes.apiStatus.textContent = !form.model || isModelListed(ids, form.model)
        ? this.t("apiOk", { count: ids.length })
        : this.t("apiModelMissing", { model: form.model, list: ids.slice(0, 5).join(", ") || "-" });
    } catch (error) {
      this.nodes.apiStatus.textContent = this.t(messageKey(error));
    }
  }

  /**
   * Reads every part of the transcript (not a sample), then merges the partial
   * summaries in batches until one final summary remains.
   */
  private async runInsights(): Promise<void> {
    if (!this.video || this.insightsBusy) return;
    const video = this.video;
    this.insightsBusy = true;
    this.insightsProgress = "";
    this.paintInsights();
    try {
      video.insights = remoteEnabled(this.remote)
        ? await this.summarizeWithApi(video)
        : await this.summarizeLocally(video);
      await this.persist();
    } catch (error) {
      this.toast(this.t(isStudioError(error) ? messageKey(error) : "insightsFailed"), "err");
    } finally {
      this.insightsBusy = false;
      this.insightsProgress = "";
      this.paintInsights();
    }
  }

  /** One request: full or evenly condensed transcript → overview + key moments. */
  private async summarizeWithApi(video: VideoRecord): Promise<Insights> {
    const engine = this.remote.model;
    // Points without a time are placed at the transcript line that best matches them.
    const locate = (text: string): number | null => retrieveSegments(video.segments, text, 1)[0]?.start ?? null;
    const language = languageName(video.captionLanguage);
    const transcript = condenseTranscript(video.segments, REMOTE_SUMMARY_CHARS);
    this.insightsProgress = this.t("summaryRemote", { model: engine });
    this.paintInsights();
    await this.ensureWarm();
    const raw = await remoteComplete(
      this.remote,
      REMOTE_SUMMARY_SYSTEM,
      buildRemoteSummaryUserPrompt(transcript, language),
      { maxTokens: 1600, json: true },
    );
    const parsed = parseRemoteSummary(raw, locate);
    if (parsed.points.length === 0 && !parsed.overview) {
      throw new StudioError("remote-api", "The API returned no summary.");
    }
    return {
      tldr: parsed.overview,
      takeaways: [],
      points: parsed.points,
      engine,
      version: SUMMARY_VERSION,
      chapters: [],
      glossary: [],
      actionItems: [],
      followUps: [],
    };
  }

  private async summarizeLocally(video: VideoRecord): Promise<Insights> {
    const parts = transcriptParts(video.segments);
    const points: Array<{ start: number; text: string }> = [];
    for (const [index, part] of parts.entries()) {
      this.insightsProgress = this.t("summaryReading", { current: index + 1, total: parts.length });
      this.paintInsights();
      const text = cleanSummaryText(await this.model.generate(PART_SYSTEM, buildInsightsUserPrompt(part.text), 160));
      if (text) points.push({ start: part.segments[0].start, text });
    }
    if (points.length === 0) throw new Error("empty insights");
    this.insightsProgress = this.t("summaryMerging");
    this.paintInsights();
    const overview = await this.combineOverview(points.map((point) => point.text));
    return {
      tldr: overview || points.slice(0, 3).map((point) => point.text).join(" "),
      // Each part keeps the time it starts at, so the points form a clickable timeline.
      takeaways: points.map((point) => `[${formatTimestamp(point.start)}] ${point.text}`),
      engine: "local",
      version: SUMMARY_VERSION,
      chapters: [],
      glossary: [],
      actionItems: [],
      followUps: [],
    };
  }
  /** Writes one overview from the part summaries; long videos are condensed in groups first. */
  private async combineOverview(texts: string[]): Promise<string> {
    if (texts.length <= 8) {
      return cleanSummaryText(await this.model.generate(OVERVIEW_SYSTEM, buildMergeUserPrompt(texts.join("\n")), 200));
    }
    const condensed: string[] = [];
    for (let start = 0; start < texts.length; start += 8) {
      const group = texts.slice(start, start + 8);
      const text = cleanSummaryText(await this.model.generate(OVERVIEW_SYSTEM, buildMergeUserPrompt(group.join("\n")), 160));
      condensed.push(text || group.join(" "));
    }
    return this.combineOverview(condensed);
  }

  private async copySummary(): Promise<void> {
    const insights = this.video?.insights;
    if (!insights) return;
    await this.copyValue(summaryAsText(insights, this.t("takeaways")), "summaryCopied");
  }

  private applyTheme(): void {
    document.documentElement.dataset.theme = this.theme;
    this.nodes.themeButton.textContent = this.t(this.theme === "dark" ? "themeToLight" : "themeToDark");
  }

  private async runStudy(): Promise<void> {
    if (!this.video || this.studyBusy) return;
    this.studyBusy = true;
    this.paintStudy();
    try {
      const summary = this.video.insights ? summaryAsText(this.video.insights) : "";
      const notes = [summary, condenseTranscript(this.video.segments, 1800)]
        .filter(Boolean)
        .join("\n");
      let parsed = parseStudyPack(await this.model.generate(STUDY_SYSTEM, buildStudyUserPrompt(notes), 640));
      parsed ??= parseStudyPack(await this.model.generate(STUDY_SYSTEM, buildStudyUserPrompt(notes.slice(0, 1200)), 480));
      if (!parsed || (parsed.flashcards.length === 0 && parsed.quiz.length === 0)) throw new Error("empty study");
      this.video.study = parsed;
      this.cardIndex = 0;
      this.cardFlipped = false;
      this.quizIndex = 0;
      this.quizChoice = null;
      this.quizChecked = false;
      await this.persist();
    } catch (error) {
      this.toast(this.t(isStudioError(error) ? messageKey(error) : "studyFailed"), "err");
    } finally {
      this.studyBusy = false;
      this.paintStudy();
    }
  }

  private async sendChat(): Promise<void> {
    if (!this.video || this.chatBusy) return;
    const question = this.chatDraft.trim();
    if (!question) return;
    const userMessage: ChatMessage = {
      id: uid("q"),
      role: "user",
      content: question,
      citations: [],
      insufficient: false,
      createdAt: Date.now(),
    };
    this.video.chat.push(userMessage);
    this.chatDraft = "";
    this.nodes.chatInput.value = "";
    this.chatBusy = true;
    this.paintChatLog();
    try {
      if (SUMMARY_INTENT.test(question)) {
        // A summary request needs the whole video, which keyword retrieval cannot provide.
        // Summaries saved by older versions have no titled key moments; build a fresh one.
        if ((this.video.insights?.version ?? 0) < SUMMARY_VERSION) await this.runInsights();
        const insights = this.video.insights;
        this.video.chat.push({
          id: uid("a"),
          role: "assistant",
          content: insights ? summaryAsText(insights, this.t("takeaways")) : this.t("insightsFailed"),
          citations: insights ? citationsFromSummary(insights, this.video.segments) : [],
          insufficient: !insights,
          createdAt: Date.now(),
        });
        await this.persist();
        return;
      }
      if (remoteEnabled(this.remote)) {
        const transcript = condenseTranscript(this.video.segments, REMOTE_CONTEXT_CHARS);
        const answer = (await remoteComplete(this.remote, REMOTE_CHAT_SYSTEM, buildRemoteChatUserPrompt(question, transcript), { maxTokens: 700 })).trim();
        this.video.chat.push({
          id: uid("a"),
          role: "assistant",
          content: answer,
          citations: citationsFromText(answer, this.video.segments),
          insufficient: false,
          createdAt: Date.now(),
        });
        await this.persist();
        return;
      }
      const excerpts = retrieveSegments(this.video.segments, question, 12);
      const raw = await this.model.generate(CHAT_SYSTEM, buildChatUserPrompt(question, excerpts), 360);
      const parsed = parseChatResponse(raw);
      const citations: Citation[] = parsed.insufficient
        ? excerpts.slice(0, 4).map((segment) => ({
          start: segment.start,
          end: segment.start + segment.duration,
          quote: segment.text.slice(0, 140),
          segmentId: segment.id,
        }))
        : parsed.citations.map((citation) => ({
          ...citation,
          segmentId: nearestSegment(this.video?.segments ?? [], citation.start)?.id,
        }));
      this.video.chat.push({
        id: uid("a"),
        role: "assistant",
        content: parsed.insufficient ? this.t("insufficient") : parsed.answer,
        citations,
        insufficient: parsed.insufficient,
        createdAt: Date.now(),
      });
      await this.persist();
    } catch (error) {
      this.toast(this.t(messageKey(error)), "err");
    } finally {
      this.chatBusy = false;
      this.paintChatLog();
    }
  }

  private ensureWarm(): Promise<void> {
    this.warmPromise ??= this.warmInference().catch((error) => {
      // Allow a later retry if Ollama was still starting.
      this.warmPromise = null;
      throw error;
    });
    return this.warmPromise.catch(() => undefined);
  }

  private async warmInference(): Promise<void> {
    if (remoteEnabled(this.remote)) await remoteWarm(this.remote);
    else await this.model.ensureLoaded();
  }

  private async warmModel(): Promise<void> {
    try {
      this.warmPromise = null;
      await this.warmInference();
      this.warmPromise = Promise.resolve();
    } catch (error) {
      this.toast(this.t(messageKey(error)), "err");
      this.paintModel();
    }
  }

  private download(format: string): void {
    if (!this.video) {
      this.toast(this.t("exportNeedVideo"), "err");
      return;
    }
    const slug = fileSlug(this.video.title);
    if (format === "srt") downloadTextFile(`${slug}.srt`, exportSrt(this.video.segments), "application/x-subrip");
    else if (format === "txt") downloadTextFile(`${slug}.txt`, exportTxt(this.video.title, this.video.url, this.video.segments), "text/plain");
    else if (format === "vtt") downloadTextFile(`${slug}.vtt`, exportVtt(this.video.segments), "text/vtt");
    else if (format === "md") {
      downloadTextFile(`${slug}.md`, exportMarkdown({
        title: this.video.title,
        url: this.video.url,
        segments: this.video.segments,
        insights: this.video.insights,
        study: this.video.study,
        chat: this.includeChat ? this.video.chat : null,
      }), "text/markdown");
    } else if (format === "anki") {
      if (!this.video.study?.flashcards.length) {
        this.toast(this.t("studyEmpty"), "err");
        return;
      }
      downloadTextFile(`${slug}-anki.csv`, exportAnkiCsv(this.video.study.flashcards), "text/csv");
    } else if (format === "study-md") {
      if (!this.video.study) {
        this.toast(this.t("studyEmpty"), "err");
        return;
      }
      downloadTextFile(`${slug}-study.md`, exportStudyMarkdown(this.video.title, this.video.study), "text/markdown");
    } else return;
    this.toast(this.t("downloadStarted"), "ok");
  }

  private async copyAll(): Promise<void> {
    if (!this.video) return;
    await this.copyValue(exportPlainTranscript(this.video.segments), "transcriptCopied");
  }

  private async copyValue(value: string, key: "transcriptCopied" | "segmentCopied" | "summaryCopied"): Promise<void> {
    try {
      await copyText(value);
      this.toast(this.t(key), "ok");
    } catch {
      this.toast(this.t("copyFailed"), "err");
    }
  }

  private moveMatch(delta: number): void {
    const matches = this.currentMatches();
    if (matches.length === 0) return;
    this.matchIndex = (this.matchIndex + delta + matches.length) % matches.length;
    this.paintTranscriptList();
    this.root.querySelector("mark.is-current")?.scrollIntoView({ block: "center" });
  }

  private currentMatches() {
    return this.video ? findMatches(this.video.segments, this.search) : [];
  }

  private stepCard(delta: number): void {
    const total = this.video?.study?.flashcards.length ?? 0;
    if (total === 0) return;
    this.cardIndex = (this.cardIndex + delta + total) % total;
    this.cardFlipped = false;
    this.paintStudy();
  }

  private setTab(tab: TabId): void {
    this.tab = tab;
    localSet(PREF_TAB, tab);
    for (const id of TABS) {
      const selected = id === tab;
      this.nodes.tabs[id].setAttribute("aria-selected", String(selected));
      this.nodes.tabs[id].tabIndex = selected ? 0 : -1;
      this.nodes.panels[id].hidden = !selected;
    }
  }

  private setFormError(message: string): void {
    this.formError = message;
    this.nodes.formError.hidden = false;
    this.nodes.formError.textContent = message;
  }

  private applyI18n(): void {
    this.root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((node) => {
      const key = node.dataset.i18n as MessageKey | undefined;
      if (key) node.textContent = this.t(key);
    });
    this.root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((node) => {
      const key = node.dataset.i18nPlaceholder as MessageKey | undefined;
      if (key) node.setAttribute("placeholder", this.t(key));
    });
    this.root.querySelectorAll<HTMLElement>("[data-i18n-label]").forEach((node) => {
      const key = node.dataset.i18nLabel as MessageKey | undefined;
      if (key) node.setAttribute("aria-label", this.t(key));
    });
    document.title = this.t("brand");
    this.paintProcess();
  }

  private paintProcess(): void {
    this.nodes.process.textContent = this.phase === "loading" ? this.t("processing") : this.t("process");
    this.nodes.process.disabled = this.phase === "loading";
    this.nodes.process.setAttribute("aria-busy", String(this.phase === "loading"));
  }

  private paintSession(): void {
    this.paintProcess();
    this.nodes.formError.hidden = !this.formError;
    if (this.formError) this.nodes.formError.textContent = this.formError;
    this.nodes.workspace.hidden = !this.video && this.phase !== "loading";
    const videoId = this.video?.videoId ?? null;
    if (videoId !== this.paintedVideoId) {
      // Recent videos stay out of the way while one is open; the user can still expand them.
      this.paintedVideoId = videoId;
      this.nodes.history.open = !this.video;
    }
    this.paintHistory();
    if (!this.video && this.phase === "loading") {
      this.paintSkeleton();
      return;
    }
    if (!this.video) return;
    this.nodes.videoTitle.textContent = this.video.title;
    this.nodes.videoMeta.textContent = [this.video.author, this.t("captionLanguage", { language: this.video.captionLanguage })]
      .filter(Boolean)
      .join(" · ");
    this.nodes.videoImage.src = this.video.thumbnailUrl;
    this.nodes.videoImage.alt = this.video.title;
    if (this.video.url) {
      this.nodes.videoLink.href = this.video.url;
      this.nodes.videoLink.hidden = false;
    } else this.nodes.videoLink.hidden = true;
    this.nodes.estimated.hidden = !this.video.timestampsEstimated;
    this.nodes.estimated.textContent = this.t("estimatedTimestamps");
    this.paintTranscriptList();
    this.paintInsights();
    this.paintChatLog();
    this.paintStudy();
  }

  private paintSkeleton(): void {
    clear(this.nodes.segmentList);
    for (let index = 0; index < 6; index += 1) {
      const bar = el("div", { class: index % 3 === 0 ? "skeleton short" : "skeleton" });
      bar.setAttribute("aria-hidden", "true");
      this.nodes.segmentList.append(bar);
    }
    this.nodes.segmentList.setAttribute("aria-busy", "true");
    this.nodes.segmentList.setAttribute("aria-label", this.t("loadingTranscript"));
  }

  private paintTranscriptList(): void {
    const matches = this.currentMatches();
    if (!this.search.trim()) this.nodes.searchMeta.textContent = "";
    else if (matches.length === 0) this.nodes.searchMeta.textContent = this.t("noMatches");
    else if (matches.length === 1) this.nodes.searchMeta.textContent = this.t("oneMatch");
    else this.nodes.searchMeta.textContent = `${this.t("manyMatches", { count: matches.length })} · ${this.t("matchPosition", { current: this.matchIndex + 1, total: matches.length })}`;
    clear(this.nodes.segmentList);
    this.nodes.segmentList.removeAttribute("aria-busy");
    if (!this.video) return;
    let seen = 0;
    for (const segment of this.video.segments) {
      const ranges = rangesForSegment(matches, segment.id);
      const text = el("div", {
        class: "segment-text",
        contenteditable: "true",
        role: "textbox",
        "aria-label": this.t("editSegment", { time: formatTimestamp(segment.start) }),
        "data-segment-id": segment.id,
      });
      appendHighlighted(text, segment.text, ranges, (mark) => {
        mark.dataset.matchIndex = String(seen);
        if (seen === this.matchIndex) mark.classList.add("is-current");
        seen += 1;
      });
      const row = el("article", { class: this.highlightedId === segment.id ? "segment is-active" : "segment", id: segment.id }, [
        el("button", {
          class: "time",
          type: "button",
          "data-action": "timestamp",
          "data-start": String(segment.start),
          "aria-label": this.t("openAt", { time: formatTimestamp(segment.start) }),
        }, [formatTimestamp(segment.start)]),
        text,
        el("button", {
          class: "btn btn-ghost",
          type: "button",
          "data-action": "copy-segment",
          "data-segment-id": segment.id,
          "aria-label": this.t("copySegment"),
        }, [this.t("copySegment")]),
      ]);
      this.nodes.segmentList.append(row);
    }
  }

  private paintInsights(): void {
    const button = this.nodes.insightsButton;
    const body = this.nodes.insightsBody;
    button.disabled = this.insightsBusy || !this.video;
    button.textContent = this.video?.insights ? this.t("regenerate") : this.t("generateInsights");
    // Once a summary exists, regenerating is a secondary action and should not compete with the text.
    button.className = this.video?.insights ? "btn btn-ghost" : "btn btn-primary btn-lg";
    this.nodes.insightsCopy.hidden = !this.video?.insights;
    this.nodes.insightsCopy.disabled = this.insightsBusy || !this.video?.insights;
    clear(body);
    if (this.insightsBusy) {
      body.append(
        el("p", { class: "summary-status", role: "status" }, [this.insightsProgress || this.t("summaryWorking")]),
        el("div", { class: "skeleton" }),
        el("div", { class: "skeleton" }),
        el("div", { class: "skeleton short" }),
      );
      return;
    }
    const insights = this.video?.insights;
    if (!insights) {
      body.append(el("p", { class: "muted" }, [this.t("insightsEmpty")]));
      return;
    }
    const article = el("article", { class: "summary" });
    if (insights.tldr) article.append(el("p", { class: "summary-overview" }, this.renderInline(parseInline(insights.tldr))));
    const items = summaryItems(insights);
    if (items.length) {
      // Numbered thematic blocks match YouTube's summary panel; times live inside the prose.
      const list = el("ol", { class: "key-points key-points-topics" });
      for (const item of items) {
        const inline = parseInline(item.text);
        const trailing =
          item.start === null || hasTimes([{ kind: "p", inline }])
            ? null
            : el("span", { class: "ts-group" }, [" (", this.timeLink(item.start), ")"]);
        list.append(el("li", {}, [
          item.title ? el("strong", {}, [`${item.title}: `]) : null,
          ...this.renderInline(inline),
          trailing,
        ]));
      }
      article.append(el("section", { class: "summary-section" }, [el("h2", {}, [this.t("takeaways")]), list]));
    }
    if (insights.chapters.length) {
      const list = el("ul", { class: "key-points" });
      for (const chapter of insights.chapters) {
        list.append(el("li", {}, [this.timeLink(chapter.start), " ", chapter.title]));
      }
      article.append(el("section", { class: "summary-section" }, [el("h2", {}, [this.t("chapters")]), list]));
    }
    if (insights.followUps.length) {
      const list = el("div", { class: "suggestions" });
      for (const question of insights.followUps) {
        list.append(el("button", { class: "chip", type: "button", "data-action": "followup", "data-question": question }, [question]));
      }
      article.append(el("section", { class: "summary-section" }, [el("h2", {}, [this.t("followUps")]), list]));
    }
    if (insights.engine) {
      const engine = insights.engine === "local" ? this.t("engineLocal") : insights.engine;
      article.append(el("p", { class: "summary-meta" }, [this.t("summaryFrom", { engine })]));
    }
    body.append(article);
  }

  private timeLink(seconds: number, label = formatTimestamp(seconds)): HTMLButtonElement {
    return el("button", {
      class: "ts",
      type: "button",
      "data-action": "timestamp",
      "data-start": String(seconds),
      "aria-label": this.t("openAt", { time: label }),
    }, [label]);
  }

  private renderInline(parts: RichInline[]): Array<Node | string> {
    return parts.map((part) => {
      if (part.kind === "strong") return el("strong", {}, [part.value]);
      if (part.kind === "em") return el("em", {}, [part.value]);
      if (part.kind === "time") return this.timeLink(part.seconds, part.label);
      return part.value;
    });
  }

  private renderRich(blocks: RichBlock[]): HTMLElement[] {
    return blocks.map((block) => {
      if ("items" in block) {
        return el(block.kind, {}, block.items.map((item) => el("li", {}, this.renderInline(item))));
      }
      return el(block.kind === "h" ? "h3" : "p", {}, this.renderInline(block.inline));
    });
  }

  private paintChatLog(): void {
    clear(this.nodes.chatLog);
    if (!this.video || this.video.chat.length === 0) {
      this.nodes.chatLog.append(el("p", { class: "muted" }, [this.t("chatEmpty")]));
      return;
    }
    for (const message of this.video.chat) {
      const label = el("h3", { class: "visually-hidden" }, [message.role === "user" ? this.t("you") : this.t("assistant")]);
      if (message.role === "user") {
        this.nodes.chatLog.append(el("article", { class: "msg user" }, [label, el("p", {}, [message.content])]));
        continue;
      }
      const blocks = parseRichText(message.content);
      const body = el("div", { class: "msg-body" }, [label, ...this.renderRich(blocks)]);
      const bubble = el("article", { class: "msg assistant" }, [
        el("span", { class: "msg-mark", "aria-hidden": "true" }, ["✦"]),
        body,
      ]);
      // Answers that already link their moments inline do not need a second row of the same timestamps.
      if (message.citations.length && !hasTimes(blocks)) {
        const cites = el("div", { class: "citations" }, [
          el("span", { class: "muted" }, [message.insufficient ? this.t("excerptsChecked") : this.t("sources")]),
        ]);
        for (const citation of message.citations) {
          const label = citation.end > citation.start + 0.5
            ? `${formatTimestamp(citation.start)}–${formatTimestamp(citation.end)}`
            : formatTimestamp(citation.start);
          cites.append(el("button", {
            class: "citation",
            type: "button",
            "data-action": "citation",
            "data-segment-id": citation.segmentId ?? "",
            title: citation.quote,
          }, [label]));
        }
        body.append(cites);
      }
      this.nodes.chatLog.append(bubble);
    }
    if (this.chatBusy) this.nodes.chatLog.append(el("div", { class: "skeleton" }), el("div", { class: "skeleton short" }));
  }

  private paintStudy(): void {
    this.nodes.studyButton.disabled = this.studyBusy || !this.video;
    this.nodes.studyButton.textContent = this.video?.study ? this.t("regenerate") : this.t("generateStudy");
    clear(this.nodes.studyBody);
    if (this.studyBusy) {
      this.nodes.studyBody.append(el("div", { class: "skeleton" }), el("div", { class: "skeleton" }));
      return;
    }
    const study = this.video?.study;
    if (!study) {
      this.nodes.studyBody.append(el("p", { class: "muted" }, [this.t("studyEmpty")]));
      return;
    }
    if (study.flashcards.length) {
      const card = study.flashcards[this.cardIndex] ?? study.flashcards[0];
      this.nodes.studyBody.append(el("section", {}, [
        el("h3", {}, [this.t("flashcards")]),
        el("p", { class: "muted" }, [this.t("cardProgress", { current: this.cardIndex + 1, total: study.flashcards.length })]),
        el("button", { class: "card-face", type: "button", "data-action": "flip-card" }, [this.cardFlipped ? card.back : card.front]),
        el("div", { class: "card-nav" }, [
          el("button", { class: "btn btn-ghost", type: "button", "data-action": "prev-card", "data-i18n": "prevCard" }, [this.t("prevCard")]),
          el("button", { class: "btn btn-ghost", type: "button", "data-action": "flip-card" }, [this.cardFlipped ? this.t("hideAnswer") : this.t("showAnswer")]),
          el("button", { class: "btn btn-ghost", type: "button", "data-action": "next-card" }, [this.t("nextCard")]),
        ]),
      ]));
    }
    if (study.quiz.length) {
      const question = study.quiz[this.quizIndex] ?? study.quiz[0];
      const choices = el("div", { role: "radiogroup", "aria-label": this.t("choiceGroup") });
      question.choices.forEach((choice, index) => {
        let className = "choice";
        if (this.quizChecked && index === question.answerIndex) className += " is-correct";
        if (this.quizChecked && index === this.quizChoice && index !== question.answerIndex) className += " is-wrong";
        choices.append(el("button", {
          class: className,
          type: "button",
          role: "radio",
          "aria-checked": String(this.quizChoice === index),
          "data-action": "quiz-choice",
          "data-choice": String(index),
        }, [`${String.fromCharCode(65 + index)}) ${choice}`]));
      });
      const feedback = this.quizChecked
        ? el("p", {}, [this.quizChoice === question.answerIndex ? this.t("correct") : this.t("incorrect"), " ", question.explanation])
        : null;
      this.nodes.studyBody.append(el("section", {}, [
        el("h3", {}, [this.t("quiz")]),
        el("p", { class: "muted" }, [this.t("questionProgress", { current: this.quizIndex + 1, total: study.quiz.length })]),
        el("p", {}, [question.prompt]),
        choices,
        feedback,
        el("div", { class: "quiz-nav" }, [
          el("button", { class: "btn btn-primary", type: "button", "data-action": "check-quiz" }, [this.t("checkAnswer")]),
          el("button", { class: "btn btn-ghost", type: "button", "data-action": "next-quiz" }, [this.t("nextQuestion")]),
        ]),
      ]));
    }
  }

  private paintHistory(): void {
    clear(this.nodes.historyList);
    if (this.confirmClear) {
      this.nodes.historyList.append(el("div", { class: "inline" }, [
        el("p", {}, [this.t("confirmClear")]),
        el("button", { class: "btn btn-danger", type: "button", "data-action": "confirm-clear" }, [this.t("clearHistory")]),
        el("button", { class: "btn btn-ghost", type: "button", "data-action": "cancel-clear" }, [this.t("cancel")]),
      ]));
    }
    if (this.history.length === 0) {
      this.nodes.historyList.append(el("p", { class: "muted" }, [this.t("recentEmpty")]));
      return;
    }
    for (const record of this.history) {
      const date = new Intl.DateTimeFormat(this.locale, { dateStyle: "medium", timeStyle: "short" }).format(record.processedAt);
      const body = el("div", {}, [
        el("h3", {}, [record.title]),
        el("p", { class: "muted" }, [
          this.t("processedOn", { date }),
          " · ",
          this.t("captionLanguage", { language: record.captionLanguage }),
          " · ",
          record.segments.length ? this.t("savedInBrowser") : this.t("transcriptEmpty"),
        ]),
      ]);
      if (this.confirmDeleteId === record.videoId) {
        body.append(el("div", { class: "inline" }, [
          el("span", {}, [this.t("confirmDelete")]),
          el("button", { class: "btn btn-danger", type: "button", "data-action": "confirm-delete", "data-video-id": record.videoId }, [this.t("deleteSaved")]),
          el("button", { class: "btn btn-ghost", type: "button", "data-action": "cancel-delete" }, [this.t("cancel")]),
        ]));
      } else {
        body.append(el("div", { class: "inline" }, [
          el("button", { class: "btn btn-primary", type: "button", "data-action": "open-history", "data-video-id": record.videoId }, [this.t("openSaved")]),
          el("button", { class: "btn btn-ghost", type: "button", "data-action": "delete-history", "data-video-id": record.videoId }, [this.t("deleteSaved")]),
        ]));
      }
      const image = el("img", { alt: "", width: "120", height: "68" });
      if (record.thumbnailUrl) image.src = record.thumbnailUrl;
      image.alt = record.title;
      this.nodes.historyList.append(el("article", { class: "history-card" }, [image, body]));
    }
  }

  private paintModel(): void {
    const phase = this.model.phase;
    const place = this.model.device === "webgpu"
      ? (this.model.gpuLabel || this.t("deviceWebgpu"))
      : this.model.device === "wasm"
        ? this.t("deviceWasm")
        : this.model.gpuLabel;
    this.nodes.modelPill.dataset.phase = phase;
    let label = this.t("modelIdle");
    if (phase === "idle" && place) label = `${this.t("modelIdle")} · ${place}`;
    if (phase === "checking") label = place ? `${this.t("modelChecking")} · ${place}` : this.t("modelChecking");
    if (phase === "downloading") {
      label = this.model.progress === null ? this.t("modelDownloading") : `${this.t("modelDownloading")} ${Math.round(this.model.progress)}%`;
    }
    if (phase === "loading") label = place ? `${this.t("modelLoading")} · ${place}` : this.t("modelLoading");
    if (phase === "ready") label = place ? `${this.t("modelReady")} · ${place}` : this.t("modelReady");
    if (phase === "generating") label = this.t("modelGenerating");
    if (phase === "error") label = this.t("modelError");
    this.nodes.settingsStatus.textContent = label;
    if (remoteEnabled(this.remote)) {
      label = `${this.t("modelApi")} · ${this.remote.model}`;
      this.nodes.modelPill.dataset.phase = "ready";
    }
    this.nodes.modelPill.textContent = label;
    if (this.model.device === "webgpu") {
      this.nodes.deviceValue.textContent = this.model.gpuLabel
        ? `${this.t("deviceWebgpu")} · ${this.model.gpuLabel}`
        : this.t("deviceWebgpu");
    } else if (this.model.device === "wasm") {
      this.nodes.deviceValue.textContent = this.t("deviceWasm");
    } else {
      this.nodes.deviceValue.textContent = this.model.gpuLabel || "—";
    }
    const gpuMissing = typeof navigator === "undefined" || !("gpu" in navigator);
    this.nodes.fallback.hidden = this.model.device !== "wasm";
    if (this.model.fellBackFromGpu && this.model.gpuLabel) {
      this.nodes.fallback.textContent = this.t("gpuStartFailed", { name: this.model.gpuLabel });
    } else {
      this.nodes.fallback.textContent = gpuMissing ? this.t("webgpuFallback") : this.t("wasmFallback");
    }
  }

  private async refreshCacheLabel(): Promise<void> {
    try {
      const usage = await this.model.cacheUsage();
      const used = usage.modelBytes ?? usage.usageBytes;
      if (used && usage.quotaBytes) this.nodes.cacheValue.textContent = `${formatMegabytes(used)} MB / ${formatMegabytes(usage.quotaBytes)} MB`;
      else this.nodes.cacheValue.textContent = this.t("cacheUnknown");
    } catch {
      this.nodes.cacheValue.textContent = this.t("cacheFailed");
    }
  }

  private async refreshHistory(): Promise<void> {
    try {
      this.history = await listVideos();
    } catch {
      this.history = [];
      this.toast(this.t("cacheFailed"), "err");
    }
    this.paintHistory();
  }

  private async persist(): Promise<void> {
    if (!this.video) return;
    try {
      await saveVideo(this.video);
    } catch {
      this.toast(this.t("cacheFailed"), "err");
    }
  }

  private toast(message: string, kind: "ok" | "err"): void {
    const item = el("div", { class: kind === "err" ? "toast err" : "toast", role: "status" }, [message]);
    this.nodes.toasts.append(item);
    window.setTimeout(() => item.remove(), 4200);
  }
}

interface Shell {
  url: HTMLInputElement;
  formError: HTMLElement;
  process: HTMLButtonElement;
  paste: HTMLDetailsElement;
  pasteInput: HTMLTextAreaElement;
  file: HTMLInputElement;
  segmentList: HTMLElement;
  search: HTMLInputElement;
  searchMeta: HTMLElement;
  estimated: HTMLElement;
  videoTitle: HTMLElement;
  videoMeta: HTMLElement;
  videoLink: HTMLAnchorElement;
  videoImage: HTMLImageElement;
  insightsBody: HTMLElement;
  insightsButton: HTMLButtonElement;
  insightsCopy: HTMLButtonElement;
  themeButton: HTMLButtonElement;
  chatLog: HTMLElement;
  chatInput: HTMLTextAreaElement;
  studyBody: HTMLElement;
  studyButton: HTMLButtonElement;
  modelPill: HTMLElement;
  history: HTMLDetailsElement;
  historyList: HTMLElement;
  includeChat: HTMLInputElement;
  dialog: HTMLDialogElement;
  cacheValue: HTMLElement;
  deviceValue: HTMLElement;
  fallback: HTMLElement;
  apiUrl: HTMLInputElement;
  apiModel: HTMLInputElement;
  apiKey: HTMLInputElement;
  apiStatus: HTMLElement;
  settingsStatus: HTMLElement;
  tabs: Record<TabId, HTMLButtonElement>;
  panels: Record<TabId, HTMLElement>;
  workspace: HTMLElement;
  toasts: HTMLElement;
}

/** Takeaways and chapters carry an optional leading [mm:ss] stamp. */
function splitStamp(item: string): { start: number | null; text: string } {
  const match = item.match(CLOCK_PREFIX);
  if (!match) return { start: null, text: item };
  return { start: parseClock(match[1]), text: item.slice(match[0].length) };
}

interface SummaryItem {
  start: number | null;
  title: string;
  text: string;
}

/** API summaries carry titled key moments; local summaries carry timestamped sentences. */
function summaryItems(insights: Insights): SummaryItem[] {
  if (insights.points?.length) {
    return insights.points.map((point) => ({ start: point.start, title: point.title, text: point.text }));
  }
  return insights.takeaways.map((item) => {
    const { start, text } = splitStamp(item);
    return { start, title: "", text };
  });
}

function summaryAsText(insights: Insights, heading = ""): string {
  const lines = insights.tldr ? [insights.tldr, ""] : [];
  const items = summaryItems(insights);
  if (heading && items.length) lines.push(`**${heading}**`);
  for (const item of items) {
    const title = item.title ? `**${item.title}:** ` : "";
    const stamp = item.start === null ? "" : ` (${formatTimestamp(item.start)})`;
    lines.push(`- ${title}${item.text}${stamp}`);
  }
  return lines.join("\n").trim();
}

function citationsFromSummary(insights: Insights, segments: TranscriptSegment[]): Citation[] {
  const citations: Citation[] = [];
  for (const item of summaryItems(insights)) {
    if (item.start === null) continue;
    citations.push({ start: item.start, end: item.start + 5, quote: item.text.slice(0, 140), segmentId: nearestSegment(segments, item.start)?.id });
  }
  return citations.slice(0, 8);
}

/** Citations for an API answer: each [mm:ss] it wrote, matched to the nearest transcript line. */
function citationsFromText(text: string, segments: TranscriptSegment[]): Citation[] {
  const seen = new Set<number>();
  const citations: Citation[] = [];
  for (const start of timestampsIn(text)) {
    if (seen.has(start)) continue;
    seen.add(start);
    const segment = nearestSegment(segments, start);
    if (!segment) continue;
    citations.push({ start, end: start + 5, quote: segment.text.slice(0, 140), segmentId: segment.id });
  }
  return citations.slice(0, 8);
}

function feature(title: MessageKey, body: MessageKey): HTMLElement {
  return el("article", { class: "feature" }, [
    el("h2", { "data-i18n": title }),
    el("p", { "data-i18n": body }),
  ]);
}

function tabKey(id: TabId): MessageKey {
  if (id === "transcript") return "tabTranscript";
  if (id === "insights") return "tabInsights";
  if (id === "chat") return "tabChat";
  if (id === "study") return "tabStudy";
  return "tabExport";
}


function toRecord(fetched: FetchedTranscript): VideoRecord {
  return {
    ...fetched,
    processedAt: Date.now(),
    insights: null,
    study: null,
    chat: [],
  };
}

function messageKey(error: unknown): MessageKey {
    if (!isStudioError(error)) return "networkError";
  switch (error.code) {
    case "no-captions":
      return "noCaptions";
    case "unsupported-language":
      return "unsupportedLanguage";
    case "cors-blocked":
      return "corsBlocked";
    case "extension-permission":
      return "extensionPermission";
    case "remote-unreachable":
      return "apiUnreachable";
    case "remote-api":
      return "apiFailed";
    case "model-download":
      return "modelDownloadFailed";
    case "cache":
      return "cacheFailed";
    case "invalid-url":
      return "urlInvalid";
    case "empty-transcript":
      return "pasteEmpty";
    default:
      return "networkError";
  }
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
