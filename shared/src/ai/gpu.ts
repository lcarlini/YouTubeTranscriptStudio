export interface GpuInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  isFallbackAdapter?: boolean;
}

export interface GpuAdapter {
  isFallbackAdapter?: boolean;
  info?: GpuInfo;
  requestAdapterInfo?: () => Promise<GpuInfo>;
}

export interface GpuNavigator {
  requestAdapter: (options?: { powerPreference?: "high-performance" | "low-power" }) => Promise<GpuAdapter | null>;
}

export interface GpuProfile {
  available: boolean;
  fallback: boolean;
  label: string;
}

const EMPTY_PROFILE: GpuProfile = { available: false, fallback: false, label: "" };

export function preferWebGpu(profile: GpuProfile): boolean {
  return profile.available && !profile.fallback;
}

export function formatGpuLabel(info: GpuInfo, unnamedLabel: string, renderer = ""): string {
  const description = clean(info.description);
  if (description) return description;
  const product = productFromRenderer(renderer);
  if (product && rendererAgrees(info, product)) return product;
  const vendor = presentName(clean(info.vendor));
  const device = humanDevice(info);
  const named = [vendor, device].filter(Boolean).join(" ");
  return named || unnamedLabel;
}

export function productFromRenderer(renderer: string): string {
  if (!renderer.startsWith("ANGLE")) return "";
  const open = renderer.indexOf("(");
  const close = renderer.lastIndexOf(")");
  if (open < 0 || close <= open) return "";
  const raw = renderer.slice(open + 1, close).split(",")[1]?.trim() ?? "";
  return clean(
    raw
      .replace(/\s*\(0x[0-9a-f]+\)/gi, "")
      .replace(/\s+(?:Direct3D|OpenGL|Vulkan|Metal).*$/i, ""),
  );
}

export function readGraphicsRenderer(scope: object): string {
  const host = scope as {
    document?: { createElement: (tag: string) => CanvasSource };
    OffscreenCanvas?: new (width: number, height: number) => CanvasSource;
  };
  try {
    const canvas = host.document
      ? host.document.createElement("canvas")
      : host.OffscreenCanvas
        ? new host.OffscreenCanvas(1, 1)
        : null;
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    if (!gl) return "";
    const token = gl.getExtension("WEBGL_debug_renderer_info")?.UNMASKED_RENDERER_WEBGL;
    const value = token ? gl.getParameter(token) : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext?.();
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

export async function probeGpu(gpu: GpuNavigator | undefined, unnamedLabel: string, renderer = ""): Promise<GpuProfile> {
  if (!gpu) return EMPTY_PROFILE;
  try {
    const adapter = await requestBestAdapter(gpu);
    if (!adapter) return EMPTY_PROFILE;
    const info = await readAdapterInfo(adapter);
    const fallback = Boolean(adapter.isFallbackAdapter || info.isFallbackAdapter);
    return {
      available: true,
      fallback,
      label: formatGpuLabel(info, unnamedLabel, renderer),
    };
  } catch {
    return EMPTY_PROFILE;
  }
}

export function readNavigatorGpu(navigatorLike: Navigator | undefined): GpuNavigator | undefined {
  return (navigatorLike as (Navigator & { gpu?: GpuNavigator }) | undefined)?.gpu;
}

async function requestBestAdapter(gpu: GpuNavigator): Promise<GpuAdapter | null> {
  const preferred = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (preferred && !preferred.isFallbackAdapter) return preferred;
  const general = await gpu.requestAdapter();
  if (general && !general.isFallbackAdapter) return general;
  return preferred ?? general;
}

interface CanvasSource {
  getContext(kind: "webgl" | "webgl2"): WebGlContext | null;
}

interface WebGlContext {
  getExtension(name: string): { UNMASKED_RENDERER_WEBGL?: number; loseContext?: () => void } | null;
  getParameter(value: number): unknown;
}

async function readAdapterInfo(adapter: GpuAdapter): Promise<GpuInfo> {
  const current = adapter.info ?? {};
  if (clean(current.description) || !adapter.requestAdapterInfo) return current;
  try {
    const extra = await adapter.requestAdapterInfo();
    return {
      vendor: clean(extra.vendor) || current.vendor,
      architecture: clean(extra.architecture) || current.architecture,
      device: clean(extra.device) || current.device,
      description: clean(extra.description) || current.description,
      isFallbackAdapter: extra.isFallbackAdapter ?? current.isFallbackAdapter,
    };
  } catch {
    return current;
  }
}

function rendererAgrees(info: GpuInfo, product: string): boolean {
  const vendor = clean(info.vendor).toLowerCase();
  if (!vendor) return true;
  return product.toLowerCase().includes(vendor);
}

function humanDevice(info: GpuInfo): string {
  const device = clean(info.device);
  if (device && !/^0x[0-9a-f]+$/i.test(device)) return presentName(device);
  return presentName(clean(info.architecture));
}

function presentName(value: string): string {
  if (!value) return "";
  const known: Record<string, string> = {
    nvidia: "NVIDIA",
    amd: "AMD",
    ati: "AMD",
    intel: "Intel",
    apple: "Apple",
    qualcomm: "Qualcomm",
    arm: "Arm",
    microsoft: "Microsoft",
  };
  return known[value.toLowerCase()] ?? value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}
