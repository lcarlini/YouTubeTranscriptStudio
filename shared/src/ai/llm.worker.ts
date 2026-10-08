import { extractGeneratedText } from "./parse-model";
import { LOCAL_MODEL_DTYPE, LOCAL_MODEL_ID } from "../identity";
import type { CacheUsage, InferenceDevice, ModelPhase } from "../types";

interface WorkerRequest {
  id: string;
  type: "configure" | "load" | "generate" | "cache-usage" | "clear-cache";
  wasmPaths?: string;
  system?: string;
  user?: string;
  maxNewTokens?: number;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: unknown) => void;
  navigator: Navigator;
  caches: CacheStorage;
}

const scope = globalThis as unknown as WorkerScope;

interface ProgressCallback {
  status?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

interface TextGenerator {
  (
    messages: Array<{ role: string; content: string }>,
    options: {
      max_new_tokens: number;
      temperature: number;
      do_sample: boolean;
      top_p: number;
      repetition_penalty: number;
    },
  ): Promise<unknown>;
  dispose?: () => Promise<void> | void;
}

let wasmPaths = "";
let generator: TextGenerator | null = null;
let device: InferenceDevice | null = null;
let ready = false;
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event) => {
  const message = event.data;
  queue = queue.then(() => handle(message));
};

async function handle(message: WorkerRequest): Promise<void> {
  try {
    switch (message.type) {
      case "configure":
        wasmPaths = message.wasmPaths ?? "";
        reply(message.id, null);
        return;
      case "load":
        await loadModel();
        reply(message.id, { device });
        return;
      case "generate":
        reply(message.id, await generate(message.system ?? "", message.user ?? "", message.maxNewTokens ?? 256));
        return;
      case "cache-usage":
        reply(message.id, await readCacheUsage());
        return;
      case "clear-cache":
        await clearCache();
        reply(message.id, true);
        return;
      default:
        reply(message.id, null);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : "The local model failed.";
    const code = /fetch|network|http|404|403|download/i.test(text) ? "model-download" : "model-runtime";
    scope.postMessage({ id: message.id, type: "error", code, message: text });
  }
}

function reply(id: string, payload: unknown): void {
  scope.postMessage({ id, type: "result", payload });
}

let lastProgressAt = 0;
let lastPhase: ModelPhase | null = null;

function postProgress(phase: ModelPhase, progress: number | null): void {
  const now = Date.now();
  if (phase === lastPhase && phase === "downloading" && now - lastProgressAt < 120) return;
  lastPhase = phase;
  lastProgressAt = now;
  scope.postMessage({
    id: "progress",
    type: "progress",
    phase,
    progress,
    device,
  });
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (scope.navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

async function loadModel(): Promise<void> {
  if (ready && generator) {
    postProgress("ready", null);
    return;
  }

  postProgress("checking", null);
  const attempts: Array<{ device: InferenceDevice; dtype: "q4" | "uint8" }> = [];
  if (await hasWebGpu()) attempts.push({ device: "webgpu", dtype: LOCAL_MODEL_DTYPE });
  attempts.push({ device: "wasm", dtype: LOCAL_MODEL_DTYPE }, { device: "wasm", dtype: "uint8" });

  const transformers = await import("@huggingface/transformers");
  transformers.env.allowLocalModels = false;
  transformers.env.useBrowserCache = true;
  const wasm = transformers.env.backends.onnx.wasm;
  if (!wasm) throw new Error("The WASM runtime is unavailable.");
  wasm.numThreads = 1;
  if (wasmPaths) wasm.wasmPaths = wasmPaths;

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      device = attempt.device;
      postProgress("loading", null);
      const created = await transformers.pipeline("text-generation", LOCAL_MODEL_ID, {
        dtype: attempt.dtype,
        device: attempt.device,
        progress_callback: (info: ProgressCallback) => {
          if (info.status === "progress" || info.status === "download") {
            const progress = typeof info.progress === "number"
              ? info.progress
              : info.total
                ? ((info.loaded ?? 0) / info.total) * 100
                : null;
            postProgress("downloading", progress);
            return;
          }
          if (info.status === "initiate") postProgress("checking", null);
          if (info.status === "done" || info.status === "ready") postProgress("loading", null);
        },
      });
      generator = created as unknown as TextGenerator;
      ready = true;
      postProgress("ready", null);
      return;
    } catch (error) {
      lastError = error;
      generator = null;
      ready = false;
    }
  }

  device = null;
  postProgress("error", null);
  throw lastError instanceof Error ? lastError : new Error("The local model could not be loaded.");
}

async function generate(system: string, user: string, maxNewTokens: number): Promise<string> {
  if (!generator) await loadModel();
  postProgress("generating", null);
  const output = await generator!(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    {
      max_new_tokens: maxNewTokens,
      temperature: 0.2,
      do_sample: true,
      top_p: 0.9,
      repetition_penalty: 1.05,
    },
  );
  postProgress("ready", null);
  return extractGeneratedText(output);
}

async function readCacheUsage(): Promise<CacheUsage> {
  const estimate = await scope.navigator.storage?.estimate?.();
  let modelBytes = 0;
  let counted = false;
  const names = await scope.caches.keys();
  for (const name of names) {
    if (!/transformer/i.test(name)) continue;
    const cache = await scope.caches.open(name);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      const length = Number(response?.headers.get("content-length") ?? "0");
      if (length > 0) {
        modelBytes += length;
        counted = true;
      }
    }
  }
  return {
    usageBytes: estimate?.usage ?? null,
    quotaBytes: estimate?.quota ?? null,
    modelBytes: counted ? modelBytes : null,
  };
}

async function clearCache(): Promise<void> {
  if (generator?.dispose) await generator.dispose();
  generator = null;
  ready = false;
  device = null;
  const names = await scope.caches.keys();
  await Promise.all(names.filter((name) => /transformer/i.test(name)).map((name) => scope.caches.delete(name)));
  postProgress("idle", null);
}
