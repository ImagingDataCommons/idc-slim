/**
 * The orchestrator, and the module's only stateful object.
 *
 * The API is split into four calls along the browser's user-activation
 * boundary, which is the single most important shape decision here:
 *
 *   1. `prepare()`  — pure network. No gesture needed, so it can run when a
 *                     dialog opens and the UI can show exact byte counts,
 *                     licenses and warnings before the user commits.
 *   2. the user clicks Confirm — a *fresh* activation.
 *   3. `pickDestination()` — must be the first statement of that click handler.
 *   4. `verifyDestination()` then `start()`.
 *
 * Getting this order wrong is the classic failure: the reference implementation
 * opens the directory picker first and only then discovers a size, license or
 * path problem, so it can end up cancelling after the user has already chosen a
 * folder. Splitting the calls makes the correct order the only expressible one.
 */

import { joinSegments, seriesDirectorySegments } from './core/layout'
import { DEFAULT_LIMITS } from './core/limits'
import { createManifestWriter, type ManifestWriter } from './core/manifest'
import { buildPlan, type ListedObject, withLayout } from './core/plan'
import { createProgressTracker } from './core/progress'
import { DEFAULT_RETRY_POLICY } from './core/retry'
import { defaultConcurrency, runBounded } from './core/scheduler'
import { TransferError, transferFile } from './core/transfer'
import type { DirectorySink } from './sinks/types'
import { listObjects } from './sources/s3List'
import type {
  Capabilities,
  DownloadJob,
  DownloadPlan,
  DownloadProgress,
  DownloadReport,
  FallbackRecipe,
  FileFailure,
  HttpLike,
  LayoutKind,
  Logger,
  ResolvedSeries,
  ResolveResult,
  RetryPolicy,
  SeriesResolver,
  SeriesSelector,
  TransferLimits,
} from './types'

export class DownloadBusyError extends Error {
  constructor() {
    super('A download is already running')
    this.name = 'DownloadBusyError'
    Object.setPrototypeOf(this, DownloadBusyError.prototype)
  }
}

export class DownloadBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadBlockedError'
    Object.setPrototypeOf(this, DownloadBlockedError.prototype)
  }
}

export interface DownloadServiceConfig {
  resolver: SeriesResolver
  http?: HttpLike
  capabilities?: Capabilities
  concurrency?: number
  listConcurrency?: number
  layout?: LayoutKind
  limits?: Partial<TransferLimits>
  retry?: Partial<RetryPolicy>
  progressIntervalMs?: number
  writeManifestForFlatLayout?: boolean
  skipExistingBySize?: boolean
  now?: () => number
  randomId?: () => string
  random?: () => number
  sleep?: (ms: number) => Promise<void>
  logger?: Logger
}

export interface PrepareResult {
  plan: DownloadPlan
  /** Kept so a later `withLayout` can re-project paths. */
  resolved: ResolveResult
}

export interface DownloadService {
  readonly capabilities: Capabilities | undefined
  readonly activeJob: DownloadJob | null
  prepare: (
    selector: SeriesSelector,
    options?: { signal?: AbortSignal },
  ) => Promise<PrepareResult>
  relayout: (prepared: PrepareResult, layout: LayoutKind) => PrepareResult
  start: (plan: DownloadPlan, sink: DirectorySink) => DownloadJob
  describeFallback: (
    selector: SeriesSelector,
    resolved?: ResolveResult | null,
  ) => FallbackRecipe | null
}

const defaultSleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms))

const defaultHttp = (): HttpLike =>
  (async (url, init) =>
    // Cast because the module's HttpLike is intentionally narrower than fetch.
    (await fetch(url, init as RequestInit)) as unknown as Awaited<
      ReturnType<HttpLike>
    >) as HttpLike

let idCounter = 0

export const createDownloadService = (
  config: DownloadServiceConfig,
): DownloadService => {
  const http = config.http ?? defaultHttp()
  const now = config.now ?? (() => Date.now())
  const random = config.random ?? (() => Math.random())
  const sleep = config.sleep ?? defaultSleep
  const layout: LayoutKind = config.layout ?? 'nested'
  const limits: TransferLimits = { ...DEFAULT_LIMITS, ...config.limits }
  const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...config.retry }
  const log: Logger = config.logger ?? (() => undefined)
  const nextId =
    config.randomId ??
    (() => {
      idCounter += 1
      return `dl-${idCounter}`
    })

  let activeJob: DownloadJob | null = null

  const prepare = async (
    selector: SeriesSelector,
    options?: { signal?: AbortSignal },
  ): Promise<PrepareResult> => {
    const controller = new AbortController()
    const signal = options?.signal ?? controller.signal

    const resolved = await config.resolver.resolve(selector, { signal, http })
    log('debug', 'resolved series', {
      resolved: resolved.series.length,
      unresolved: resolved.unresolved.length,
    })

    // Listing is a separate phase so the plan can carry exact sizes. One extra
    // round trip per series buys an accurate total, an accurate ETA, and the
    // per-file size that the transfer verifies against.
    const listings = await runBounded(
      resolved.series,
      async (series) => {
        const objects: ListedObject[] = []
        for (const source of series.sources) {
          const listed = await listObjects(source, {
            http,
            signal,
            retry,
            now,
            random,
            sleep,
          })
          for (const object of listed) {
            objects.push({
              seriesInstanceUID: series.seriesInstanceUID,
              baseUrl: source.baseUrl,
              key: object.key,
              size: object.size,
            })
          }
        }
        return objects
      },
      { concurrency: config.listConcurrency ?? 4, signal },
    )

    const objects: ListedObject[] = []
    for (const group of listings.results) {
      if (group !== undefined) {
        for (const object of group) {
          objects.push(object)
        }
      }
    }

    // A series whose listing failed is reported as unresolved rather than
    // silently omitted, so the plan's counts stay honest.
    const failedUids: string[] = []
    listings.failures.forEach((error, index) => {
      const series = resolved.series[index]
      if (series !== undefined) {
        failedUids.push(series.seriesInstanceUID)
        log('warn', 'listing failed', {
          series: series.seriesInstanceUID,
          error,
        })
      }
    })

    const usableSeries = resolved.series.filter(
      (series) => failedUids.indexOf(series.seriesInstanceUID) === -1,
    )

    const plan = buildPlan({
      id: nextId(),
      layout,
      series: usableSeries,
      objects,
      unresolved: [...resolved.unresolved, ...failedUids],
      limits,
      mobile: config.capabilities?.platform.mobile,
    })

    return { plan, resolved: { ...resolved, series: usableSeries } }
  }

  const start = (plan: DownloadPlan, sink: DirectorySink): DownloadJob => {
    if (activeJob !== null) {
      throw new DownloadBusyError()
    }
    if (plan.blockers.length > 0) {
      throw new DownloadBlockedError(plan.blockers[0].message)
    }

    const controller = new AbortController()
    const startedAt = now()
    const failures: FileFailure[] = []
    let bytesWritten = 0
    let filesWritten = 0
    let filesSkipped = 0
    let fatal = false
    let cancelled = false

    const listeners = new Set<(progress: DownloadProgress) => void>()
    const tracker = createProgressTracker({
      bytesTotal: plan.totals.bytes,
      bytesAreExact: plan.totals.bytesAreExact,
      filesTotal: plan.totals.files,
      now,
      intervalMs: config.progressIntervalMs,
      onSnapshot: (snapshot) => {
        listeners.forEach((listener) => {
          listener(snapshot)
        })
      },
    })

    const run = async (): Promise<DownloadReport> => {
      let manifest: ManifestWriter | undefined
      try {
        if (
          plan.layout === 'flat' &&
          (config.writeManifestForFlatLayout ?? true) &&
          plan.series.length > 0
        ) {
          manifest = await createManifestWriter({
            sink,
            directory: seriesDirectorySegments(plan.series[0].facets, 'flat'),
            timestamp: String(startedAt),
          })
        }

        tracker.setPhase('transferring')

        const facetsByUid = new Map<string, ResolvedSeries['facets']>()
        for (const series of plan.series) {
          facetsByUid.set(series.seriesInstanceUID, series.facets)
        }

        await runBounded(
          plan.files,
          async (file) => {
            if (fatal) {
              return
            }
            const key = joinSegments(file.segments)
            const name = file.segments[file.segments.length - 1]
            tracker.startFile(key, name, file.sizeBytes)
            try {
              const result = await transferFile({
                file,
                sink,
                http,
                signal: controller.signal,
                retry,
                random,
                now,
                sleep,
                skipExisting: config.skipExistingBySize ?? true,
                hooks: {
                  onBytes: (bytes) => {
                    tracker.addBytes(key, bytes)
                  },
                  onRewind: (bytes) => {
                    tracker.resetFile(key, bytes)
                  },
                },
              })
              if (result.outcome === 'skipped') {
                filesSkipped += 1
                tracker.finishFile(key, 'skipped')
              } else {
                filesWritten += 1
                bytesWritten += result.bytesWritten
                tracker.finishFile(key, 'completed')
                const facets = facetsByUid.get(file.seriesInstanceUID)
                if (manifest !== undefined && facets !== undefined) {
                  manifest.append(name, facets)
                }
              }
            } catch (error) {
              const transferError =
                error instanceof TransferError
                  ? error
                  : new TransferError(
                      'network',
                      error instanceof Error ? error.message : 'Unknown error',
                      1,
                    )
              if (transferError.code === 'aborted') {
                cancelled = true
                tracker.finishFile(key, 'failed')
                return
              }
              failures.push({
                segments: file.segments,
                url: file.url,
                code: transferError.code,
                status: transferError.status,
                message: transferError.message,
                attempts: transferError.attempts,
              })
              tracker.recordError(transferError.code, transferError.message)
              tracker.finishFile(key, 'failed')
              if (transferError.fatal) {
                // The disk is full or the grant is gone. Continuing produces
                // one failure per remaining file and nothing useful.
                fatal = true
                controller.abort()
              }
            }
          },
          {
            concurrency: config.concurrency ?? defaultConcurrency(),
            signal: controller.signal,
          },
        )

        tracker.setPhase('finalizing')
        if (manifest !== undefined) {
          if (cancelled || fatal) {
            await manifest.abort()
          } else {
            await manifest.close()
          }
        }
      } catch (error) {
        log('error', 'download failed', error)
        if (manifest !== undefined) {
          await manifest.abort()
        }
        fatal = true
      }

      const outcome: DownloadReport['outcome'] = fatal
        ? 'failed'
        : cancelled || controller.signal.aborted
          ? 'cancelled'
          : failures.length > 0
            ? 'completed-with-errors'
            : 'completed'

      tracker.setPhase(
        outcome === 'completed' || outcome === 'completed-with-errors'
          ? 'completed'
          : outcome === 'cancelled'
            ? 'cancelled'
            : 'failed',
      )
      tracker.flush()
      tracker.dispose()
      activeJob = null

      return {
        outcome,
        filesWritten,
        filesSkipped,
        filesFailed: failures.length,
        bytesWritten,
        durationMs: now() - startedAt,
        failures,
        manifestPath:
          manifest !== undefined && outcome !== 'failed'
            ? joinSegments(manifest.path)
            : undefined,
      }
    }

    const job: DownloadJob = {
      id: plan.id,
      // Never rejects: failures are data, so a host cannot leave one unhandled.
      done: run(),
      get progress(): DownloadProgress {
        return tracker.snapshot
      },
      cancel: (reason) => {
        cancelled = true
        log('info', 'download cancelled', { reason })
        controller.abort()
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }

    activeJob = job
    return job
  }

  return {
    get capabilities(): Capabilities | undefined {
      return config.capabilities
    },
    get activeJob(): DownloadJob | null {
      return activeJob
    },
    prepare,
    relayout: (prepared, nextLayout) => ({
      plan: withLayout(prepared.plan, nextLayout, prepared.resolved.series),
      resolved: prepared.resolved,
    }),
    start,
    describeFallback: (selector, resolved) =>
      config.resolver.describeFallback?.(selector, resolved ?? null) ?? null,
  }
}
