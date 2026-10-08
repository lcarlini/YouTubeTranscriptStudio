import { describe, expect, it } from "vitest";
import { formatGpuLabel, preferWebGpu, probeGpu, type GpuNavigator } from "./gpu";

describe("GPU selection", () => {
  it("names a discrete NVIDIA adapter and chooses WebGPU", async () => {
    const gpu = adapterGpu({
      description: "NVIDIA GeForce RTX 5070",
      vendor: "nvidia",
      architecture: "blackwell",
      device: "0x2c05",
    });
    const profile = await probeGpu(gpu, "high-performance GPU");
    expect(profile.label).toBe("NVIDIA GeForce RTX 5070");
    expect(preferWebGpu(profile)).toBe(true);
  });

  it("asks for the high-performance adapter before the default one", async () => {
    const calls: Array<string | undefined> = [];
    const gpu: GpuNavigator = {
      requestAdapter: async (options) => {
        calls.push(options?.powerPreference);
        if (options?.powerPreference === "high-performance") {
          return { info: { description: "NVIDIA GeForce RTX 5070" } };
        }
        return { info: { description: "Intel UHD Graphics" } };
      },
    };
    const profile = await probeGpu(gpu, "high-performance GPU");
    expect(calls[0]).toBe("high-performance");
    expect(profile.label).toBe("NVIDIA GeForce RTX 5070");
  });

  it("does not treat a software fallback adapter as the GPU", async () => {
    const profile = await probeGpu(adapterGpu({ description: "WARP", isFallbackAdapter: true }, true), "high-performance GPU");
    expect(preferWebGpu(profile)).toBe(false);
  });

  it("builds a label from the vendor when the description is hidden", () => {
    expect(formatGpuLabel({ vendor: "nvidia", architecture: "lovelace" }, "high-performance GPU")).toBe("NVIDIA Lovelace");
    expect(formatGpuLabel({}, "high-performance GPU")).toBe("high-performance GPU");
  });

  it("uses the graphics product name when WebGPU hides the description", () => {
    const renderer = "ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 (0x00002C05) Direct3D11 vs_5_0 ps_5_0, D3D11)";
    expect(formatGpuLabel({ vendor: "nvidia", architecture: "blackwell" }, "high-performance GPU", renderer))
      .toBe("NVIDIA GeForce RTX 5070");
  });

  it("reports no GPU when the browser cannot create an adapter", async () => {
    const profile = await probeGpu({ requestAdapter: async () => null }, "high-performance GPU");
    expect(preferWebGpu(profile)).toBe(false);
    expect(profile.label).toBe("");
  });
});

function adapterGpu(info: {
  description?: string;
  vendor?: string;
  architecture?: string;
  device?: string;
  isFallbackAdapter?: boolean;
}, adapterFallback = false): GpuNavigator {
  return {
    requestAdapter: async () => ({
      isFallbackAdapter: adapterFallback || info.isFallbackAdapter,
      info,
    }),
  };
}
