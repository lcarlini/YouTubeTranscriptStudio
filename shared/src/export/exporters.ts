import type { ChatMessage, Insights, StudyPack, TranscriptSegment } from "../types";
import { cueEnd, formatSrtTimestamp, formatTimestamp, formatVttTimestamp } from "../transcript/time";

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function fileSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "transcript";
}

export function exportSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((segment, index) => {
      const end = cueEnd(segment.start, segment.duration);
      return `${index + 1}\n${formatSrtTimestamp(segment.start)} --> ${formatSrtTimestamp(end)}\n${singleLine(segment.text)}\n`;
    })
    .join("\n");
}

export function exportVtt(segments: TranscriptSegment[]): string {
  const cues = segments.map((segment) => {
    const end = cueEnd(segment.start, segment.duration);
    return `${formatVttTimestamp(segment.start)} --> ${formatVttTimestamp(end)}\n${singleLine(segment.text)}\n`;
  });
  return `WEBVTT\n\n${cues.join("\n")}`;
}

export function exportTxt(title: string, url: string, segments: TranscriptSegment[]): string {
  const lines = segments.map((segment) => `[${formatTimestamp(segment.start)}] ${singleLine(segment.text)}`);
  return `${title}\n${url}\n\n${lines.join("\n")}\n`;
}

export function exportPlainTranscript(segments: TranscriptSegment[]): string {
  return segments.map((segment) => `[${formatTimestamp(segment.start)}] ${singleLine(segment.text)}`).join("\n");
}

export interface MarkdownExportInput {
  title: string;
  url: string;
  segments: TranscriptSegment[];
  insights: Insights | null;
  study: StudyPack | null;
  chat: ChatMessage[] | null;
}

export function exportMarkdown(input: MarkdownExportInput): string {
  const parts: string[] = [`# ${input.title}`, "", input.url, ""];

  if (input.insights?.tldr) {
    parts.push("## TL;DR", "", input.insights.tldr, "");
  }
  if (input.insights && input.insights.takeaways.length > 0) {
    parts.push("## Key takeaways", "", ...input.insights.takeaways.map((item) => `- ${item}`), "");
  }
  if (input.insights && input.insights.chapters.length > 0) {
    parts.push(
      "## Chapters",
      "",
      ...input.insights.chapters.map((chapter) => `- [${formatTimestamp(chapter.start)}] ${chapter.title}`),
      "",
    );
  }
  if (input.insights && input.insights.glossary.length > 0) {
    parts.push(
      "## Glossary",
      "",
      ...input.insights.glossary.map((entry) => `- **${entry.term}:** ${entry.definition}`),
      "",
    );
  }
  if (input.insights && input.insights.actionItems.length > 0) {
    parts.push("## Action items", "", ...input.insights.actionItems.map((item) => `- ${item}`), "");
  }

  parts.push("## Transcript", "");
  for (const segment of input.segments) {
    parts.push(`**[${formatTimestamp(segment.start)}]** ${singleLine(segment.text)}`, "");
  }

  if (input.study && input.study.flashcards.length > 0) {
    parts.push("## Flashcards", "");
    for (const card of input.study.flashcards) {
      parts.push(`- **Q:** ${card.front}`, `  **A:** ${card.back}`, "");
    }
  }

  if (input.chat && input.chat.length > 0) {
    parts.push("## Chat history", "");
    for (const message of input.chat) {
      const who = message.role === "user" ? "You" : "Local assistant";
      parts.push(`**${who}:** ${message.content}`);
      if (message.citations.length > 0) {
        const stamps = message.citations.map((citation) => formatTimestamp(citation.start)).join(", ");
        parts.push(`Sources: ${stamps}`);
      }
      parts.push("");
    }
  }

  return `${parts.join("\n").trim()}\n`;
}

export function exportAnkiCsv(cards: StudyPack["flashcards"]): string {
  const lines = ["front,back"];
  for (const card of cards) {
    lines.push(`${csvCell(card.front)},${csvCell(card.back)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function exportStudyMarkdown(title: string, study: StudyPack): string {
  const parts = [`# ${title}`, "", "## Flashcards", ""];
  for (const card of study.flashcards) {
    parts.push(`### ${card.front}`, "", card.back, "");
  }
  parts.push("## Quiz", "");
  study.quiz.forEach((question, index) => {
    parts.push(`${index + 1}. ${question.prompt}`, "");
    question.choices.forEach((choice, choiceIndex) => {
      const letter = String.fromCharCode(65 + choiceIndex);
      parts.push(`- ${letter}) ${choice}`);
    });
    const answer = String.fromCharCode(65 + question.answerIndex);
    parts.push("", `**Answer:** ${answer}`, "", question.explanation, "");
  });
  return `${parts.join("\n").trim()}\n`;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""').replace(/\r?\n/g, " ")}"`;
}

export function downloadTextFile(filename: string, contents: string, mimeType: string): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
