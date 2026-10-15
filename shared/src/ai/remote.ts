import { StudioError } from "../errors";

const REMOTE_TIMEOUT_MS = 240_000;

/**
 * Optional OpenAI-compatible endpoint (for example a local Llama served by Ollama).
 * When no URL is configured, the app uses the in-browser model instead.
 */
export interface RemoteSettings {
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
  return settings.baseUrl.trim() !== "" && settings.model.trim() !== "";
}

function headers(settings: RemoteSettings): Record<string, string> {
  const result: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.apiKey.trim()) result.Authorization = `Bearer ${settings.apiKey.trim()}`;
  return result;
}

async function request(settings: RemoteSettings, path: string, init: RequestInit): Promise<Response> {
  const base = normalizeBaseUrl(settings.baseUrl);
  // A whole-video summary can take a while on a local GPU, so the limit is generous.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: headers(settings),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new StudioError("remote-unreachable", `Could not reach ${base}.`);
  }
  clearTimeout(timer);
  if (!response.ok) {
    throw new StudioError("remote-api", `The API answered HTTP ${response.status}.`);
  }
  return response;
}

/** Lists model ids, used by the "test connection" button. */
export async function remoteModels(settings: RemoteSettings): Promise<string[]> {
  const response = await request(settings, "/models", { method: "GET" });
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

export async function remoteComplete(
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
  const response = await request(settings, "/chat/completions", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new StudioError("remote-api", "The API returned an empty answer.");
  }
  return text;
}
