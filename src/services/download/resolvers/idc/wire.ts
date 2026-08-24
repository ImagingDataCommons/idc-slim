/**
 * Wire types and defensive parsing for the IDC v3 `cohort/manifest` response.
 *
 * The API is a beta (`api_version 3.0.0b3` at the time of writing), so this file
 * is the blast radius for any drift in its shape. Everything is validated rather
 * than trusted, and a response that does not match yields zero rows instead of
 * throwing — which the host reads as "not available for direct download" and
 * degrades to command-line instructions. A schema change should therefore
 * disable the feature, never break the viewer.
 */

export interface ManifestRow {
  seriesInstanceUID: string
  studyInstanceUID: string
  /** One or more buckets. `aws_bucket` may arrive as a string or an array. */
  buckets: string[]
  crdcSeriesUuid?: string
  collectionId?: string
  patientId?: string
  modality?: string
  instanceCount?: number
  sizeMb?: number
}

export interface ManifestResponse {
  rows: ManifestRow[]
  totalSeries: number
  warnings: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/**
 * Normalizes a bucket field to a list.
 *
 * The array case is real, not hypothetical: the field can carry more than one
 * bucket, and interpolating it straight into a hostname yields `"a,b"` and a
 * request that cannot succeed.
 */
const asBuckets = (value: unknown): string[] => {
  if (typeof value === 'string') {
    const single = asString(value)
    return single === undefined ? [] : [single]
  }
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const entry of value) {
      const bucket = asString(entry)
      if (bucket !== undefined && out.indexOf(bucket) === -1) {
        out.push(bucket)
      }
    }
    return out
  }
  return []
}

const parseRow = (value: unknown): ManifestRow | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const seriesInstanceUID = asString(value.SeriesInstanceUID)
  const studyInstanceUID = asString(value.StudyInstanceUID)
  if (seriesInstanceUID === undefined || studyInstanceUID === undefined) {
    // Without both identifiers the row can neither be matched to a request nor
    // placed on disk.
    return undefined
  }
  return {
    seriesInstanceUID,
    studyInstanceUID,
    buckets: asBuckets(value.aws_bucket),
    crdcSeriesUuid: asString(value.crdc_series_uuid),
    collectionId: asString(value.collection_id),
    patientId: asString(value.PatientID),
    modality: asString(value.Modality),
    instanceCount: asNumber(value.instanceCount),
    sizeMb: asNumber(value.series_size_MB),
  }
}

const parseWarnings = (counts: unknown): string[] => {
  if (!isRecord(counts) || !Array.isArray(counts.warnings)) {
    return []
  }
  const out: string[] = []
  for (const entry of counts.warnings) {
    const warning = asString(entry)
    if (warning !== undefined) {
      out.push(warning)
    }
  }
  return out
}

export const parseManifestResponse = (payload: unknown): ManifestResponse => {
  if (!isRecord(payload)) {
    return { rows: [], totalSeries: 0, warnings: [] }
  }

  const rows: ManifestRow[] = []
  if (Array.isArray(payload.series)) {
    for (const entry of payload.series) {
      const row = parseRow(entry)
      if (row !== undefined) {
        rows.push(row)
      }
    }
  }

  // Prefer the server's own count, but never report fewer than we actually
  // parsed — otherwise pagination would stop early and truncate the download.
  const reported = asNumber(payload.total_series) ?? 0

  return {
    rows,
    totalSeries: Math.max(reported, rows.length),
    warnings: parseWarnings(payload.counts),
  }
}
