import type { Locale, TabId, Theme } from "../types";

export const PREF_LANGUAGE = "yts.language";
export const PREF_TAB = "yts.tab";
export const PREF_INCLUDE_CHAT = "yts.includeChat";
export const PREF_THEME = "yts.theme";
export const PREF_API_URL = "yts.api.url";
export const PREF_API_MODEL = "yts.api.model";
export const PREF_API_KEY = "yts.api.key";

const TABS: TabId[] = ["insights", "transcript", "chat", "study", "export"];

export function detectLocale(language: string | null | undefined): Locale {
  const value = (language ?? "").toLowerCase();
  if (value.startsWith("pt")) return "pt-BR";
  if (value.startsWith("es")) return "es";
  return "en";
}

export function readStoredLocale(language: string | null | undefined): Locale | null {
  if (language === "en" || language === "pt-BR" || language === "es") return language;
  return null;
}

export function readStoredTab(value: string | null | undefined): TabId | null {
  return TABS.find((tab) => tab === value) ?? null;
}

export function localGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function localSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked in private modes. The session still works.
  }
}

export function initialLocale(): Locale {
  return readStoredLocale(localGet(PREF_LANGUAGE)) ?? detectLocale(navigator.language);
}

export function initialTab(): TabId {
  return readStoredTab(localGet(PREF_TAB)) ?? "insights";
}

/** Dark is the default; light is only used when the user picked it. */
export function initialTheme(): Theme {
  return localGet(PREF_THEME) === "light" ? "light" : "dark";
}

export interface StoredRemote {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Empty URL means "no API": the app then uses the in-browser model. */
export function readStoredRemote(): StoredRemote {
  return {
    baseUrl: localGet(PREF_API_URL) ?? "",
    model: localGet(PREF_API_MODEL) ?? "",
    apiKey: localGet(PREF_API_KEY) ?? "",
  };
}

export function writeStoredRemote(value: StoredRemote): void {
  localSet(PREF_API_URL, value.baseUrl.trim());
  localSet(PREF_API_MODEL, value.model.trim());
  localSet(PREF_API_KEY, value.apiKey.trim());
}