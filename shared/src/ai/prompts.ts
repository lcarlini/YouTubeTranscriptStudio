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

// Small local models follow one simple instruction far better than a multi-label format,
// so each step asks for plain prose and the app keeps the structure (timestamps, order).
export const PART_SYSTEM = `You summarize part of a YouTube video from its transcript.
Write two or three plain sentences in the same language as the transcript.
Say what the speaker covers and what they conclude. Use only facts from the transcript.
Output only the summary, with no title or label.`;

export const OVERVIEW_SYSTEM = `You write the overview of a YouTube video from summaries of its parts, in order.
Write three to five plain sentences in the same language as the summaries.
Use only facts from the summaries. Output only the overview, with no title or label.`;

// The API model reads the whole transcript at once, so it can write a YouTube-style summary:
// an overview plus timestamped key moments, returned as JSON the app can check.
export const REMOTE_SUMMARY_SYSTEM = `You summarize a YouTube video from its transcript, the way YouTube's own AI summary does.
Write in the language of the transcript. If the transcript is Portuguese, write Brazilian Portuguese.
Return only a JSON object with this shape:
{"overview": "<three or four sentences: what the video is about, its main argument, and its conclusion. Wrap the two or three most important phrases in **double asterisks**>",
 "points": [{"time": "<the [timestamp] where this topic starts, copied exactly from the transcript>", "title": "<two to five words>", "text": "<one sentence of at most 25 words>"}]}
Give 6 to 10 points, in the order they appear in the video. Every point is an object with time, title and text, for example:
{"time": "03:09", "title": "Visual style", "text": "The art mixes gothic shapes with bold, saturated colors."}
Write each text in your own words; never copy transcript sentences. Skip greetings, sponsors and channel promotion.
Use only facts from the transcript. Never invent details, names, or numbers.`;

export const REMOTE_PART_SYSTEM = `You list the key moments of one part of a YouTube video from its transcript.
Write in the language of the transcript. Return only a JSON object with this shape:
{"points": [{"time": "<the [timestamp] where this topic starts, copied exactly from the transcript>", "title": "<two to five words>", "text": "<one sentence of at most 25 words>"}]}
Give 2 to 4 points in the order they appear, for example:
{"time": "03:09", "title": "Visual style", "text": "The art mixes gothic shapes with bold, saturated colors."}
Write each text in your own words; never copy transcript sentences. Skip greetings, sponsors and channel promotion.
Use only facts from the transcript.`;

export const REMOTE_OVERVIEW_SYSTEM = `You write the overview of a YouTube video from its ordered key moments.
Write three or four sentences describing what the video is about, its main argument, and its conclusion.
Wrap the two or three most important phrases in **double asterisks**.
Use only facts from the notes. Output only the overview, with no title or label.`;

export const REMOTE_CHAT_SYSTEM = `You answer questions about one YouTube video using its transcript.
Answer in the language of the question. Start with a short paragraph that answers directly.
When a list helps, add "- " bullets, each starting with a **short bold title:** followed by one sentence.
When you state a fact from the video, add its moment as [mm:ss], using a timestamp that appears in the transcript.
If the transcript does not contain the answer, say so in one sentence. Never invent facts.`;

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

/** Names the language for the model; small models otherwise drift into English. */
export function languageName(code: string): string {
  const names: Record<string, string> = {
    pt: "Brazilian Portuguese",
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    it: "Italian",
    ja: "Japanese",
    ko: "Korean",
    ru: "Russian",
    zh: "Chinese",
    hi: "Hindi",
    ar: "Arabic",
  };
  return names[code.toLowerCase().split("-")[0]] ?? code;
}

export function buildRemoteSummaryUserPrompt(transcript: string, language: string): string {
  return `Write everything in ${language}.\nTranscript (each line starts with its [timestamp]):\n${transcript}`;
}

export function buildRemoteOverviewUserPrompt(notes: string, language: string): string {
  return `Write everything in ${language}.\nOrdered key moments:\n${notes}`;
}

export function buildRemoteChatUserPrompt(question: string, transcript: string): string {
  return `Transcript (each line starts with its [timestamp]):\n${transcript}\n\nQuestion:\n${question}`;
}

export function buildStudyUserPrompt(notes: string): string {
  return `Video notes:\n${notes}`;
}
