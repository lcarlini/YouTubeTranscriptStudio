import type { Citation, Chapter, GlossaryEntry, Insights, QuizQuestion, StudyPack } from "../types";
import { parseClock } from "../transcript/time";

const CLOCK = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?`;
const STAMP = new RegExp(String.raw`\[(${CLOCK})(?:\s*[-–]\s*(${CLOCK}))?\]`, "g");

export function stripFences(value: string): string {
  return value.replace(/```(?:json|markdown|text)?/gi, "").replace(/```/g, "").trim();
}

export function extractGeneratedText(output: unknown): string {
  const first = Array.isArray(output) ? output[0] : output;
  if (!first || typeof first !== "object") return "";
  const generated = (first as { generated_text?: unknown }).generated_text;
  if (typeof generated === "string") return generated;
  if (Array.isArray(generated)) {
    const messages = generated as Array<{ role?: string; content?: unknown }>;
    const assistant = [...messages].reverse().find((message) => message.role === "assistant") ?? messages.at(-1);
    return typeof assistant?.content === "string" ? assistant.content : "";
  }
  return "";
}

export interface ParsedChat {
  insufficient: boolean;
  answer: string;
  citations: Citation[];
}

export function parseChatResponse(raw: string): ParsedChat {
  const text = stripFences(raw).trim();
  const firstLine = text.split(/\n/, 1)[0] ?? "";
  if (/^\s*INSUFFICIENT\b/i.test(firstLine)) {
    return { insufficient: true, answer: "", citations: [] };
  }

  const answerMatch = text.match(/ANSWER:\s*([\s\S]*?)(?:\n\s*EVIDENCE:|$)/i);
  const answer = (answerMatch?.[1] ?? text.replace(/\n\s*EVIDENCE:[\s\S]*/i, "")).trim();
  const citations = collectCitations(text);
  if (!answer || citations.length === 0) {
    return { insufficient: true, answer: "", citations: [] };
  }
  return { insufficient: false, answer, citations };
}

export function collectCitations(source: string): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(STAMP)) {
    const start = parseClock(match[1]);
    const end = match[2] ? parseClock(match[2]) : start;
    const after = source.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 180);
    const quoteMatch = after.match(/["“](.{4,140}?)["”]/);
    const key = `${start.toFixed(2)}-${end.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      start,
      end: Math.max(start, end),
      quote: quoteMatch?.[1]?.trim() ?? "",
    });
  }
  return citations;
}

function sectionBody(text: string, labels: string[]): string {
  const names = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = text.match(new RegExp(`(?:^|\\n)\\s*(?:${names})\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*[A-Z][A-Z ;]{2,}\\s*:|$)`, "i"));
  return match?.[1]?.trim() ?? "";
}

function bullets(body: string): string[] {
  return body
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function parseInsights(raw: string): Insights | null {
  const text = stripFences(raw);
  const tldr = sectionBody(text, ["TLDR", "TL;DR", "SUMMARY"]).replace(/\s+/g, " ").trim();
  const takeaways = uniqueStrings(bullets(sectionBody(text, ["TAKEAWAYS", "KEY TAKEAWAYS"])));
  const chapters = parseChapters(sectionBody(text, ["CHAPTERS"]));
  const glossary = parseGlossary(sectionBody(text, ["TERMS", "GLOSSARY"]));
  const actionItems = uniqueStrings(bullets(sectionBody(text, ["ACTIONS", "ACTION ITEMS"])));
  const followUps = uniqueStrings(bullets(sectionBody(text, ["QUESTIONS", "FOLLOWUPS", "FOLLOW-UP QUESTIONS"])));
  if (!tldr && takeaways.length === 0 && chapters.length === 0) return null;
  return { tldr, takeaways, chapters, glossary, actionItems, followUps };
}

function parseChapters(body: string): Chapter[] {
  const chapters: Chapter[] = [];
  for (const line of bullets(body)) {
    const match = line.match(new RegExp(String.raw`\[?(${CLOCK})\]?\s*[-–:]?\s*(.+)`, "i"));
    if (!match) continue;
    const title = match[2].replace(/^["“]|["”]$/g, "").trim();
    if (!title) continue;
    chapters.push({ start: parseClock(match[1]), title });
  }
  return chapters.sort((a, b) => a.start - b.start);
}

function parseGlossary(body: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const line of bullets(body)) {
    const match = line.match(/^([^:]{2,80}):\s*(.+)$/);
    if (!match) continue;
    entries.push({ term: match[1].trim(), definition: match[2].trim() });
  }
  return entries;
}

export function mergeInsights(parts: Insights[]): Insights {
  const takeaways = uniqueStrings(parts.flatMap((part) => part.takeaways)).slice(0, 8);
  const glossary = uniqueGlossary(parts.flatMap((part) => part.glossary)).slice(0, 12);
  const actionItems = uniqueStrings(parts.flatMap((part) => part.actionItems)).slice(0, 8);
  const followUps = uniqueStrings(parts.flatMap((part) => part.followUps)).slice(0, 6);
  const chapters = uniqueChapters(parts.flatMap((part) => part.chapters)).slice(0, 12);
  const tldr = uniqueStrings(parts.map((part) => part.tldr).filter(Boolean)).join(" ");
  return { tldr, takeaways, chapters, glossary, actionItems, followUps };
}

function uniqueGlossary(entries: GlossaryEntry[]): GlossaryEntry[] {
  const seen = new Set<string>();
  const result: GlossaryEntry[] = [];
  for (const entry of entries) {
    const key = entry.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function uniqueChapters(chapters: Chapter[]): Chapter[] {
  const sorted = [...chapters].sort((a, b) => a.start - b.start);
  const result: Chapter[] = [];
  for (const chapter of sorted) {
    const previous = result.at(-1);
    if (previous && Math.abs(previous.start - chapter.start) < 20) continue;
    result.push(chapter);
  }
  return result;
}

export function parseStudyPack(raw: string): StudyPack | null {
  const text = stripFences(raw);
  const flashBody = sectionBody(text, ["FLASHCARDS", "CARDS"]);
  const quizBody = sectionBody(text, ["QUIZ", "QUESTIONS"]);
  const flashcards = parseFlashcards(flashBody);
  const quiz = parseQuiz(quizBody);
  if (flashcards.length === 0 && quiz.length === 0) return null;
  return { flashcards, quiz };
}

function parseFlashcards(body: string): StudyPack["flashcards"] {
  const cards: StudyPack["flashcards"] = [];
  const blocks = body.split(/\n(?=\s*Q\s*:)/i).map((block) => block.trim()).filter(Boolean);
  blocks.forEach((block, index) => {
    const front = block.match(/Q\s*:\s*([\s\S]*?)(?:\n\s*A\s*:|$)/i)?.[1]?.trim() ?? "";
    const back = block.match(/A\s*:\s*([\s\S]*)/i)?.[1]?.trim() ?? "";
    if (!front || !back) return;
    cards.push({ id: `card-${index + 1}`, front: single(front), back: single(back) });
  });
  return cards;
}

function parseQuiz(body: string): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  const blocks = body.split(/\n(?=\s*Q\s*:)/i).map((block) => block.trim()).filter(Boolean);
  blocks.forEach((block, index) => {
    const prompt = block.match(/Q\s*:\s*([\s\S]*?)(?:\n\s*[A-D]\s*[).:]|$)/i)?.[1]?.trim() ?? "";
    const choices = ["A", "B", "C", "D"].map((letter) => {
      const match = block.match(new RegExp(String.raw`${letter}\s*[).:]\s*(.+)`, "i"));
      return match?.[1]?.trim() ?? "";
    });
    if (!prompt || choices.some((choice) => !choice)) return;
    const answerLetter = block.match(/ANSWER\s*:\s*([A-D])/i)?.[1]?.toUpperCase() ?? "A";
    const explanation = block.match(/WHY\s*:\s*([\s\S]*)/i)?.[1]?.trim() ?? "";
    questions.push({
      id: `quiz-${index + 1}`,
      prompt: single(prompt),
      choices: choices.map(single),
      answerIndex: answerLetter.charCodeAt(0) - 65,
      explanation: single(explanation),
    });
  });
  return questions;
}

function single(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
