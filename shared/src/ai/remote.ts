import { StudioError } from "../errors";

const REMOTE_TIMEOUT_MS = 240_000;

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_API_VERSION = "2023-06-01";
/** Cheapest Claude model. Effort is pinned to low and thinking off to keep token spend minimal. */
export const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-5-5";

export type RemoteProvider = "openai" | "anthropic";

/**
 * An AI profile that is not the in-browser model. `openai` covers any OpenAI-compatible
 * server (for example Ollama). `anthropic` calls the Claude API directly from the browser.
 */
export interface RemoteSettings {
  provider: RemoteProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Ollama and most local servers listen on a bare host; their OpenAI API lives under /v1. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StudioError("invalid-url", "The API URL must start with http:// or https://.");
  }
  return url.pathname === "/" ? `${url.origin}/v1` : trimmed;
}

export function remoteEnabled(settings: RemoteSettings): boolean {
  if (settings.provider === "anthropic") {
    return settings.apiKey.trim() !== "" && settings.model.trim() !== "";
  }
  return settings.baseUrl.trim() !== "" && settings.model.trim() !== "";
}

/** True when the profile is billed per token, so the app should keep requests small. */
export function remoteIsPaid(settings: RemoteSettings): boolean {
  return settings.provider === "anthropic";
}

function openAiHeaders(settings: RemoteSettings): Record<string, string> {
  const result: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.apiKey.trim()) result.Authorization = `Bearer ${settings.apiKey.trim()}`;
  return result;
}

function anthropicHeaders(settings: RemoteSettings): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": settings.apiKey.trim(),
    "anthropic-version": ANTHROPIC_API_VERSION,
    // Required so the browser (and the extension side panel) may call the API directly.
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

/** Reads the server's own error message so the user sees the real cause, not a generic one. */
async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
    if (message) return message.slice(0, 240);
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.trim().slice(0, 240);
}

async function request(settings: RemoteSettings, url: string, init: RequestInit, headers: Record<string, string>): Promise<Response> {
  // A whole-video summary can take a while on a local GPU, so the limit is generous.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, signal: controller.signal });
  } catch {
    clearTimeout(timer);
    const where = settings.provider === "anthropic" ? "api.anthropic.com" : url;
    throw new StudioError("remote-unreachable", `Could not reach ${where}.`);
  }
  clearTimeout(timer);
  if (!response.ok) {
    const detail = await errorDetail(response);
    const code = response.status === 401 || response.status === 403 ? "remote-auth" : "remote-api";
    throw new StudioError(code, `The API answered HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
  }
  return response;
}

function openAiUrl(settings: RemoteSettings, path: string): string {
  return `${normalizeBaseUrl(settings.baseUrl)}${path}`;
}

/**
 * Lists model ids, used by the "test connection" button. For Claude this is the
 * Models endpoint, which is free: testing a key never spends tokens.
 */
export async function remoteModels(settings: RemoteSettings): Promise<string[]> {
  if (settings.provider === "anthropic") {
    const response = await request(settings, `${ANTHROPIC_BASE_URL}/models?limit=100`, { method: "GET" }, anthropicHeaders(settings));
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((model) => model.id ?? "").filter(Boolean);
  }
  const response = await request(settings, openAiUrl(settings, "/models"), { method: "GET" }, openAiHeaders(settings));
  const data = (await response.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? []).map((model) => model.id ?? "").filter(Boolean);
}

/**
 * Ollama lists models with their tag (`name:latest`), while users type the bare
 * name. Accept either form so a configured model is not reported as missing.
 */
export function isModelListed(ids: string[], model: string): boolean {
  const wanted = model.trim();
  if (!wanted) return true;
  return ids.some((id) => {
    if (id === wanted) return true;
    if (wanted.includes(":")) return false;
    return id === `${wanted}:latest` || id.startsWith(`${wanted}:`);
  });
}

export interface RemoteCompletionOptions {
  maxTokens: number;
  json?: boolean;
}

/**
 * Loads the configured model into memory (Ollama VRAM) with a tiny reply so the
 * first real summary does not pay the cold-start cost. Claude has no cold start,
 * and a warm-up call would be billed, so it is skipped there.
 */
export async function remoteWarm(settings: RemoteSettings): Promise<void> {
  if (!remoteEnabled(settings) || settings.provider === "anthropic") return;
  await remoteComplete(settings, "Reply with the single word OK.", "OK", { maxTokens: 4 });
}

export async function remoteComplete(
  settings: RemoteSettings,
  system: string,
  user: string,
  options: RemoteCompletionOptions,
): Promise<string> {
  if (settings.provider === "anthropic") return anthropicComplete(settings, system, user, options);
  return openAiComplete(settings, system, user, options);
}

async function openAiComplete(
  settings: RemoteSettings,
  system: string,
  user: string,
  options: RemoteCompletionOptions,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: settings.model.trim(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    max_tokens: options.maxTokens,
    stream: false,
  };
  if (options.json) body.response_format = { type: "json_object" };
  const response = await request(
    settings,
    openAiUrl(settings, "/chat/completions"),
    { method: "POST", body: JSON.stringify(body) },
    openAiHeaders(settings),
  );
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new StudioError("remote-api", "The API returned an empty answer.");
  }
  return text;
}

/**
 * Claude Messages API. Haiku 5.5 is the cheapest current model; `effort: low` and
 * thinking disabled keep the reasoning and output tokens to a minimum. `temperature`
 * is omitted on purpose: non-default sampling values are rejected by Haiku 5.5.
 */
async function anthropicComplete(
  settings: RemoteSettings,
  system: string,
  user: string,
  options: RemoteCompletionOptions,
): Promise<string> {
  const body = {
    model: settings.model.trim() || ANTHROPIC_DEFAULT_MODEL,
    max_tokens: options.maxTokens,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content: user }],
  };
  const response = await request(
    settings,
    `${ANTHROPIC_BASE_URL}/messages`,
    { method: "POST", body: JSON.stringify(body) },
    anthropicHeaders(settings),
  );
  const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = (data.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  if (!text.trim()) {
    throw new StudioError("remote-api", "The API returned an empty answer.");
  }
  return text;
}
