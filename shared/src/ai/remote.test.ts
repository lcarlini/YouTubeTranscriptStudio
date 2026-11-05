import { afterEach, describe, expect, it, vi } from "vitest";
import { isStudioError } from "../errors";
import {
  ANTHROPIC_DEFAULT_MODEL,
  isModelListed,
  normalizeBaseUrl,
  remoteComplete,
  remoteEnabled,
  remoteIsPaid,
  remoteModels,
  remoteWarm,
} from "./remote";
import { parseRemoteSummary, timestampsIn } from "./parse-model";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeBaseUrl", () => {
  it("adds /v1 to a bare server address, as Ollama serves its OpenAI API there", () => {
    expect(normalizeBaseUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("http://localhost:11434/")).toBe("http://localhost:11434/v1");
  });

  it("keeps an explicit API path and drops trailing slashes", () => {
    expect(normalizeBaseUrl("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
  });

  it("treats an empty value as no API", () => {
    expect(normalizeBaseUrl("   ")).toBe("");
    expect(remoteEnabled({ provider: "openai", baseUrl: "", apiKey: "", model: "m" })).toBe(false);
    expect(remoteEnabled({ provider: "openai", baseUrl: "http://localhost:11434/v1", apiKey: "", model: "" })).toBe(false);
    expect(remoteEnabled({ provider: "openai", baseUrl: "http://localhost:11434/v1", apiKey: "", model: "m" })).toBe(true);
  });

  it("needs a key, not a URL, for the Claude API", () => {
    expect(remoteEnabled({ provider: "anthropic", baseUrl: "", apiKey: "", model: "claude-haiku-5-5" })).toBe(false);
    expect(remoteEnabled({ provider: "anthropic", baseUrl: "", apiKey: "sk-ant-x", model: "claude-haiku-5-5" })).toBe(true);
    expect(remoteIsPaid({ provider: "anthropic", baseUrl: "", apiKey: "k", model: "m" })).toBe(true);
    expect(remoteIsPaid({ provider: "openai", baseUrl: "http://localhost:11434", apiKey: "", model: "m" })).toBe(false);
  });

  it("rejects anything that is not http or https", () => {
    expect(() => normalizeBaseUrl("ftp://example.com")).toThrow();
  });
});

describe("isModelListed", () => {
  it("accepts a bare name when the server lists it with the :latest tag", () => {
    expect(isModelListed(["yts-llama3.1-8b:latest", "llama3.1:8b"], "yts-llama3.1-8b")).toBe(true);
  });

  it("accepts the exact id, including a tag typed by the user", () => {
    expect(isModelListed(["yts-llama3.1-8b:latest", "llama3.1:8b"], "llama3.1:8b")).toBe(true);
    expect(isModelListed(["yts-llama3.1-8b:latest"], "yts-llama3.1-8b:latest")).toBe(true);
  });

  it("reports a model that is really absent, and does not match a prefix of another name", () => {
    expect(isModelListed(["yts-llama3.1-8b:latest"], "llama3.1")).toBe(false);
    expect(isModelListed(["yts-llama3.1-8b:latest"], "yts-llama3.1")).toBe(false);
    expect(isModelListed(["llama3.1:8b"], "llama3.1:70b")).toBe(false);
  });
});

describe("parseRemoteSummary", () => {
  it("reads a fenced JSON answer, converts times and sorts the points", () => {
    const raw = [
      "```json",
      '{"overview": "Um vídeo sobre jogos.",',
      ' "points": [',
      '  {"time": "03:09", "title": "Estilo visual", "text": "A arte muda."},',
      '  {"time": "0:00", "title": "Abertura", "text": "Apresentação do jogo."}',
      " ]}",
      "```",
    ].join("\n");
    const summary = parseRemoteSummary(raw);
    expect(summary.overview).toBe("Um vídeo sobre jogos.");
    expect(summary.points.map((point) => point.start)).toEqual([0, 189]);
    expect(summary.points[1].title).toBe("Estilo visual");
  });

  it("drops points without a usable time or text instead of guessing", () => {
    const raw = '{"overview":"x","points":[{"time":"n/a","text":"sem tempo"},{"time":"1:00","text":""},{"time":"1:00","text":"ok"}]}';
    expect(parseRemoteSummary(raw).points).toEqual([{ start: 60, title: "", text: "ok" }]);
  });

  it("places bare sentences and untimed points with the locator, when one is given", () => {
    const raw = '{"overview":"x","points":["Roxas faces Dracula.",{"title":"Music","text":"The soundtrack mixes genres."}]}';
    const summary = parseRemoteSummary(raw, (text) => (text.includes("Roxas") ? 120 : 300));
    expect(summary.points).toEqual([
      { start: 120, title: "", text: "Roxas faces Dracula." },
      { start: 300, title: "Music", text: "The soundtrack mixes genres." },
    ]);
    expect(parseRemoteSummary(raw).points).toEqual([]);
  });

  it("keeps the complete points of an answer cut off by the token limit", () => {
    const raw = '{"overview":"Um vídeo sobre Zelda.","points":[{"time":"0:10","title":"Abertura","text":"Link acorda."},{"time":"1:20","title":"Templo","text":"Entrada do templo."},{"time":"2:30","title":"Chef";';
    const summary = parseRemoteSummary(raw);
    expect(summary.overview).toBe("Um vídeo sobre Zelda.");
    expect(summary.points.map((point) => point.title)).toEqual(["Abertura", "Templo"]);
  });

  it("fails with a StudioError when the answer is not JSON", () => {
    try {
      parseRemoteSummary("Here is your summary, no JSON.");
      throw new Error("expected a throw");
    } catch (error) {
      expect(isStudioError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("remote-api");
    }
  });
});

describe("timestampsIn", () => {
  it("finds each bracketed timestamp, with or without hours", () => {
    expect(timestampsIn("Veja [03:09] e depois [1:02:03], mas não [xx].")).toEqual([189, 3723]);
  });
});

describe("Claude API profile", () => {
  const claude = { provider: "anthropic" as const, baseUrl: "", apiKey: "sk-ant-test", model: ANTHROPIC_DEFAULT_MODEL };

  function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    return JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
  }

  it("sends the cheapest settings: Haiku 5.5, low effort, no thinking, no sampling options", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "{\"overview\":\"x\"}" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await remoteComplete(claude, "system text", "user text", { maxTokens: 700, json: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers.Authorization).toBeUndefined();
    const body = bodyOf(fetchMock);
    expect(body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 700,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: "system text",
      messages: [{ role: "user", content: "user text" }],
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("response_format");
  });

  it("joins the text blocks of the answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "Olá " }, { type: "text", text: "mundo" }] }), { status: 200 }),
    ));
    await expect(remoteComplete(claude, "s", "u", { maxTokens: 50 })).resolves.toBe("Olá mundo");
  });

  it("tests the key through the free Models endpoint, not a paid message", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "claude-haiku-5-5" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(remoteModels(claude)).resolves.toEqual(["claude-haiku-5-5"]);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://api.anthropic.com/v1/models");
  });

  it("does not spend a warm-up call on Claude", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await remoteWarm(claude);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the API's own message for a rejected key, and marks it as an auth error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 }),
    ));
    await expect(remoteComplete(claude, "s", "u", { maxTokens: 10 })).rejects.toMatchObject({
      code: "remote-auth",
      message: expect.stringContaining("invalid x-api-key"),
    });
  });

  it("reports a model error with the message, so the user knows what to fix", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "model: claude-x not found" } }), { status: 404 }),
    ));
    await expect(remoteComplete(claude, "s", "u", { maxTokens: 10 })).rejects.toMatchObject({
      code: "remote-api",
      message: expect.stringContaining("claude-x not found"),
    });
  });
});

describe("remoteComplete", () => {
  const settings = { provider: "openai" as const, baseUrl: "http://localhost:11434", apiKey: "", model: "yts-llama3.1-8b" };

  it("warms the model with a tiny completion when an API is configured", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await remoteWarm(settings);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      max_tokens: number;
    };
    expect(body.max_tokens).toBe(4);
  });

  it("sends the transcript to the chat endpoint and returns the answer text", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "Resposta [00:05]" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const answer = await remoteComplete(settings, "system", "user", { maxTokens: 100, json: true });
    expect(answer).toBe("Resposta [00:05]");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("yts-llama3.1-8b");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(100);
  });

  it("reports an HTTP error as a remote-api StudioError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(remoteComplete(settings, "s", "u", { maxTokens: 10 })).rejects.toMatchObject({ code: "remote-api" });
  });

  it("reports a network failure as remote-unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    await expect(remoteComplete(settings, "s", "u", { maxTokens: 10 })).rejects.toMatchObject({ code: "remote-unreachable" });
  });
});
