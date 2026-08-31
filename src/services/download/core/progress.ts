/**
 * Progress accounting: counters, throttled snapshots, and rate/ETA estimation.
 *
 * Two decisions here are deliberate departures from the obvious approach.
 *
 * The rate is an exponentially-weighted average over a short window, not total
 * bytes over total elapsed time. A since-start average is badly wrong after any
 * stall, and whole-slide downloads stall routinely — one multi-hundred-megabyte
 * instance, a throttle, disk contention. A stale average then reports a
 * confident, wrong ETA for the rest of the transfer.
 *
 * And `etaSeconds` is nullable. When the total is only a lower bound, or no
 * bytes have moved yet, there is no honest estimate, and emitting a fabricated
 * one is worse than emitting nothing.
 */

import type {
  ActiveFileProgress,
  DownloadPhase,
  DownloadProgress,
} from '../types'

/** Half-life of the rate estimate. Long enough to ride out a single stalled
 * chunk, short enough to react within a few seconds of a real slowdown. */
const RATE_WINDOW_MS = 5_000

export interface ProgressTrackerOptions {
  bytesTotal: number
  bytesAreExact: boolean
  filesTotal: number
  now: () => number
  /** Minimum gap between emitted snapshots, in ms. */
  intervalMs?: number
  onSnapshot?: (progress: DownloadProgress) => void
}

export interface ProgressTracker {
  readonly snapshot: DownloadProgress
  setPhase: (phase: DownloadPhase) => void
  /** Revises the totals once listing has produced exact figures. */
  setTotals: (
    bytesTotal: number,
    bytesAreExact: boolean,
    filesTotal: number,
  ) => void
  startFile: (key: string, name: string, bytesTotal: number | null) => void
  addBytes: (key: string, bytes: number) => void
  /** Resets a file's counted bytes, for a retry that restarts from zero. */
  resetFile: (key: string, bytesWritten: number) => void
  finishFile: (key: string, outcome: 'completed' | 'skipped' | 'failed') => void
  recordError: (code: string, message: string) => void
  /** Emits immediately, ignoring the throttle. For terminal states. */
  flush: () => void
  dispose: () => void
}

interface ActiveEntry {
  name: string
  bytesWritten: number
  bytesTotal: number | null
}

export const createProgressTracker = (
  options: ProgressTrackerOptions,
): ProgressTracker => {
  const { now, onSnapshot } = options
  const intervalMs = options.intervalMs ?? 250

  let phase: DownloadPhase = 'idle'
  let bytesTotal = options.bytesTotal
  let bytesAreExact = options.bytesAreExact
  let filesTotal = options.filesTotal
  let bytesWritten = 0
  let filesCompleted = 0
  let filesSkipped = 0
  let filesFailed = 0
  let lastError: { code: string; message: string } | undefined

  const active = new Map<string, ActiveEntry>()

  let rate = 0
  let rateSampledAt = -1
  let lastEmitAt = -1
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const buildSnapshot = (): DownloadProgress => {
    const activeList: ActiveFileProgress[] = []
    active.forEach((entry) => {
      activeList.push({
        name: entry.name,
        bytesWritten: entry.bytesWritten,
        bytesTotal: entry.bytesTotal,
      })
    })
    const remaining = bytesTotal - bytesWritten
    const etaSeconds =
      bytesAreExact && rate > 0 && remaining > 0
        ? Math.round(remaining / rate)
        : null
    return {
      phase,
      bytesTotal,
      bytesAreExact,
      bytesWritten,
      filesTotal,
      filesCompleted,
      filesSkipped,
      filesFailed,
      bytesPerSecond: Math.round(rate),
      etaSeconds,
      active: activeList,
      lastError,
    }
  }

  let snapshot = buildSnapshot()

  const emit = (): void => {
    snapshot = buildSnapshot()
    dirty = false
    lastEmitAt = now()
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    onSnapshot?.(snapshot)
  }

  /**
   * Emits at most once per interval. A trailing timer is scheduled rather than
   * polling on an interval, so a quiet download costs nothing.
   */
  const schedule = (): void => {
    if (disposed) {
      return
    }
    dirty = true
    const at = now()
    if (lastEmitAt < 0 || at - lastEmitAt >= intervalMs) {
      emit()
      return
    }
    if (timer === undefined) {
      timer = setTimeout(
        () => {
          timer = undefined
          if (dirty && !disposed) {
            emit()
          }
        },
        intervalMs - (at - lastEmitAt),
      )
    }
  }

  const sampleRate = (bytes: number): void => {
    const at = now()
    if (rateSampledAt < 0) {
      rateSampledAt = at
      return
    }
    const elapsed = at - rateSampledAt
    if (elapsed <= 0) {
      return
    }
    rateSampledAt = at
    const instant = (bytes / elapsed) * 1000
    // Weight by how much of the window this sample covers, so a long gap moves
    // the estimate further than a rapid burst of small chunks.
    const weight = Math.min(1, elapsed / RATE_WINDOW_MS)
    rate = rate === 0 ? instant : rate + (instant - rate) * weight
  }

  return {
    get snapshot(): DownloadProgress {
      return snapshot
    },

    setPhase: (next) => {
      phase = next
      // Phase transitions always emit: they drive visible UI changes and are
      // rare enough that throttling them only adds latency.
      emit()
    },

    setTotals: (nextBytes, nextExact, nextFiles) => {
      bytesTotal = nextBytes
      bytesAreExact = nextExact
      filesTotal = nextFiles
      schedule()
    },

    startFile: (key, name, total) => {
      active.set(key, { name, bytesWritten: 0, bytesTotal: total })
      schedule()
    },

    addBytes: (key, bytes) => {
      bytesWritten += bytes
      const entry = active.get(key)
      if (entry !== undefined) {
        entry.bytesWritten += bytes
      }
      sampleRate(bytes)
      schedule()
    },

    resetFile: (key, previouslyWritten) => {
      bytesWritten -= previouslyWritten
      const entry = active.get(key)
      if (entry !== undefined) {
        entry.bytesWritten = 0
      }
      schedule()
    },

    finishFile: (key, outcome) => {
      active.delete(key)
      if (outcome === 'completed') {
        filesCompleted += 1
      } else if (outcome === 'skipped') {
        filesSkipped += 1
      } else {
        filesFailed += 1
      }
      // With few files, each completion is a large fraction of the whole, so
      // emit eagerly rather than leaving the bar visibly stale.
      if (filesTotal < 20) {
        emit()
      } else {
        schedule()
      }
    },

    recordError: (code, message) => {
      lastError = { code, message }
      schedule()
    },

    flush: () => {
      emit()
    },

    dispose: () => {
      disposed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}
