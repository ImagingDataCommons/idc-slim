/**
 * Threshold policy: turns a plan's totals into warnings and blockers. Pure.
 *
 * The defaults are scaled for a viewer, not for cohort-scale export. A user who
 * opened one slide is choosing between "download this" and "run a CLI command",
 * so the useful warning threshold is where a download stops being a few minutes
 * of waiting — not where it stops being feasible.
 */

import type { PlanIssue, TransferLimits } from '../types'

const GIB = 1024 * 1024 * 1024

export const DEFAULT_LIMITS: TransferLimits = {
  /** Warn past ~5 GiB: still reasonable to do, but worth an explicit choice. */
  warnBytes: 5 * GIB,
  /**
   * Refuse past ~200 GiB. Not a capability limit — the engine would manage it —
   * but with no resume across a reload, a download measured in hours is a bad
   * bet in a browser tab, and the CLI is genuinely the better tool there.
   */
  refuseBytes: 200 * GIB,
  maxFiles: 20_000,
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export interface LimitInput {
  bytes: number
  /** False when a listing omitted a size, making `bytes` a lower bound. */
  bytesAreExact: boolean
  files: number
}

export interface LimitAssessment {
  warnings: PlanIssue[]
  blockers: PlanIssue[]
}

/**
 * Assesses totals against limits.
 *
 * A lower-bound total that already exceeds the refuse threshold is still
 * refused: the real figure can only be larger. But an inexact total is never
 * used to *clear* a threshold silently — the caller surfaces `bytesAreExact` so
 * the UI can say the size is approximate.
 */
export const assessLimits = (
  input: LimitInput,
  limits: TransferLimits,
): LimitAssessment => {
  const warnings: PlanIssue[] = []
  const blockers: PlanIssue[] = []

  if (input.files > limits.maxFiles) {
    blockers.push({
      code: 'file-count-refused',
      message:
        `This selection contains ${input.files.toLocaleString()} files, ` +
        `more than the ${limits.maxFiles.toLocaleString()} this viewer will ` +
        'download at once. Use the command-line instructions instead.',
      detail: { files: input.files, maxFiles: limits.maxFiles },
    })
  }

  if (input.bytes > limits.refuseBytes) {
    blockers.push({
      code: 'size-refused',
      message:
        `This selection is ${formatBytes(input.bytes)}, more than the ` +
        `${formatBytes(limits.refuseBytes)} this viewer will download at ` +
        'once. Use the command-line instructions instead.',
      detail: { bytes: input.bytes, refuseBytes: limits.refuseBytes },
    })
  } else if (input.bytes > limits.warnBytes) {
    warnings.push({
      code: 'size-warning',
      message:
        `This will download ${formatBytes(input.bytes)}` +
        `${input.bytesAreExact ? '' : ' or more'}. Keep this tab open until ` +
        'it finishes — the transfer cannot resume after a reload.',
      detail: { bytes: input.bytes },
    })
  }

  return { warnings, blockers }
}
