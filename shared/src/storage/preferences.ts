import type { Accent, Appearance, Contrast, Density, Locale, Motion, TabId, Theme } from "../types";
import type { RemoteProvider } from "../ai/remote";

export const PREF_LANGUAGE = "yts.language";
export const PREF_TAB = "yts.tab";
export const PREF_INCLUDE_CHAT = "yts.includeChat";
export const PREF_THEME = "yts.theme";
export const PREF_ACCENT = "yts.accent";
export const PREF_DENSITY = "yts.density";
export const PREF_CONTRAST = "yts.contrast";
export const PREF_MOTION = "yts.motion";
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

const THEMES: Theme[] = ["blue", "white", "black"];
const ACCENTS: Accent[] = ["blue", "teal", "violet", "amber", "rose"];
const DENSITIES: Density[] = ["comfortable", "compact"];
const CONTRASTS: Contrast[] = ["standard", "more"];
const MOTIONS: Motion[] = ["on", "off"];

/** Blue (dark) is the default. Values saved by version 1.0 ("dark" / "light") still work. */
export function readStoredTheme(value: string | null | undefined): Theme {
  if (value === "light") return "white";
  if (value === "dark") return "blue";
  return THEMES.find((theme) => theme === value) ?? "blue";
}

export function initialTheme(): Theme {
  return readStoredTheme(localGet(PREF_THEME));
}

/** Reads a stored choice, falling back to the default when the value is unknown. */
function pick<T extends string>(options: readonly T[], value: string | null, fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

export function initialAppearance(): Appearance {
  return {
    theme: initialTheme(),
    accent: pick(ACCENTS, localGet(PREF_ACCENT), "blue"),
    density: pick(DENSITIES, localGet(PREF_DENSITY), "comfortable"),
    contrast: pick(CONTRASTS, localGet(PREF_CONTRAST), "standard"),
    motion: pick(MOTIONS, localGet(PREF_MOTION), "on"),
  };
}

/** Storage key for each appearance setting. */
export const APPEARANCE_KEYS = {
  theme: PREF_THEME,
  accent: PREF_ACCENT,
  density: PREF_DENSITY,
  contrast: PREF_CONTRAST,
  motion: PREF_MOTION,
} as const;

/** Accepted values, so the UI and the stored choices stay in one list. */
export const APPEARANCE_OPTIONS = {
  theme: THEMES,
  accent: ACCENTS,
  density: DENSITIES,
  contrast: CONTRASTS,
  motion: MOTIONS,
} as const;

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