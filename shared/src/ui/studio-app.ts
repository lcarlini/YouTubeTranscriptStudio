import {
  CHAT_SYSTEM,
  INSIGHTS_SYSTEM,
  MERGE_SYSTEM,
  STUDY_SYSTEM,
  buildChatUserPrompt,
  buildInsightsUserPrompt,
  buildMergeUserPrompt,
  buildStudyUserPrompt,
} from "../ai/prompts";
import { buildProcessingChunks, condenseTranscript } from "../ai/chunk";
import { LocalModelClient } from "../ai/client";
import { mergeInsights, parseChatResponse, parseInsights, parseStudyPack } from "../ai/parse-model";
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
import { isStudioError } from "../errors";
import type { MessageKey } from "../i18n";
import { translate } from "../i18n";
import { clearVideos, deleteVideo, listVideos, saveVideo } from "../storage/history";
import {
  PREF_INCLUDE_CHAT,
  PREF_LANGUAGE,
  PREF_TAB,
  initialLocale,
  initialTab,
  localGet,
  localSet,
} from "../storage/preferences";
import { findMatches, rangesForSegment } from "../transcript/search";
import { parsePlainTranscript } from "../transcript/parse";
import { formatTimestamp } from "../transcript/time";
import type { ChatMessage, Citation, TabId, VideoRecord } from "../types";
import { fetchYouTubeTranscript, preferredCaptionLanguages } from "../youtube/fetch-transcript";
import type { FetchedTranscript } from "../youtube/fetch-transcript";
import { canonicalWatchUrl, parseYouTubeVideoId, thumbnailUrl } from "../youtube/url";
import { appendHighlighted, clear, copyText, el, formatMegabytes, isEditableTarget } from "./dom";

const TABS: TabId[] = ["transcript", "insights", "chat", "study", "export"];
const REPO = "https://github.com/lcarlini/YouTubeTranscriptStudio";
const PAGES = "https://lcarlini.github.io/YouTubeTranscriptStudio/";

export interface StudioHost {
  mode: "web" | "extension";
  devProxy: boolean;
  wasmPaths?: string;
  getContextVideo: () => Promise<string | null>;
  openAtTimestamp: (videoId: string, seconds: number) => void;
  tryExtensionFetch?: (videoId: string, languages: string[]) => Promise<FetchedTranscript | null>;
  onLocaleChange?: (locale: "en" | "pt-BR" | "es") => void;
}

export function mountStudio(root: HTMLElement, host: StudioHost): void {
  new StudioApp(root, host);
}

class StudioApp {
  private locale = initialLocale();
  private tab = initialTab();
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
  private readonly nodes: Shell;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: StudioHost,
  ) {
    localSet(PREF_LANGUAGE, this.locale);
    document.documentElement.lang = this.locale;
    this.nodes = this.build();
    this.model = new LocalModelClient(() => this.paintModel(), host.wasmPaths);
    this.applyI18n();
    this.setTab(this.tab);
    this.paintModel();
    this.bind();
    void this.refreshHistory();
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
    const chatInput = el("textarea", { "data-i18n-placeholder": "askPlaceholder" });
    const studyBody = el("div", { class: "stack" });
    const modelPill = el("p", { class: "model-pill", role: "status", "data-i18n-label": "statusLabel" });
    const historyList = el("div", { class: "history-list" });
    const includeChat = el("input", { type: "checkbox" });
    includeChat.checked = this.includeChat;
    const dialog = el("dialog");
    const cacheValue = el("strong");
    const deviceValue = el("strong");
    const fallback = el("p", { class: "muted" });
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
    panels.insights.append(
      el("div", { class: "toolbar" }, [
        el("button", { class: "btn btn-primary", type: "button", "data-action": "insights", "data-i18n": "generateInsights" }),
      ]),
      insightsBody,
    );
    panels.chat.append(
      chatLog,
      el("div", { class: "inline" }, [
        el("span", { class: "muted", "data-i18n": "suggestions" }),
        ...(["suggestSummary", "suggestTopics", "suggestExplain", "suggestStudy"] as const).map((key) =>
          el("button", { class: "btn btn-ghost", type: "button", "data-action": "suggest", "data-suggest": key, "data-i18n": key }),
        ),
      ]),
      el("form", { class: "composer" }, [
        el("label", { class: "field" }, [
          el("span", { "data-i18n": "askLabel" }),
          chatInput,
        ]),
        el("button", { class: "btn btn-primary", type: "submit", "data-i18n": "send" }),
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
        el("p", { "data-i18n": "settingsIntro" }),
        el("p", {}, [el("span", { "data-i18n": "statusLabel" }), " ", el("strong", { class: "settings-status" })]),
        el("p", {}, [el("span", { "data-i18n": "modelDevice" }), " ", deviceValue]),
        fallback,
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
    this.root.append(
      el("a", { class: "skip", href: "#content", "data-i18n": "skip" }),
      el("header", { class: "topbar" }, [
        el("a", { class: "brand", href: "#content" }, [
          el("span", { class: "brand-mark", "aria-hidden": "true" }, ["YT"]),
          el("span", { class: "brand-name", "data-i18n": "brand" }),
        ]),
        el("div", { class: "top-actions" }, [
          modelPill,
          el("label", { class: "lang" }, [
            el("span", { "data-i18n": "languageLabel" }),
            el("select", { "data-i18n-label": "languageLabel" }, [
              el("option", { value: "en" }, ["English"]),
              el("option", { value: "pt-BR" }, ["Português (Brasil)"]),
              el("option", { value: "es" }, ["Español"]),
            ]),
          ]),
          el("button", { class: "btn btn-ghost", type: "button", "data-action": "settings", "data-i18n": "settings" }),
          el("a", { class: "btn btn-ghost", href: REPO, target: "_blank", rel: "noreferrer", "data-i18n": "github" }),
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
          el("section", { class: "history" }, [
            el("div", { class: "toolbar" }, [
              el("h2", { "data-i18n": "recentTitle" }),
              el("button", { class: "btn btn-ghost", type: "button", "data-action": "clear-history", "data-i18n": "clearHistory" }),
            ]),
            el("p", { class: "muted", "data-i18n": "historyNote" }),
            historyList,
          ]),
          workspace,
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
      chatLog,
      chatInput,
      studyBody,
      studyButton: panels.study.querySelector("[data-action='study']") as HTMLButtonElement,
      modelPill,
      historyList,
      includeChat,
      dialog,
      cacheValue,
      deviceValue,
      fallback,
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
      let fetched = this.host.tryExtensionFetch ? await this.host.tryExtensionFetch(videoId, languages) : null;
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
      await this.persist();
      await this.refreshHistory();
      this.toast(this.t("savedInBrowser"), "ok");
      void this.warmModel();
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
    void this.warmModel();
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

  private async runInsights(): Promise<void> {
    if (!this.video || this.insightsBusy) return;
    this.insightsBusy = true;
    this.paintInsights();
    try {
      const chunks = buildProcessingChunks(this.video.segments);
      const partials = [];
      for (const chunk of chunks) {
        const raw = await this.model.generate(INSIGHTS_SYSTEM, buildInsightsUserPrompt(chunk.text), 420);
        const parsed = parseInsights(raw);
        if (parsed) partials.push(parsed);
      }
      if (partials.length === 0) throw new Error("empty insights");
      let merged = mergeInsights(partials);
      if (partials.length > 1) {
        const notes = partials.map((part, index) => `Part ${index + 1}\nTLDR: ${part.tldr}\nTAKEAWAYS:\n${part.takeaways.map((item) => `- ${item}`).join("\n")}`).join("\n\n");
        const combined = parseInsights(await this.model.generate(MERGE_SYSTEM, buildMergeUserPrompt(notes), 480));
        if (combined) merged = combined;
      }
      this.video.insights = merged;
      await this.persist();
    } catch (error) {
      this.toast(this.t(isStudioError(error) ? messageKey(error) : "insightsFailed"), "err");
    } finally {
      this.insightsBusy = false;
      this.paintInsights();
    }
  }

  private async runStudy(): Promise<void> {
    if (!this.video || this.studyBusy) return;
    this.studyBusy = true;
    this.paintStudy();
    try {
      const notes = [this.video.insights?.tldr ?? "", ...(this.video.insights?.takeaways ?? []), condenseTranscript(this.video.segments, 1800)]
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
      const excerpts = retrieveSegments(this.video.segments, question);
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

  private async warmModel(): Promise<void> {
    try {
      await this.model.ensureLoaded();
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

  private async copyValue(value: string, key: "transcriptCopied" | "segmentCopied"): Promise<void> {
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
    button.disabled = this.insightsBusy || !this.video;
    button.textContent = this.video?.insights ? this.t("regenerate") : this.t("generateInsights");
    clear(this.nodes.insightsBody);
    if (this.insightsBusy) {
      this.nodes.insightsBody.append(el("div", { class: "skeleton" }), el("div", { class: "skeleton" }), el("div", { class: "skeleton short" }));
      return;
    }
    const insights = this.video?.insights;
    if (!insights) {
      this.nodes.insightsBody.append(el("p", { class: "muted" }, [this.t("insightsEmpty")]));
      return;
    }
    if (insights.tldr) this.nodes.insightsBody.append(el("section", {}, [el("h3", {}, [this.t("tldr")]), el("p", {}, [insights.tldr])]));
    this.nodes.insightsBody.append(bulletSection(this.t("takeaways"), insights.takeaways));
    if (insights.chapters.length) {
      const list = el("div", { class: "inline" });
      for (const chapter of insights.chapters) {
        list.append(el("button", { class: "btn btn-ghost", type: "button", "data-action": "timestamp", "data-start": String(chapter.start) }, [
          `${formatTimestamp(chapter.start)} ${chapter.title}`,
        ]));
      }
      this.nodes.insightsBody.append(el("section", {}, [el("h3", {}, [this.t("chapters")]), list]));
    }
    if (insights.glossary.length) {
      const list = el("div");
      for (const entry of insights.glossary) {
        const row = el("p", { class: "term" });
        row.append(el("strong", {}, [`${entry.term}: `]), entry.definition);
        list.append(row);
      }
      this.nodes.insightsBody.append(el("section", {}, [el("h3", {}, [this.t("glossary")]), list]));
    }
    const actions = insights.actionItems.filter((item) => !/^(none|n\/a|nenhuma|nenhum|ninguna|ninguno)\b/i.test(item.trim()));
    this.nodes.insightsBody.append(actions.length ? bulletSection(this.t("actions"), actions) : el("section", {}, [el("h3", {}, [this.t("actions")]), el("p", { class: "muted" }, [this.t("noActions")])]));
    if (insights.followUps.length) {
      const list = el("div", { class: "inline" });
      for (const question of insights.followUps) {
        list.append(el("button", { class: "btn btn-ghost", type: "button", "data-action": "followup", "data-question": question }, [question]));
      }
      this.nodes.insightsBody.append(el("section", {}, [el("h3", {}, [this.t("followUps")]), list]));
    }
  }

  private paintChatLog(): void {
    clear(this.nodes.chatLog);
    if (!this.video || this.video.chat.length === 0) {
      this.nodes.chatLog.append(el("p", { class: "muted" }, [this.t("chatEmpty")]));
      return;
    }
    for (const message of this.video.chat) {
      const bubble = el("article", { class: message.role === "user" ? "bubble user" : "bubble" }, [
        el("h3", {}, [message.role === "user" ? this.t("you") : this.t("assistant")]),
        el("p", {}, [message.content]),
      ]);
      if (message.citations.length) {
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
        bubble.append(cites);
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
    this.nodes.modelPill.dataset.phase = phase;
    let label = this.t("modelIdle");
    if (phase === "checking") label = this.t("modelChecking");
    if (phase === "downloading") {
      label = this.model.progress === null ? this.t("modelDownloading") : `${this.t("modelDownloading")} ${Math.round(this.model.progress)}%`;
    }
    if (phase === "loading") label = this.t("modelLoading");
    if (phase === "ready") label = this.model.device ? `${this.t("modelReady")} · ${this.model.device === "webgpu" ? this.t("deviceWebgpu") : this.t("deviceWasm")}` : this.t("modelReady");
    if (phase === "generating") label = this.t("modelGenerating");
    if (phase === "error") label = this.t("modelError");
    this.nodes.modelPill.textContent = label;
    this.nodes.settingsStatus.textContent = label;
    this.nodes.deviceValue.textContent = this.model.device === "webgpu" ? this.t("deviceWebgpu") : this.model.device === "wasm" ? this.t("deviceWasm") : "—";
    const gpuMissing = typeof navigator === "undefined" || !("gpu" in navigator);
    this.nodes.fallback.hidden = this.model.device !== "wasm";
    this.nodes.fallback.textContent = gpuMissing ? this.t("webgpuFallback") : this.t("wasmFallback");
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
  chatLog: HTMLElement;
  chatInput: HTMLTextAreaElement;
  studyBody: HTMLElement;
  studyButton: HTMLButtonElement;
  modelPill: HTMLElement;
  historyList: HTMLElement;
  includeChat: HTMLInputElement;
  dialog: HTMLDialogElement;
  cacheValue: HTMLElement;
  deviceValue: HTMLElement;
  fallback: HTMLElement;
  settingsStatus: HTMLElement;
  tabs: Record<TabId, HTMLButtonElement>;
  panels: Record<TabId, HTMLElement>;
  workspace: HTMLElement;
  toasts: HTMLElement;
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

function bulletSection(title: string, items: string[]): HTMLElement {
  const list = el("ul");
  for (const item of items) list.append(el("li", {}, [item]));
  return el("section", {}, [el("h3", {}, [title]), items.length ? list : el("p", { class: "muted" }, ["—"])]);
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
