/**
 * Bounded-concurrency batch runner.
 *
 * Splits items into chunks of batchSize and awaits each chunk (via
 * Promise.all) before starting the next, so at most batchSize operations are
 * in flight at once. A failure in one item does not stop its siblings in the
 * same chunk or subsequent chunks — worker() is expected to catch its own
 * errors (as enrichAndUpdate does) if a single failure shouldn't abort the run.
 */
export async function processInBatches<T>(
  items: T[],
  batchSize: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    await Promise.all(chunk.map((item) => worker(item)));
  }
}
