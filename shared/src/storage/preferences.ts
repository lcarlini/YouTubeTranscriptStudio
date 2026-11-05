import type { Locale, TabId, Theme } from "../types";
import type { RemoteProvider } from "../ai/remote";

export const PREF_LANGUAGE = "yts.language";
export const PREF_TAB = "yts.tab";
export const PREF_INCLUDE_CHAT = "yts.includeChat";
export const PREF_THEME = "yts.theme";
export const PREF_PROFILES = "yts.profiles";
export const PREF_ACTIVE_PROFILE = "yts.profile.active";
/** Legacy single-API keys, read only to migrate them into a profile. */
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

export interface AiProfile {
  id: string;
  name: string;
  provider: RemoteProvider;
  /** OpenAI-compatible servers only (for example Ollama). */
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Profile id meaning "use the in-browser model". */
export const BROWSER_PROFILE = "";

const PROVIDERS: RemoteProvider[] = ["openai", "anthropic"];

export function newProfileId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeProfile(value: unknown): AiProfile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Record<keyof AiProfile, unknown>>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const provider = PROVIDERS.find((item) => item === raw.provider) ?? "openai";
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Profile",
    provider,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "",
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
  };
}

/**
 * Saved AI profiles. Before profiles existed, one API was stored in three keys;
 * that is turned into a single "Local (Ollama)" profile the first time it is read.
 */
export function readProfiles(): AiProfile[] {
  const raw = localGet(PREF_PROFILES);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map(sanitizeProfile).filter((item): item is AiProfile => item !== null);
      }
    } catch {
      // Corrupt value: fall back to an empty list rather than breaking the app.
    }
    return [];
  }
  const legacyUrl = localGet(PREF_API_URL)?.trim() ?? "";
  if (!legacyUrl) return [];
  const migrated: AiProfile = {
    id: newProfileId(),
    name: "Local (Ollama)",
    provider: "openai",
    baseUrl: legacyUrl,
    model: localGet(PREF_API_MODEL)?.trim() ?? "",
    apiKey: localGet(PREF_API_KEY)?.trim() ?? "",
  };
  writeProfiles([migrated]);
  return [migrated];
}

export function writeProfiles(profiles: AiProfile[]): void {
  localSet(PREF_PROFILES, JSON.stringify(profiles));
}

export function readActiveProfileId(): string {
  return localGet(PREF_ACTIVE_PROFILE) ?? BROWSER_PROFILE;
}

export function writeActiveProfileId(id: string): void {
  localSet(PREF_ACTIVE_PROFILE, id);
}