/**
 * Probes whether a destination can hold the plan's deepest path.
 *
 * Windows caps a path at 260 characters, and the plan's nested layout is already
 * around 200 before the user's chosen root — two ~64-character DICOM UIDs plus a
 * 36-character UUID filename. The File System Access API never exposes that
 * root's absolute path (`handle.name` is the leaf only), so the remaining budget
 * cannot be calculated. It has to be measured, by actually creating a directory
 * chain of the right depth and seeing whether the create succeeds.
 *
 * Expressed against `DirectorySink`, so the probe logic is testable against the
 * in-memory sink even though the real limit only exists in a browser on Windows.
 */

import type { DirectorySink } from '../sinks/types'
import { SinkError } from '../sinks/types'
import type { DownloadPlan, LayoutKind } from '../types'

/**
 * Below this, no realistic root pushes the path past 260 characters, so the
 * probe is skipped and its directory churn avoided.
 */
export const PROBE_PATH_LENGTH_THRESHOLD = 180

export type DestinationCheck =
  | { ok: true }
  | {
      ok: false
      kind: 'path-too-long'
      suggestedLayout: LayoutKind
      observedLength: number
    }
  | { ok: false; kind: 'not-writable'; cause?: unknown }

export interface ProbeOptions {
  plan: DownloadPlan
  sink: DirectorySink
  /** From `Capabilities.needsPathLengthProbe`. */
  needsPathLengthProbe: boolean
  /** Injected so probe directory names are deterministic in tests. */
  probeId: string
}

const isPathFailure = (error: unknown): boolean =>
  error instanceof SinkError && error.code === 'path-not-found'

/**
 * Builds a synthetic path whose total length matches the plan's longest, so the
 * probe measures the real worst case rather than a guess.
 */
const syntheticSegments = (root: string, targetLength: number): string[] => {
  const filler = 'a'
  // Two directory levels plus a filename keeps the shape realistic while the
  // length is what actually matters.
  const overhead = root.length + 2 + '.probe'.length
  const remaining = Math.max(8, targetLength - overhead)
  const half = Math.ceil(remaining / 2)
  return [
    root,
    new Array(half + 1).join(filler),
    `${new Array(remaining - half + 1).join(filler)}.probe`,
  ]
}

export const verifyDestination = async (
  options: ProbeOptions,
): Promise<DestinationCheck> => {
  const { plan, sink, probeId } = options
  const root = `slim-download-probe-${probeId}`

  // Always check that the destination is writable at all. A failure here means
  // permissions or a full disk, which is a different problem from depth — the
  // distinction the user-facing message depends on.
  try {
    await sink.mkdirp([root])
  } catch (error) {
    return { ok: false, kind: 'not-writable', cause: error }
  }

  const needsDepthProbe =
    options.needsPathLengthProbe &&
    plan.layout === 'nested' &&
    plan.longestRelativePathLength > PROBE_PATH_LENGTH_THRESHOLD

  if (!needsDepthProbe) {
    await sink.removeDirectory([root]).catch(() => undefined)
    return { ok: true }
  }

  const segments = syntheticSegments(root, plan.longestRelativePathLength)
  try {
    const writer = await sink.open(segments)
    await writer.abort()
    return { ok: true }
  } catch (error) {
    if (isPathFailure(error)) {
      return {
        ok: false,
        kind: 'path-too-long',
        suggestedLayout: 'flat',
        observedLength: plan.longestRelativePathLength,
      }
    }
    return { ok: false, kind: 'not-writable', cause: error }
  } finally {
    // Always clean up, including on the failure paths, so a refused download
    // leaves nothing behind in the user's folder.
    await sink.removeDirectory([root]).catch(() => undefined)
  }
}
