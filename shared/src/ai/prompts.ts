import type { TranscriptSegment } from "../types";
import { formatTimestamp } from "../transcript/time";

export const CHAT_SYSTEM = `You answer questions about one YouTube transcript.
Use only the excerpts in the user message.
If the excerpts do not support an answer, the first line must be exactly: INSUFFICIENT
Otherwise reply in this shape and nothing else:
ANSWER:
<concise answer in the same language as the question>
EVIDENCE:
- [mm:ss] "<short quote copied from an excerpt>"
Every claim needs a timestamp that appears in the excerpts. Never invent timestamps or facts.`;

export const INSIGHTS_SYSTEM = `You create study notes from a transcript excerpt.
Use only the excerpt. Reply in the same language as the excerpt, using exactly these labels:
TLDR: <one or two sentences>
TAKEAWAYS:
- <point>
CHAPTERS:
- [mm:ss] <short title>
TERMS:
- <term>: <short definition from the excerpt>
ACTIONS:
- <action the viewer could take, or "None">
QUESTIONS:
- <follow-up question answerable from this video>
Do not add facts that are not in the excerpt.`;

export const MERGE_SYSTEM = `You merge partial study notes about one video into a single set.
Do not add facts that are absent from the notes. Keep the same labels:
TLDR:
TAKEAWAYS:
CHAPTERS:
TERMS:
ACTIONS:
QUESTIONS:`;

export const STUDY_SYSTEM = `You create study material from transcript notes.
Reply in the same language as the notes, using exactly this shape:
FLASHCARDS:
Q: <question>
A: <answer>
QUIZ:
Q: <question>
A) <choice>
B) <choice>
C) <choice>
D) <choice>
ANSWER: <A, B, C, or D>
WHY: <one sentence grounded in the notes>
Create 4 flashcards and 3 quiz questions. Do not invent facts.`;

export function buildChatUserPrompt(question: string, segments: TranscriptSegment[]): string {
  const excerpts = segments.map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`).join("\n");
  return `Question:\n${question}\n\nTranscript excerpts:\n${excerpts}`;
}

export function buildInsightsUserPrompt(excerpt: string): string {
  return `Transcript excerpt:\n${excerpt}`;
}

export function buildMergeUserPrompt(notes: string): string {
  return `Partial notes:\n${notes}`;
}

export function buildStudyUserPrompt(notes: string): string {
  return `Video notes:\n${notes}`;
}
