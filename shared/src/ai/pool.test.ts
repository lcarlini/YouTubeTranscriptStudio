import { describe, expect, it } from "vitest";
import { mapPool } from "./pool";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("mapPool", () => {
  it("keeps result order and reports progress", async () => {
    const progress: Array<[number, number]> = [];
    const results = await mapPool(
      [10, 20, 30],
      2,
      async (value) => value * 2,
      (done, total) => progress.push([done, total]),
    );
    expect(results).toEqual([20, 40, 60]);
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  it("runs up to the concurrency limit at once", async () => {
    let active = 0;
    let peak = 0;
    const started = deferred();
    let startedCount = 0;
    const gate = deferred();
    const results = mapPool([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      startedCount += 1;
      if (startedCount === 2) started.resolve();
      await gate.promise;
      active -= 1;
      return value;
    });
    await started.promise;
    expect(peak).toBe(2);
    expect(active).toBe(2);
    gate.resolve();
    await expect(results).resolves.toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("returns an empty list for no items", async () => {
    expect(await mapPool([], 3, async (value) => value)).toEqual([]);
  });
});
