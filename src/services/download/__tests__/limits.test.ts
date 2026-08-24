import { assessLimits, DEFAULT_LIMITS, formatBytes } from '../core/limits'
import type { TransferLimits } from '../types'

const GIB = 1024 * 1024 * 1024

const limits: TransferLimits = {
  warnBytes: 5 * GIB,
  refuseBytes: 200 * GIB,
  maxFiles: 20_000,
}

const exact = (bytes: number, files = 1) => ({
  bytes,
  bytesAreExact: true,
  files,
})

describe('formatBytes', () => {
  it('uses bytes below a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('scales through the units', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(GIB)).toBe('1.0 GB')
    expect(formatBytes(1024 * GIB)).toBe('1.0 TB')
  })

  it('drops the decimal once the number is large enough not to need it', () => {
    expect(formatBytes(373 * 1024 * 1024)).toBe('373 MB')
  })
})

describe('assessLimits', () => {
  it('is silent for an ordinary single-slide download', () => {
    const result = assessLimits(exact(373 * 1024 * 1024, 4), limits)
    expect(result.warnings).toEqual([])
    expect(result.blockers).toEqual([])
  })

  it('warns past the warn threshold without blocking', () => {
    const result = assessLimits(exact(10 * GIB), limits)
    expect(result.blockers).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].code).toBe('size-warning')
    // The no-resume caveat is the actionable part of the warning.
    expect(result.warnings[0].message).toContain('cannot resume')
  })

  it('does not warn exactly at the threshold', () => {
    expect(assessLimits(exact(limits.warnBytes), limits).warnings).toEqual([])
  })

  it('blocks past the refuse threshold and does not also warn', () => {
    const result = assessLimits(exact(300 * GIB), limits)
    expect(result.warnings).toEqual([])
    expect(result.blockers).toHaveLength(1)
    expect(result.blockers[0].code).toBe('size-refused')
    expect(result.blockers[0].detail?.bytes).toBe(300 * GIB)
  })

  it('blocks on file count independently of size', () => {
    const result = assessLimits({
      bytes: 1024,
      bytesAreExact: true,
      files: 50_000,
    }, limits)
    expect(result.blockers).toHaveLength(1)
    expect(result.blockers[0].code).toBe('file-count-refused')
  })

  it('can report both blockers at once', () => {
    const result = assessLimits({
      bytes: 300 * GIB,
      bytesAreExact: true,
      files: 50_000,
    }, limits)
    expect(result.blockers.map((b) => b.code).sort()).toEqual([
      'file-count-refused',
      'size-refused',
    ])
  })

  it('refuses a lower-bound total that already exceeds the limit', () => {
    // An inexact total can only be larger than reported, so exceeding the
    // refuse threshold is already conclusive.
    const result = assessLimits(
      { bytes: 300 * GIB, bytesAreExact: false, files: 10 },
      limits,
    )
    expect(result.blockers.map((b) => b.code)).toEqual(['size-refused'])
  })

  it('marks an inexact warning total as a lower bound in its message', () => {
    const result = assessLimits(
      { bytes: 10 * GIB, bytesAreExact: false, files: 10 },
      limits,
    )
    expect(result.warnings[0].message).toContain('or more')
  })

  it('ships defaults scaled for a viewer rather than cohort export', () => {
    // A single slide must never trip the warning; a whole large study should.
    expect(assessLimits(exact(1 * GIB), DEFAULT_LIMITS).warnings).toEqual([])
    expect(
      assessLimits(exact(50 * GIB), DEFAULT_LIMITS).warnings[0].code,
    ).toBe('size-warning')
  })
})
