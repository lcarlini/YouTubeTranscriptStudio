/**
 * Runs async work over items with a fixed concurrency limit.
 * Results keep input order. Useful when a local API (Ollama, etc.) can serve
 * a few requests at once, or when overlapping network wait still helps.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const total = items.length;
  if (total === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, total));
  const results: R[] = new Array(total);
  let next = 0;
  let done = 0;

  async function runOne(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= total) return;
      results[index] = await worker(items[index], index);
      done += 1;
      onProgress?.(done, total);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runOne()));
  return results;
}
