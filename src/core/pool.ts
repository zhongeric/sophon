/**
 * Runs `run` on each item, with at most `limit` calls in progress at the same time, and gives the results in the order of the items.
 * When one call fails, the pool starts no new items, waits until the calls in progress settle, and then rejects with the first error.
 */
export async function pool<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`the pool limit must be an integer of 1 or more, not ${limit}`)
  const results = new Array<R>(items.length)
  let next = 0
  // An object, so that a thrown undefined still counts as the first error.
  let failure: { error: unknown } | undefined
  const worker = async () => {
    while (!failure && next < items.length) {
      const index = next++
      try {
        results[index] = await run(items[index]!, index)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure) throw failure.error
  return results
}
