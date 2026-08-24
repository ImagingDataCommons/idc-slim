/**
 * Retry classification and backoff. Pure — no clock, no randomness source of
 * its own, no I/O — so every branch is directly assertable.
 *
 * The reference implementation this module replaces has no retry logic at all,
 * which matters most for exactly the shape of load it generates: several
 * concurrent transfers against a single object-store origin is what draws
 * throttling, so a transient 503 permanently loses a file rather than delaying
 * it.
 */

import type { RetryPolicy } from '../types'

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 30_000,
}

/**
 * Statuses worth retrying. 429 and 5xx are transient by definition; 408 is a
 * server-side read timeout.
 *
 * 400, 401, 403 and 404 are deliberately absent. A 403 against public archive
 * data almost always means a wrong prefix or bucket, and retrying it converts
 * an immediate, diagnosable failure into a slow one.
 */
const RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504]

export const isRetryableStatus = (status: number): boolean =>
  RETRYABLE_STATUSES.indexOf(status) !== -1

/**
 * S3 error codes that indicate a transient condition.
 *
 * These are read from the response body because S3 can return an error document
 * under HTTP 200, so status alone is not sufficient to classify a listing.
 */
const RETRYABLE_S3_CODES = [
  'SlowDown',
  'InternalError',
  'ServiceUnavailable',
  'RequestTimeout',
  'RequestTimeTooSkewed',
]

export const isRetryableS3Code = (code: string | undefined): boolean =>
  code !== undefined && RETRYABLE_S3_CODES.indexOf(code) !== -1

/**
 * Parses a `Retry-After` header. Supports both forms in the spec: delay in
 * seconds, and an HTTP date.
 *
 * `now` is passed in rather than read from the clock so the date branch is
 * testable without faking timers.
 */
export const parseRetryAfter = (
  header: string | null,
  now: number,
): number | undefined => {
  if (header === null) {
    return undefined
  }
  const trimmed = header.trim()
  if (trimmed === '') {
    return undefined
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000
  }
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) {
    return undefined
  }
  // A date in the past means "retry now", not "retry in the negative past".
  return Math.max(0, at - now)
}

/**
 * Delay before the given attempt, with **full jitter**.
 *
 * Jitter is not a refinement here. Throttling hits every concurrent transfer at
 * roughly the same moment, so a deterministic backoff re-synchronizes them all
 * into another simultaneous burst; spreading them across the window is what
 * actually lets the throttle clear.
 *
 * @param attempt zero-based index of the attempt that just failed
 * @param random  injected [0,1) source, so tests are deterministic
 */
export const backoffDelayMs = (
  attempt: number,
  policy: RetryPolicy,
  random: () => number,
  retryAfterMs?: number,
): number => {
  // An explicit server instruction beats our guess, up to a sanity cap.
  if (retryAfterMs !== undefined && retryAfterMs <= policy.maxRetryAfterMs) {
    return retryAfterMs
  }
  const uncapped = policy.baseDelayMs * policy.factor ** attempt
  const ceiling = Math.min(uncapped, policy.maxDelayMs)
  return Math.round(random() * ceiling)
}

/**
 * Whether a `Retry-After` is so long that waiting is worse than failing. A
 * caller that gets `false` here should surface the failure rather than block a
 * download for minutes.
 */
export const isRetryAfterAcceptable = (
  retryAfterMs: number | undefined,
  policy: RetryPolicy,
): boolean =>
  retryAfterMs === undefined || retryAfterMs <= policy.maxRetryAfterMs
