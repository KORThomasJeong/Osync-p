export async function mapWithConcurrency<TInput, TOutput>(
  items: ReadonlyArray<TInput>,
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const normalizedConcurrency = Number.isFinite(concurrency)
    ? Math.floor(concurrency)
    : 1;
  const workerCount = Math.max(1, Math.min(normalizedConcurrency, items.length));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    }),
  );

  return results;
}
