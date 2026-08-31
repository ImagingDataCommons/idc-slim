import {
  backoffDelayMs,
  DEFAULT_RETRY_POLICY,
  isRetryAfterAcceptable,
  isRetryableS3Code,
  isRetryableStatus,
  parseRetryAfter,
} from '../core/retry'

describe('isRetryableStatus', () => {
  it('retries transient server and throttle statuses', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true)
    }
  })

  it('does not retry client errors', () => {
    // A 403 against public archive data means a wrong prefix or bucket.
    // Retrying converts an immediately diagnosable failure into a slow one.
    for (const status of [400, 401, 403, 404, 405, 409, 501]) {
      expect(isRetryableStatus(status)).toBe(false)
    }
  })

  it('does not retry success', () => {
    expect(isRetryableStatus(200)).toBe(false)
    expect(isRetryableStatus(206)).toBe(false)
  })
})

describe('isRetryableS3Code', () => {
  it('recognises transient S3 codes', () => {
    expect(isRetryableS3Code('SlowDown')).toBe(true)
    expect(isRetryableS3Code('InternalError')).toBe(true)
    expect(isRetryableS3Code('ServiceUnavailable')).toBe(true)
    expect(isRetryableS3Code('RequestTimeout')).toBe(true)
  })

  it('does not retry permanent S3 codes', () => {
    expect(isRetryableS3Code('NoSuchKey')).toBe(false)
    expect(isRetryableS3Code('NoSuchBucket')).toBe(false)
    expect(isRetryableS3Code('AccessDenied')).toBe(false)
  })

  it('treats an absent code as not retryable', () => {
    expect(isRetryableS3Code(undefined)).toBe(false)
  })
})

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-08-23T12:00:00Z')

  it('reads the delay-seconds form', () => {
    expect(parseRetryAfter('5', now)).toBe(5000)
    expect(parseRetryAfter('0', now)).toBe(0)
    expect(parseRetryAfter('  7  ', now)).toBe(7000)
  })

  it('reads the HTTP-date form', () => {
    expect(parseRetryAfter('Sun, 23 Aug 2026 12:00:30 GMT', now)).toBe(30_000)
  })

  it('clamps a past date to zero rather than returning a negative delay', () => {
    expect(parseRetryAfter('Sun, 23 Aug 2026 11:59:00 GMT', now)).toBe(0)
  })

  it('returns undefined for absent or unparseable values', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined()
    expect(parseRetryAfter('', now)).toBeUndefined()
    expect(parseRetryAfter('   ', now)).toBeUndefined()
    expect(parseRetryAfter('soon', now)).toBeUndefined()
  })
})

describe('backoffDelayMs', () => {
  const policy = DEFAULT_RETRY_POLICY

  it('applies full jitter, so the delay spans zero to the ceiling', () => {
    // Full jitter is not cosmetic: a throttle hits every concurrent transfer at
    // once, so a deterministic backoff re-synchronizes them into another burst.
    expect(backoffDelayMs(0, policy, () => 0)).toBe(0)
    expect(backoffDelayMs(0, policy, () => 1)).toBe(500)
    expect(backoffDelayMs(1, policy, () => 1)).toBe(1000)
    expect(backoffDelayMs(2, policy, () => 1)).toBe(2000)
    expect(backoffDelayMs(3, policy, () => 1)).toBe(4000)
  })

  it('spreads samples across the window rather than clustering', () => {
    const ceiling = 2000
    const samples = [0.1, 0.5, 0.9].map((r) =>
      backoffDelayMs(2, policy, () => r),
    )
    expect(samples).toEqual([200, 1000, 1800])
    for (const sample of samples) {
      expect(sample).toBeLessThanOrEqual(ceiling)
    }
  })

  it('caps exponential growth at maxDelayMs', () => {
    expect(backoffDelayMs(10, policy, () => 1)).toBe(policy.maxDelayMs)
  })

  it('prefers an acceptable Retry-After over its own estimate', () => {
    expect(backoffDelayMs(0, policy, () => 1, 3000)).toBe(3000)
  })

  it('ignores a Retry-After beyond the cap and falls back to backoff', () => {
    const tooLong = policy.maxRetryAfterMs + 1
    expect(backoffDelayMs(0, policy, () => 1, tooLong)).toBe(500)
  })
})

describe('isRetryAfterAcceptable', () => {
  it('accepts an absent header', () => {
    expect(isRetryAfterAcceptable(undefined, DEFAULT_RETRY_POLICY)).toBe(true)
  })

  it('rejects a wait long enough that failing is better than blocking', () => {
    expect(isRetryAfterAcceptable(30_000, DEFAULT_RETRY_POLICY)).toBe(true)
    expect(isRetryAfterAcceptable(30_001, DEFAULT_RETRY_POLICY)).toBe(false)
  })
})
