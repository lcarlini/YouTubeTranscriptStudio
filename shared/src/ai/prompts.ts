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
Cover the topic, the speaker's claim or advice, and what they conclude. Do not only name the subject.
Use only facts from the transcript. Output only the summary, with no title or label.`;

export const OVERVIEW_SYSTEM = `You write the overview of a YouTube video from summaries of its parts, in order.
Write three to five plain sentences in the same language as the summaries.
State the main argument and the overall conclusion. Use only facts from the summaries.
Output only the overview, with no title or label.`;

// Matches YouTube's "Ask about this video" panel: a few thematic blocks, each a short
// paragraph with several inline timestamps and a clear takeaway — not a list of one-liners.
export const REMOTE_SUMMARY_SYSTEM = `You write a video summary in the same style as YouTube's built-in AI summary ("Ask about this video" / Gemini).
Write in the language of the transcript. If the transcript is Portuguese, write Brazilian Portuguese.
Return only a JSON object with this shape:
{"overview": "<one or two sentences naming the video's theme and overall takeaway. Wrap the most important phrase in **double asterisks**>",
 "points": [{"time": "<start timestamp of this theme, copied from the transcript>", "title": "<short theme title, about 3 to 8 words>", "text": "<one dense paragraph: 3 to 5 sentences>"}]}
Give exactly 3 to 5 points — one per major theme of the video, not many tiny bullets. Merge related moments into the same point.
Each point's text must:
1) State concrete facts, names, numbers, and products from the transcript.
2) Place a timestamp in parentheses after each distinct claim, using ranges when a claim spans a stretch, for example (0:09-0:32) or (1:26-2:15). Copy times from the transcript.
3) End with the speaker's conclusion, opinion, or advice when they give one (do not stop at "the presenter talks about X").
Good example:
{"time": "0:09", "title": "Desbloqueio do Nintendo Switch 2", "text": "O apresentador comenta que, após pouco mais de um ano do lançamento, o console foi desbloqueado pelo desenvolvedor Pepsi Pool (0:09-0:32). A ferramenta permite homebrews e modificações nos jogos (0:32-0:56). Ele reflete que a melhor forma de combater a pirataria é oferecer serviços de qualidade, citando a filosofia do Gabe Newell (1:26-2:15)."}
Bad example (too thin — never do this):
{"time": "0:06", "title": "Switch 2 desbloqueado", "text": "O Nintendo Switch 2 está sendo desbloqueado e a pirataria se torna realidade."}
Write in your own words; never copy transcript sentences. Skip greetings, sponsors and channel promotion.
Use only facts from the transcript. Never invent details, names, or numbers.`;

export const REMOTE_PART_SYSTEM = `You list thematic sections of one part of a YouTube video, in YouTube AI-summary style.
Write in the language of the transcript. Return only a JSON object with this shape:
{"points": [{"time": "<start timestamp>", "title": "<3 to 8 words>", "text": "<3 to 5 sentences with (mm:ss) or (mm:ss-mm:ss) after each claim, ending with the speaker's conclusion>"}]}
Give 1 to 3 points. Merge related moments. Never write a one-sentence topic label.`;

export const REMOTE_OVERVIEW_SYSTEM = `You write the overview of a YouTube video from its ordered key moments.
Write one or two sentences with the theme and overall takeaway.
Wrap the most important phrase in **double asterisks**.
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
