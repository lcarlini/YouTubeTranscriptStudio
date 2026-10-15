import { parseClock } from "../transcript/time";

/**
 * The small subset of Markdown that chat models actually produce: paragraphs,
 * bullet and numbered lists, headings, **bold**, *italic*, and timestamps such
 * as [1:40], (2:45, 6:45) or [1:53–1:58] that become links into the video.
 */
export type RichInline =
  | { kind: "text"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "em"; value: string }
  | { kind: "time"; seconds: number; label: string };

export type RichBlock =
  | { kind: "p" | "h"; inline: RichInline[] }
  | { kind: "ul" | "ol"; items: RichInline[][] };

const CLOCK = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
const TIME_ITEM = String.raw`${CLOCK}(?:\s*[–-]\s*${CLOCK})?`;
const INLINE = new RegExp(
  String.raw`\*\*([^*\n]+?)\*\*` +
    String.raw`|(?<![\w*])\*([^*\n]+?)\*(?![\w*])` +
    String.raw`|[[(]\s*(${TIME_ITEM}(?:\s*[,;]\s*${TIME_ITEM})*)\s*[\])]`,
  "g",
);
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,2}[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

export function parseRichText(text: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  let paragraph: string[] = [];
  let list: { kind: "ul" | "ol"; items: RichInline[][] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "p", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const kind = bullet ? "ul" : "ol";
      if (!list) list = { kind, items: [] };
      list.items.push(parseInline((bullet ?? numbered)![1]));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "h", inline: parseInline(heading[1].replace(/\*\*/g, "")) });
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}

export function parseInline(text: string): RichInline[] {
  const out: RichInline[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.value += value;
    else out.push({ kind: "text", value });
  };
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    pushText(text.slice(cursor, index));
    cursor = index + match[0].length;
    if (match[1] !== undefined) out.push({ kind: "strong", value: match[1] });
    else if (match[2] !== undefined) out.push({ kind: "em", value: match[2] });
    else {
      const times = match[3].split(/\s*[,;]\s*/);
      pushText("(");
      times.forEach((item, position) => {
        if (position > 0) pushText(", ");
        const start = item.split(/\s*[–-]\s*/)[0];
        out.push({ kind: "time", seconds: parseClock(start), label: start });
      });
      pushText(")");
    }
  }
  pushText(text.slice(cursor));
  return out;
}

export function hasTimes(blocks: RichBlock[]): boolean {
  return blocks.some((block) => {
    const lines = "items" in block ? block.items : [block.inline];
    return lines.some((line) => line.some((part) => part.kind === "time"));
  });
}
