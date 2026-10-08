import type { Locale, TabId } from "../types";

export const PREF_LANGUAGE = "yts.language";
export const PREF_TAB = "yts.tab";
export const PREF_INCLUDE_CHAT = "yts.includeChat";

const TABS: TabId[] = ["transcript", "insights", "chat", "study", "export"];

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
  return readStoredTab(localGet(PREF_TAB)) ?? "transcript";
}
