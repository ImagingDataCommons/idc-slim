/**
 * Resolver for the NCI Imaging Data Commons.
 *
 * This is the **only** archive-aware code in the module. Everything it knows —
 * the API host, the bucket-to-URL mapping, the region, the license rules — stops
 * here; the engine receives a finished `baseUrl` and `prefix` and nothing else.
 *
 * Two facts drive the shape:
 *
 * - The IDC REST API is **v3 only**. v1 and v2 are deprecated and must never be
 *   called. `POST /v3/cohort/manifest` filtered by `SeriesInstanceUID` or
 *   `StudyInstanceUID` returns `aws_bucket`, `crdc_series_uuid` and sizes, and
 *   serves `Access-Control-Allow-Origin: *`, which is what makes a browser-side
 *   resolver possible at all.
 * - Only the **AWS** mirrors are usable from a browser. The GCS mirrors of the
 *   same buckets serve no `access-control-*` headers whatsoever, so a
 *   cross-origin fetch against them is blocked regardless of the code here.
 *
 * A series that is not in IDC comes back as a clean `total_series: 0` with an
 * empty `series` array, which is the unambiguous signal the host uses to fall
 * back to command-line instructions.
 */

import type {
  FallbackRecipe,
  FallbackSnippet,
  LicenseInfo,
  ResolveContext,
  ResolvedSeries,
  ResolveResult,
  SeriesResolver,
  SeriesSelector,
} from '../../types'
import { licenseForBucket } from './licenses'
import { type ManifestRow, parseManifestResponse } from './wire'

export const IDC_API_BASE = 'https://api.imaging.datacommons.cancer.gov/v3'

/** Every IDC bucket lives in this region. */
export const IDC_AWS_REGION = 'us-east-1'

export interface IdcResolverOptions {
  baseUrl?: string
  region?: string
  /** Overrides how a bucket name becomes an origin, for non-AWS deployments. */
  s3UrlTemplate?: (bucket: string, region: string) => string
  pageSize?: number
  /** Chunk size for the `SeriesInstanceUID` filter, to bound request size. */
  maxUidsPerRequest?: number
  includeLicenses?: boolean
  includeCitations?: boolean
  docsUrl?: string
}

const DEFAULT_DOCS_URL = 'https://learn.canceridc.dev/data/downloading-data'

const defaultS3Url = (bucket: string, region: string): string =>
  `https://${bucket}.s3.${region}.amazonaws.com`

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

const postJson = async (
  url: string,
  body: unknown,
  ctx: ResolveContext,
): Promise<unknown> => {
  const response = await ctx.http(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctx.signal,
  })
  if (!response.ok) {
    throw new Error(`IDC API returned HTTP ${response.status} for ${url}`)
  }
  return await response.json()
}

const toResolvedSeries = (
  row: ManifestRow,
  options: Required<Pick<IdcResolverOptions, 'region'>> & {
    s3UrlTemplate: (bucket: string, region: string) => string
  },
): ResolvedSeries | undefined => {
  if (row.crdcSeriesUuid === undefined || row.buckets.length === 0) {
    return undefined
  }
  const license: LicenseInfo | undefined = licenseForBucket(row.buckets[0])
  return {
    seriesInstanceUID: row.seriesInstanceUID,
    studyInstanceUID: row.studyInstanceUID,
    // One source per bucket. A series listed against more than one bucket is
    // representable rather than being collapsed into a malformed hostname.
    sources: row.buckets.map((bucket) => ({
      kind: 'object-list' as const,
      baseUrl: options.s3UrlTemplate(bucket, options.region),
      prefix: row.crdcSeriesUuid as string,
      listing: 's3v2' as const,
    })),
    instanceCount: row.instanceCount,
    estimatedBytes:
      row.sizeMb === undefined
        ? undefined
        : Math.round(row.sizeMb * 1024 * 1024),
    facets: {
      collection: row.collectionId,
      patientId: row.patientId,
      studyInstanceUID: row.studyInstanceUID,
      seriesInstanceUID: row.seriesInstanceUID,
      modality: row.modality,
    },
    license,
  }
}

const buildFallback = (
  selector: SeriesSelector,
  resolved: ResolveResult | null,
  docsUrl: string,
): FallbackRecipe => {
  const snippets: FallbackSnippet[] = [
    {
      language: 'shell',
      label: 'Install the idc-index package',
      code: 'pip install --upgrade idc-index',
    },
  ]

  if (selector.studyInstanceUID !== undefined) {
    snippets.push({
      language: 'shell',
      label: 'Download the whole study',
      code: `idc download ${selector.studyInstanceUID}`,
    })
  }

  if (selector.seriesInstanceUIDs.length > 0) {
    snippets.push({
      language: 'shell',
      label:
        selector.seriesInstanceUIDs.length === 1
          ? 'Download this series'
          : 'Download these series',
      code: selector.seriesInstanceUIDs
        .map((uid) => `idc download ${uid}`)
        .join('\n'),
    })
  }

  // When resolution succeeded, the exact bucket paths are known — so the
  // fallback can offer a command that needs no lookup, rather than only a
  // documentation link. This is why `prepare()` is worth running even in a
  // browser that cannot download.
  if (resolved !== null && resolved.series.length > 0) {
    const urls = resolved.series
      .map((series) => {
        const source = series.sources[0]
        if (source === undefined) {
          return undefined
        }
        const bucket = source.baseUrl.replace('https://', '').split('.s3.')[0]
        return `s3://${bucket}/${source.prefix}/*`
      })
      .filter((value): value is string => value !== undefined)

    if (urls.length > 0) {
      snippets.push({
        language: 'shell',
        label: 'Or copy directly from AWS S3 with s5cmd',
        code: urls
          .map((url) => `s5cmd --no-sign-request cp '${url}' .`)
          .join('\n'),
      })
    }
  }

  return {
    title: 'Download with the command line',
    docsUrl,
    snippets,
  }
}

export const createIdcSeriesResolver = (
  options: IdcResolverOptions = {},
): SeriesResolver => {
  const baseUrl = options.baseUrl ?? IDC_API_BASE
  const region = options.region ?? IDC_AWS_REGION
  const s3UrlTemplate = options.s3UrlTemplate ?? defaultS3Url
  const pageSize = options.pageSize ?? 500
  const maxUids = options.maxUidsPerRequest ?? 200
  const docsUrl = options.docsUrl ?? DEFAULT_DOCS_URL

  const fetchManifest = async (
    filters: Record<string, string[]>,
    ctx: ResolveContext,
  ): Promise<ManifestRow[]> => {
    const rows: ManifestRow[] = []
    let page = 0
    for (;;) {
      const payload = await postJson(
        `${baseUrl}/cohort/manifest`,
        { filters: { terms: filters }, page, page_size: pageSize },
        ctx,
      )
      const parsed = parseManifestResponse(payload)
      for (const row of parsed.rows) {
        rows.push(row)
      }
      const seen = (page + 1) * pageSize
      if (parsed.totalSeries <= seen || parsed.rows.length === 0) {
        break
      }
      page += 1
    }
    return rows
  }

  return {
    id: 'idc-v3',

    resolve: async (selector, ctx): Promise<ResolveResult> => {
      const rows: ManifestRow[] = []

      // A study filter is one request regardless of how many series it holds,
      // so prefer it when the caller has one.
      if (
        selector.studyInstanceUID !== undefined &&
        selector.seriesInstanceUIDs.length === 0
      ) {
        for (const row of await fetchManifest(
          { StudyInstanceUID: [selector.studyInstanceUID] },
          ctx,
        )) {
          rows.push(row)
        }
      } else {
        for (const group of chunk(selector.seriesInstanceUIDs, maxUids)) {
          for (const row of await fetchManifest(
            { SeriesInstanceUID: group },
            ctx,
          )) {
            rows.push(row)
          }
        }
      }

      const series: ResolvedSeries[] = []
      const placed = new Set<string>()
      for (const row of rows) {
        const entry = toResolvedSeries(row, { region, s3UrlTemplate })
        if (entry !== undefined) {
          series.push(entry)
          placed.add(entry.seriesInstanceUID)
        }
      }

      // Anything asked for and not returned. Never silently dropped: a slide
      // annotated in the viewer routinely has series the archive has never seen.
      const unresolved = selector.seriesInstanceUIDs.filter(
        (uid) => !placed.has(uid),
      )

      return { series, unresolved }
    },

    describeFallback: (selector, resolved) =>
      buildFallback(selector, resolved, docsUrl),
  }
}
