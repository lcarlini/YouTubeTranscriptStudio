import { afterEach, describe, expect, it, vi } from "vitest";
import { isStudioError } from "../errors";
import { isModelListed, normalizeBaseUrl, remoteComplete, remoteEnabled, remoteWarm } from "./remote";
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
    expect(remoteEnabled({ baseUrl: "", apiKey: "", model: "m" })).toBe(false);
    expect(remoteEnabled({ baseUrl: "http://localhost:11434/v1", apiKey: "", model: "" })).toBe(false);
    expect(remoteEnabled({ baseUrl: "http://localhost:11434/v1", apiKey: "", model: "m" })).toBe(true);
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

describe("remoteComplete", () => {
  const settings = { baseUrl: "http://localhost:11434", apiKey: "", model: "yts-llama3.1-8b" };

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
