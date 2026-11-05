import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTENSION_ID, EXTENSION_KEY, chromeExtensionIdFromKey } from "../identity";
import {
  APPEARANCE_KEYS,
  BROWSER_PROFILE,
  PREF_API_KEY,
  PREF_API_MODEL,
  PREF_API_URL,
  detectLocale,
  initialAppearance,
  readActiveProfileId,
  readProfiles,
  readStoredLocale,
  readStoredTab,
  readStoredTheme,
  writeActiveProfileId,
  writeProfiles,
} from "./preferences";

/** Minimal in-memory localStorage, so the profile code runs under the node test environment. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => { data.delete(key); },
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
  };
}

describe("appearance", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the 1.0 theme values to the new names, and defaults to blue", () => {
    expect(readStoredTheme("dark")).toBe("blue");
    expect(readStoredTheme("light")).toBe("white");
    expect(readStoredTheme("black")).toBe("black");
    expect(readStoredTheme(null)).toBe("blue");
    expect(readStoredTheme("neon")).toBe("blue");
  });

  it("falls back to the defaults for any value it does not recognise", () => {
    localStorage.setItem("yts.accent", "purple");
    localStorage.setItem("yts.density", "compact");
    localStorage.setItem("yts.motion", "off");
    expect(initialAppearance()).toEqual({
      theme: "blue",
      accent: "blue",
      density: "compact",
      contrast: "standard",
      motion: "off",
    });
  });

  it("keeps every appearance key in one place", () => {
    expect(APPEARANCE_KEYS).toEqual({
      theme: "yts.theme",
      accent: "yts.accent",
      density: "yts.density",
      contrast: "yts.contrast",
      motion: "yts.motion",
    });
  });
});

describe("AI profiles", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts empty, with the in-browser model active", () => {
    expect(readProfiles()).toEqual([]);
    expect(readActiveProfileId()).toBe(BROWSER_PROFILE);
  });

  it("keeps several profiles and remembers which one is active", () => {
    writeProfiles([
      { id: "a", name: "Claude", provider: "anthropic", baseUrl: "", model: "claude-haiku-5-5", apiKey: "k" },
      { id: "b", name: "Home", provider: "openai", baseUrl: "http://localhost:11434/v1", model: "llama", apiKey: "" },
    ]);
    writeActiveProfileId("b");
    expect(readProfiles().map((profile) => profile.name)).toEqual(["Claude", "Home"]);
    expect(readActiveProfileId()).toBe("b");
  });

  it("turns the single API saved by older versions into one Local profile, once", () => {
    localStorage.setItem(PREF_API_URL, "http://localhost:11434");
    localStorage.setItem(PREF_API_MODEL, "yts-llama3.1-8b");
    localStorage.setItem(PREF_API_KEY, "");
    const migrated = readProfiles();
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ name: "Local (Ollama)", provider: "openai", baseUrl: "http://localhost:11434", model: "yts-llama3.1-8b" });
    // The migrated list is saved, so a later read does not create a second copy.
    expect(readProfiles()).toEqual(migrated);
  });

  it("does not invent a profile when no API was ever saved", () => {
    expect(readProfiles()).toEqual([]);
  });

  it("ignores corrupt stored data instead of breaking the app", () => {
    localStorage.setItem("yts.profiles", "{not json");
    expect(readProfiles()).toEqual([]);
  });
});

describe("preferences", () => {
  it("detects the browser language once and keeps supported choices", () => {
    expect(detectLocale("pt-BR")).toBe("pt-BR");
    expect(detectLocale("es-MX")).toBe("es");
    expect(detectLocale("en-US")).toBe("en");
    expect(detectLocale("fr")).toBe("en");
    expect(readStoredLocale("pt-BR")).toBe("pt-BR");
    expect(readStoredLocale("de")).toBeNull();
    expect(readStoredTab("study")).toBe("study");
    expect(readStoredTab("nope")).toBeNull();
  });
});

describe("extension identity", () => {
  it("matches the published extension id to the manifest key", async () => {
    expect(await chromeExtensionIdFromKey(EXTENSION_KEY)).toBe(EXTENSION_ID);
  });
});
