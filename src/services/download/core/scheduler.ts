/**
 * Bounded-concurrency task runner.
 *
 * N "lanes" each pull the next index from a shared cursor. No async generators
 * and no `Symbol.asyncIterator`: under `target: es5` those pull in regenerator
 * and change the emitted output, and this module has to compile identically
 * under a host toolchain we do not control.
 *
 * A task's rejection never sinks its lane — the lane records the failure and
 * continues — because one unreachable object must not abandon the rest of a
 * download.
 */

export interface SchedulerOptions {
  concurrency: number
  signal?: AbortSignal
}

export interface SchedulerResult<T> {
  /** Same order as the input; a rejected task yields undefined. */
  results: (T | undefined)[]
  /** Index-keyed failures, for callers that need the reason. */
  failures: Map<number, unknown>
  /** True when the run stopped early because the signal aborted. */
  aborted: boolean
}

/**
 * Runs `task` over every item, at most `concurrency` at a time.
 *
 * The abort check sits between tasks rather than inside them: cancelling an
 * in-flight transfer is the task's own responsibility (it owns the fetch and the
 * writer), while the scheduler's job is only to stop dispatching new work.
 */
export const runBounded = async <I, T>(
  items: readonly I[],
  task: (item: I, index: number) => Promise<T>,
  options: SchedulerOptions,
): Promise<SchedulerResult<T>> => {
  const results: (T | undefined)[] = new Array(items.length)
  const failures = new Map<number, unknown>()
  const lanes = Math.max(1, Math.min(options.concurrency, items.length))
  let cursor = 0
  let aborted = false

  const runLane = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted === true) {
        aborted = true
        return
      }
      const index = cursor
      cursor += 1
      if (index >= items.length) {
        return
      }
      try {
        results[index] = await task(items[index], index)
      } catch (error) {
        failures.set(index, error)
      }
    }
  }

  const running: Promise<void>[] = []
  for (let i = 0; i < lanes; i += 1) {
    running.push(runLane())
  }
  await Promise.all(running)

  return {
    results,
    failures,
    aborted: aborted || options.signal?.aborted === true,
  }
}

/**
 * Default parallelism.
 *
 * Six, because that is the per-origin connection limit browsers apply to
 * HTTP/1.1 — which is what the S3 REST API speaks. Going higher does not move
 * more bytes; the extra requests queue in the network stack while appearing
 * "active" in the UI, which makes a healthy download look stalled.
 *
 * This is also why the module does not use workers: that limit is enforced
 * per-origin across the whole process, not per-thread, so a pool of workers
 * would buy nothing here.
 */
export const HTTP1_PER_ORIGIN_LIMIT = 6

export const defaultConcurrency = (hardwareConcurrency?: number): number => {
  const cores =
    hardwareConcurrency !== undefined && hardwareConcurrency > 0
      ? hardwareConcurrency
      : 4
  return Math.max(1, Math.min(HTTP1_PER_ORIGIN_LIMIT, cores))
}
