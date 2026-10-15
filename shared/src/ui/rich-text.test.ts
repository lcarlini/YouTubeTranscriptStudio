import { describe, expect, it } from "vitest";
import { hasTimes, parseInline, parseRichText } from "./rich-text";

describe("parseInline", () => {
  it("turns bold, italic and bracketed timestamps into parts", () => {
    expect(parseInline("A **relação tóxica** com a *Sony* [1:40].")).toEqual([
      { kind: "text", value: "A " },
      { kind: "strong", value: "relação tóxica" },
      { kind: "text", value: " com a " },
      { kind: "em", value: "Sony" },
      { kind: "text", value: " (" },
      { kind: "time", seconds: 100, label: "1:40" },
      { kind: "text", value: ")." },
    ]);
  });

  it("links every time in a group and keeps only the start of a range", () => {
    const parts = parseInline("retaliação (2:45, 6:45) e [1:53–1:58]");
    expect(parts.filter((part) => part.kind === "time")).toEqual([
      { kind: "time", seconds: 165, label: "2:45" },
      { kind: "time", seconds: 405, label: "6:45" },
      { kind: "time", seconds: 113, label: "1:53" },
    ]);
  });

  it("reads hour-long timestamps and leaves ordinary parentheses alone", () => {
    expect(parseInline("[1:02:03]")).toContainEqual({ kind: "time", seconds: 3723, label: "1:02:03" });
    expect(parseInline("o jogo (de 2024) é bom")).toEqual([{ kind: "text", value: "o jogo (de 2024) é bom" }]);
  });
});

describe("parseRichText", () => {
  it("splits paragraphs, headings and lists the way chat models write them", () => {
    const blocks = parseRichText([
      "O vídeo discute **o fim da mídia física** [1:40].",
      "",
      "## Pontos principais",
      "- **FAFO:** a Sony agiu com arrogância (3:21).",
      "* **Jailbreak:** métodos no PS5 [4:52]",
      "",
      "1. Primeiro",
      "2) Segundo",
    ].join("\n"));
    expect(blocks.map((block) => block.kind)).toEqual(["p", "h", "ul", "ol"]);
    const list = blocks[2];
    expect("items" in list && list.items.length).toBe(2);
    expect(hasTimes(blocks)).toBe(true);
  });

  it("joins wrapped lines into one paragraph and reports when there are no times", () => {
    const blocks = parseRichText("Linha um\nlinha dois");
    expect(blocks).toEqual([{ kind: "p", inline: [{ kind: "text", value: "Linha um linha dois" }] }]);
    expect(hasTimes(blocks)).toBe(false);
  });
});
