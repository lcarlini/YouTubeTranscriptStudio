import { describe, expect, it } from "vitest";
import { EXTENSION_ID, EXTENSION_KEY, chromeExtensionIdFromKey } from "../identity";
import { detectLocale, readStoredLocale, readStoredTab } from "./preferences";

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
