import { StudioError } from "../errors";
import type { CacheUsage, InferenceDevice, ModelPhase } from "../types";

interface ProgressEvent {
  id: string;
  type: "progress";
  phase: ModelPhase;
  progress: number | null;
  device: InferenceDevice | null;
}

interface ResultEvent {
  id: string;
  type: "result";
  payload: unknown;
}

interface ErrorEvent {
  id: string;
  type: "error";
  code: string;
  message: string;
}

type WorkerEvent = ProgressEvent | ResultEvent | ErrorEvent;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class LocalModelClient {
  phase: ModelPhase = "idle";
  device: InferenceDevice | null = null;
  progress: number | null = null;
  private readonly worker: Worker;
  private seq = 0;
  private readonly pending = new Map<string, PendingCall>();
  private configured: Promise<void> = Promise.resolve();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly onChange: () => void,
    wasmPaths?: string,
  ) {
    this.worker = new Worker(new URL("./llm.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      const data = event.data;
      if (data.type === "progress") {
        this.phase = data.phase;
        this.progress = data.progress;
        this.device = data.device ?? this.device;
        this.onChange();
        return;
      }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.type === "error") {
        const error = new StudioError(data.code === "model-download" ? "model-download" : "model-runtime", data.message);
        pending.reject(error);
        return;
      }
      pending.resolve(data.payload);
    };
    this.worker.onerror = () => {
      this.phase = "error";
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        pending.reject(new StudioError("model-runtime", "The local model worker stopped."));
      }
      this.onChange();
    };
    if (wasmPaths) {
      this.configured = this.send("configure", { wasmPaths }).then(() => undefined);
    }
  }

  ensureLoaded(): Promise<void> {
    if (this.phase === "ready") return Promise.resolve();
    this.loading ??= this.configured
      .then(() => this.send("load", {}))
      .then(() => undefined)
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async generate(system: string, user: string, maxNewTokens: number): Promise<string> {
    await this.ensureLoaded();
    const text = await this.send("generate", { system, user, maxNewTokens });
    return typeof text === "string" ? text : "";
  }

  async cacheUsage(): Promise<CacheUsage> {
    const usage = await this.send("cache-usage", {});
    if (!usage || typeof usage !== "object") {
      return { usageBytes: null, quotaBytes: null, modelBytes: null };
    }
    return usage as CacheUsage;
  }

  async clearCache(): Promise<void> {
    await this.configured;
    await this.send("clear-cache", {});
    this.phase = "idle";
    this.device = null;
    this.progress = null;
    this.onChange();
  }

  private send(type: string, extra: Record<string, unknown>): Promise<unknown> {
    const id = `m${this.seq}`;
    this.seq += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...extra });
    });
  }
}
