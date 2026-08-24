/**
 * Builds a `DownloadPlan` from resolved series plus their object listings. Pure.
 *
 * Everything the UI needs to decide whether to offer a download comes out of
 * here, so the React layer never has to probe several things and combine them
 * itself: exact totals, the license union, warnings, and blockers.
 */

import type {
  DownloadPlan,
  LayoutKind,
  LicenseInfo,
  PlanIssue,
  PlannedFile,
  PlannedSeries,
  ResolvedSeries,
  TransferLimits,
} from '../types'
import {
  fileNameFromKey,
  fileSegments,
  joinSegments,
  projectLongestPathLength,
} from './layout'
import { assessLimits } from './limits'

/** One listed object, paired with the series and source it came from. */
export interface ListedObject {
  seriesInstanceUID: string
  /** Origin the key was listed from, used to build the object URL. */
  baseUrl: string
  key: string
  size: number | null
}

export interface BuildPlanInput {
  id: string
  layout: LayoutKind
  series: readonly ResolvedSeries[]
  objects: readonly ListedObject[]
  unresolved: readonly string[]
  limits: TransferLimits
  /** Adds a warning when the host reports a mobile browser. */
  mobile?: boolean
}

const dedupeLicenses = (series: readonly ResolvedSeries[]): LicenseInfo[] => {
  const byId = new Map<string, LicenseInfo>()
  for (const entry of series) {
    if (entry.license !== undefined && !byId.has(entry.license.id)) {
      byId.set(entry.license.id, entry.license)
    }
  }
  return Array.from(byId.values())
}

const dedupeCitations = (series: readonly ResolvedSeries[]): string[] => {
  const seen: string[] = []
  for (const entry of series) {
    if (entry.citation !== undefined && seen.indexOf(entry.citation) === -1) {
      seen.push(entry.citation)
    }
  }
  return seen
}

/**
 * Assembles the plan.
 *
 * Objects are keyed by their destination path rather than by URL, so two sources
 * offering the same object cannot produce two writers racing on one file. A
 * genuine conflict — same path, different size — is surfaced as a warning
 * instead of being resolved silently, because either answer could be wrong.
 */
export const buildPlan = (input: BuildPlanInput): DownloadPlan => {
  const byUid = new Map<string, ResolvedSeries>()
  for (const entry of input.series) {
    byUid.set(entry.seriesInstanceUID, entry)
  }

  const files: PlannedFile[] = []
  const byPath = new Map<string, PlannedFile>()
  const conflicts: string[] = []
  const perSeries = new Map<string, { count: number; bytes: number }>()
  const pathEntries: Array<{
    facets: ResolvedSeries['facets']
    fileName: string
  }> = []

  let bytes = 0
  let bytesAreExact = true

  for (const object of input.objects) {
    const series = byUid.get(object.seriesInstanceUID)
    if (series === undefined) {
      // A listing for a series that is not in the plan; nothing sane to do
      // with it, and including it would produce a file with no identifiers.
      continue
    }

    const fileName = fileNameFromKey(object.key)
    const segments = fileSegments(series.facets, input.layout, fileName)
    const path = joinSegments(segments)
    const existing = byPath.get(path)

    if (existing !== undefined) {
      if (existing.sizeBytes !== object.size) {
        conflicts.push(path)
      }
      continue
    }

    const planned: PlannedFile = {
      url: `${object.baseUrl}/${object.key}`,
      sizeBytes: object.size,
      segments,
      seriesInstanceUID: object.seriesInstanceUID,
    }
    byPath.set(path, planned)
    files.push(planned)
    pathEntries.push({ facets: series.facets, fileName })

    if (object.size === null) {
      bytesAreExact = false
    } else {
      bytes += object.size
    }

    const totals = perSeries.get(object.seriesInstanceUID) ?? {
      count: 0,
      bytes: 0,
    }
    totals.count += 1
    totals.bytes += object.size ?? 0
    perSeries.set(object.seriesInstanceUID, totals)
  }

  const plannedSeries: PlannedSeries[] = []
  for (const entry of input.series) {
    const totals = perSeries.get(entry.seriesInstanceUID)
    if (totals === undefined) {
      continue
    }
    plannedSeries.push({
      seriesInstanceUID: entry.seriesInstanceUID,
      studyInstanceUID: entry.studyInstanceUID,
      facets: entry.facets,
      fileCount: totals.count,
      bytes: totals.bytes,
      license: entry.license,
    })
  }

  const { warnings, blockers } = assessLimits(
    { bytes, bytesAreExact, files: files.length },
    input.limits,
  )

  if (files.length === 0) {
    blockers.push({
      code: 'nothing-resolved',
      message:
        input.unresolved.length > 0
          ? 'None of these series are available for direct download.'
          : 'No files were found for this selection.',
      detail: { requested: input.unresolved.length },
    })
  } else if (input.unresolved.length > 0) {
    // Routine rather than exceptional: a slide annotated in the viewer has
    // series that exist only on the local server and never in the archive.
    const total = plannedSeries.length + input.unresolved.length
    warnings.push({
      code: 'partial-resolution',
      message:
        `${plannedSeries.length} of ${total} series can be downloaded. ` +
        'The rest are not in the archive — use the command-line instructions ' +
        'for those.',
      detail: {
        available: plannedSeries.length,
        total,
        unresolved: input.unresolved.join(', '),
      },
    })
  }

  const licenses = dedupeLicenses(input.series)
  const restricted = licenses.filter((l) => !l.commercialUseAllowed)
  if (restricted.length > 0) {
    warnings.push({
      code: 'non-commercial-license',
      message: `This data is licensed ${restricted
        .map((l) => l.name)
        .join(', ')} and may not be used commercially.`,
      detail: { licenses: restricted.map((l) => l.id).join(', ') },
    })
  }

  if (conflicts.length > 0) {
    warnings.push({
      code: 'multi-source-series',
      message:
        `${conflicts.length} file(s) were listed more than once with ` +
        'different sizes; the first listing was used.',
      detail: { paths: conflicts.slice(0, 5).join(', ') },
    })
  }

  if (input.mobile === true) {
    warnings.push({
      code: 'mobile-device',
      message:
        'Downloads on a phone or tablet are unreliable and cannot resume. ' +
        'A desktop browser is a better choice for large transfers.',
    })
  }

  const issueOrder: PlanIssue[] = warnings

  return {
    id: input.id,
    layout: input.layout,
    series: plannedSeries,
    files,
    totals: {
      series: plannedSeries.length,
      files: files.length,
      bytes,
      bytesAreExact,
    },
    unresolvedSeriesInstanceUIDs: input.unresolved,
    licenses,
    citations: dedupeCitations(input.series),
    warnings: issueOrder,
    blockers,
    longestRelativePathLength: projectLongestPathLength(
      pathEntries,
      input.layout,
    ),
  }
}

/**
 * Re-projects a plan onto a different layout.
 *
 * Used when the destination turns out to have a path-length limit: the file list
 * and totals are unchanged, only the on-disk paths move.
 */
export const withLayout = (
  plan: DownloadPlan,
  layout: LayoutKind,
  series: readonly ResolvedSeries[],
): DownloadPlan => {
  if (plan.layout === layout) {
    return plan
  }
  const byUid = new Map<string, ResolvedSeries>()
  for (const entry of series) {
    byUid.set(entry.seriesInstanceUID, entry)
  }
  const pathEntries: Array<{
    facets: ResolvedSeries['facets']
    fileName: string
  }> = []
  const files = plan.files.map((file) => {
    const resolved = byUid.get(file.seriesInstanceUID)
    if (resolved === undefined) {
      return file
    }
    const fileName = file.segments[file.segments.length - 1]
    pathEntries.push({ facets: resolved.facets, fileName })
    return {
      ...file,
      segments: fileSegments(resolved.facets, layout, fileName),
    }
  })
  return {
    ...plan,
    layout,
    files,
    longestRelativePathLength: projectLongestPathLength(pathEntries, layout),
  }
}
