import { describe, expect, it } from "vitest";
import { en } from "./en";
import { es } from "./es";
import { ptBR } from "./pt-BR";
import { translate } from "./index";

describe("catalogs", () => {
  it("keeps Portuguese and Spanish aligned with English", () => {
    const keys = Object.keys(en).sort();
    expect(Object.keys(ptBR).sort()).toEqual(keys);
    expect(Object.keys(es).sort()).toEqual(keys);
    for (const key of keys) {
      expect(ptBR[key as keyof typeof en].trim()).not.toBe("");
      expect(es[key as keyof typeof en].trim()).not.toBe("");
    }
  });

  it("interpolates translated strings", () => {
    expect(translate("en", "manyMatches", { count: 4 })).toBe("4 matches");
    expect(translate("pt-BR", "openStudio")).toBe("Abrir Transcript Studio");
    expect(translate("es", "modelReady")).toBe("Listo");
  });
});
