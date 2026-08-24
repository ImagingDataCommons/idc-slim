/**
 * The per-file pump: one remote object to one file in the sink.
 *
 * This is where the reference implementation's defects were concentrated, so
 * each behaviour here is a deliberate answer to one of them:
 *
 * - Writes are **awaited**, which is what gives the read loop backpressure.
 *   Un-awaited, the writable's queue grows to the difference between network and
 *   disk throughput for the whole transfer.
 * - A cancelled transfer **aborts** the writer and removes a file this run
 *   created. Closing it instead would commit a truncated file under the correct
 *   final name, indistinguishable from a complete one — and `abort()` alone can
 *   still leave a zero-byte file, which looks just as real.
 * - The written byte count is **verified** against the size the listing
 *   reported. This is the only defence against a truncated file of any cause,
 *   and it costs nothing because the listing already carries the size.
 * - Retries **resume from the byte offset already on disk** via a `Range`
 *   request, so a flaky connection costs seconds rather than a restart.
 * - A full disk or a revoked grant is **fatal for the job**, not the file:
 *   retrying three hundred more files just produces three hundred more errors.
 */

import {
  type ByteWriter,
  type DirectorySink,
  isFatalSinkError,
  SinkError,
} from '../sinks/types'
import type { FailureCode, HttpLike, PlannedFile, RetryPolicy } from '../types'
import { backoffDelayMs, isRetryableStatus, parseRetryAfter } from './retry'

export class TransferError extends Error {
  readonly code: FailureCode
  readonly status?: number
  readonly attempts: number
  /** True when the job must stop, not just this file. */
  readonly fatal: boolean

  constructor(
    code: FailureCode,
    message: string,
    attempts: number,
    status?: number,
    fatal = false,
  ) {
    super(message)
    this.name = 'TransferError'
    this.code = code
    this.status = status
    this.attempts = attempts
    this.fatal = fatal
    Object.setPrototypeOf(this, TransferError.prototype)
  }
}

export type TransferOutcome = 'written' | 'skipped'

export interface TransferResult {
  outcome: TransferOutcome
  bytesWritten: number
  attempts: number
}

export interface TransferHooks {
  /** Called with each chunk's length as it is written. */
  onBytes?: (bytes: number) => void
  /** Called when a retry discards progress, so a counter can be rewound. */
  onRewind?: (bytesDiscarded: number) => void
}

export interface TransferOptions {
  file: PlannedFile
  sink: DirectorySink
  http: HttpLike
  signal: AbortSignal
  retry: RetryPolicy
  random: () => number
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Skip a file already present at exactly the expected size. Default true. */
  skipExisting?: boolean
  hooks?: TransferHooks
}

const classifySinkError = (error: unknown): TransferError => {
  if (error instanceof SinkError) {
    const code: FailureCode =
      error.code === 'quota'
        ? 'quota'
        : error.code === 'permission'
          ? 'permission'
          : 'sink'
    return new TransferError(
      code,
      error.message,
      1,
      undefined,
      isFatalSinkError(error),
    )
  }
  return new TransferError(
    'sink',
    error instanceof Error ? error.message : 'Sink failure',
    1,
  )
}

/** Safely abort a writer and drop a file this run created. */
const discard = async (
  writer: ByteWriter,
  sink: DirectorySink,
  segments: readonly string[],
  createdNew: boolean,
): Promise<void> => {
  try {
    await writer.abort()
  } catch {
    // Nothing useful to do: we are already on a failure path, and the writer
    // may legitimately have settled.
  }
  if (!createdNew) {
    return
  }
  try {
    // abort() discards the swap file, but the entry created by opening for
    // write can survive as a zero-byte file, which reads as a real DICOM object.
    await sink.remove(segments)
  } catch {
    // Best effort.
  }
}

export const transferFile = async (
  options: TransferOptions,
): Promise<TransferResult> => {
  const { file, sink, http, signal, retry, hooks } = options
  const segments = file.segments
  const expected = file.sizeBytes

  if (signal.aborted) {
    throw new TransferError('aborted', 'Cancelled before starting', 0)
  }

  let existing: { size: number } | null = null
  try {
    existing = await sink.stat(segments)
  } catch (error) {
    throw classifySinkError(error)
  }

  if (
    (options.skipExisting ?? true) &&
    existing !== null &&
    expected !== null &&
    existing.size === expected
  ) {
    return { outcome: 'skipped', bytesWritten: 0, attempts: 0 }
  }

  const createdNew = existing === null

  let writer: ByteWriter
  try {
    writer = await sink.open(segments)
  } catch (error) {
    throw classifySinkError(error)
  }

  let position = 0
  let attempt = 0
  let settled = false

  try {
    for (;;) {
      if (signal.aborted) {
        throw new TransferError('aborted', 'Cancelled', attempt)
      }

      let retryable = false
      let retryAfterMs: number | undefined
      let failureCode: FailureCode = 'network'
      let failureMessage = 'Transfer failed'
      let failureStatus: number | undefined

      try {
        const headers: Record<string, string> = {}
        if (position > 0) {
          headers.Range = `bytes=${position}-`
        }
        const response = await http(file.url, { signal, headers })

        if (!response.ok) {
          failureStatus = response.status
          failureCode = 'http'
          failureMessage = `HTTP ${response.status} for ${file.url}`
          retryable = isRetryableStatus(response.status)
          retryAfterMs = parseRetryAfter(
            response.headers.get('retry-after'),
            options.now(),
          )
        } else {
          // A ranged request answered with 200 means the server ignored the
          // range and is sending the whole object, so previously written bytes
          // must go or the file ends up with a duplicated prefix.
          if (position > 0 && response.status !== 206) {
            await writer.truncate(0)
            hooks?.onRewind?.(position)
            position = 0
          }

          const body = response.body
          if (body === null) {
            failureCode = 'network'
            failureMessage = `Empty response body for ${file.url}`
            retryable = true
          } else {
            const reader = body.getReader()
            for (;;) {
              const { done, value } = await reader.read()
              if (done) {
                break
              }
              // Checked after the read rather than before the write so a
              // cancellation cannot leave a chunk half-applied.
              if (signal.aborted) {
                await reader.cancel?.()
                throw new TransferError('aborted', 'Cancelled', attempt)
              }
              if (value !== undefined && value.byteLength > 0) {
                await writer.write(value)
                position += value.byteLength
                hooks?.onBytes?.(value.byteLength)
              }
            }

            if (expected !== null && position !== expected) {
              // Short or over-long body. Treated as retryable because a
              // truncated response is usually a transport problem, and the
              // range-resume path can finish the job.
              failureCode = 'size-mismatch'
              failureMessage = `Expected ${expected} bytes but wrote ${position} for ${file.url}`
              retryable = true
            } else {
              await writer.close()
              settled = true
              return {
                outcome: 'written',
                bytesWritten: position,
                attempts: attempt + 1,
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof TransferError) {
          throw error
        }
        if (error instanceof SinkError) {
          // A sink failure is not a transport problem; retrying the download
          // will not create disk space or restore a permission.
          throw classifySinkError(error)
        }
        if (signal.aborted) {
          throw new TransferError('aborted', 'Cancelled', attempt)
        }
        retryable = true
        failureCode = 'network'
        failureMessage =
          error instanceof Error ? error.message : 'Network error'
      }

      attempt += 1
      if (!retryable || attempt >= retry.maxAttempts) {
        throw new TransferError(
          failureCode,
          failureMessage,
          attempt,
          failureStatus,
        )
      }
      await options.sleep(
        backoffDelayMs(attempt - 1, retry, options.random, retryAfterMs),
      )
    }
  } catch (error) {
    if (!settled) {
      await discard(writer, sink, segments, createdNew)
    }
    throw error
  }
}
