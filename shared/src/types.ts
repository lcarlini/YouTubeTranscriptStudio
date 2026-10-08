export type Locale = "en" | "pt-BR" | "es";

export type TabId = "transcript" | "insights" | "chat" | "study" | "export";

export interface TranscriptSegment {
  id: string;
  start: number;
  duration: number;
  text: string;
}

export interface Insights {
  tldr: string;
  takeaways: string[];
  chapters: Chapter[];
  glossary: GlossaryEntry[];
  actionItems: string[];
  followUps: string[];
}

export interface Chapter {
  start: number;
  title: string;
}

export interface GlossaryEntry {
  term: string;
  definition: string;
}

export interface Flashcard {
  id: string;
  front: string;
  back: string;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  choices: string[];
  answerIndex: number;
  explanation: string;
}

export interface StudyPack {
  flashcards: Flashcard[];
  quiz: QuizQuestion[];
}

export interface Citation {
  start: number;
  end: number;
  quote: string;
  segmentId?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  insufficient: boolean;
  createdAt: number;
}

export interface VideoRecord {
  videoId: string;
  url: string;
  title: string;
  author: string;
  thumbnailUrl: string;
  captionLanguage: string;
  processedAt: number;
  segments: TranscriptSegment[];
  insights: Insights | null;
  study: StudyPack | null;
  chat: ChatMessage[];
  timestampsEstimated: boolean;
}

export type ModelPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "loading"
  | "ready"
  | "generating"
  | "error";

export type InferenceDevice = "webgpu" | "wasm";

export interface CacheUsage {
  usageBytes: number | null;
  quotaBytes: number | null;
  modelBytes: number | null;
}
