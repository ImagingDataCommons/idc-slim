import {
  createIdcSeriesResolver,
  IDC_API_BASE,
} from '../resolvers/idc/resolver'
import { licenseForBucket, mostRestrictive } from '../resolvers/idc/licenses'
import { parseManifestResponse } from '../resolvers/idc/wire'
import type { HttpInit, HttpResponseLike, ResolveContext } from '../types'

const SERIES_UID =
  '1.3.6.1.4.1.5962.99.1.3120421285.85402270.1738287241637.4.0'
const STUDY_UID = '2.25.142706219041623035237066035829917608689'
const CRDC_UUID = '129578c4-7a00-4b4d-804f-f58228123df8'

/**
 * Captured from a live `POST /v3/cohort/manifest` filtered by SeriesInstanceUID.
 * Kept verbatim so a schema drift shows up here as a failing test.
 */
const liveResponse = {
  counts: {
    patients: 1,
    studies: 1,
    series: 1,
    instances: 4,
    size_TB: 0.0,
    filters_applied: { terms: { SeriesInstanceUID: [SERIES_UID] }, ranges: {} },
    warnings: [],
  },
  page: 0,
  page_size: 3,
  returned: 1,
  total_series: 1,
  series: [
    {
      collection_id: 'ccdi_mci',
      PatientID: 'PBCFZC',
      StudyInstanceUID: STUDY_UID,
      SeriesInstanceUID: SERIES_UID,
      Modality: 'SM',
      SeriesDescription: 'OCT HE T',
      instanceCount: 4,
      series_size_MB: 373.46427,
      aws_bucket: 'idc-open-data',
      crdc_series_uuid: CRDC_UUID,
      series_aws_url: `s3://idc-open-data/${CRDC_UUID}/*`,
    },
  ],
}

/** Captured for a UID that is not in the archive. */
const emptyResponse = {
  counts: { series: 0, warnings: [] },
  page: 0,
  page_size: 5,
  returned: 0,
  total_series: 0,
  series: [],
}

interface Call {
  url: string
  init: HttpInit
}

const jsonResponse = (payload: unknown): HttpResponseLike => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify(payload),
  json: async () => payload,
  body: null,
})

const contextFor = (
  responses: Array<unknown | (() => HttpResponseLike)>,
): { ctx: ResolveContext; calls: Call[] } => {
  const calls: Call[] = []
  let index = 0
  return {
    calls,
    ctx: {
      signal: new AbortController().signal,
      http: async (url, init) => {
        calls.push({ url, init: init ?? {} })
        const next = responses[Math.min(index, responses.length - 1)]
        index += 1
        return typeof next === 'function'
          ? (next as () => HttpResponseLike)()
          : jsonResponse(next)
      },
    },
  }
}

describe('parseManifestResponse', () => {
  it('parses the live response shape', () => {
    const parsed = parseManifestResponse(liveResponse)
    expect(parsed.totalSeries).toBe(1)
    expect(parsed.rows[0]).toEqual({
      seriesInstanceUID: SERIES_UID,
      studyInstanceUID: STUDY_UID,
      buckets: ['idc-open-data'],
      crdcSeriesUuid: CRDC_UUID,
      collectionId: 'ccdi_mci',
      patientId: 'PBCFZC',
      modality: 'SM',
      instanceCount: 4,
      sizeMb: 373.46427,
    })
  })

  it('normalizes aws_bucket delivered as an array', () => {
    // Interpolating an array into a hostname yields "a,b" and a request that
    // cannot succeed, so this case has to be handled rather than assumed away.
    const parsed = parseManifestResponse({
      total_series: 1,
      series: [
        {
          ...liveResponse.series[0],
          aws_bucket: ['idc-open-data', 'idc-open-data-two'],
        },
      ],
    })
    expect(parsed.rows[0].buckets).toEqual([
      'idc-open-data',
      'idc-open-data-two',
    ])
  })

  it('deduplicates a repeated bucket', () => {
    const parsed = parseManifestResponse({
      total_series: 1,
      series: [{ ...liveResponse.series[0], aws_bucket: ['a', 'a'] }],
    })
    expect(parsed.rows[0].buckets).toEqual(['a'])
  })

  it('drops a row missing either identifier', () => {
    const parsed = parseManifestResponse({
      total_series: 2,
      series: [
        { ...liveResponse.series[0], SeriesInstanceUID: undefined },
        { ...liveResponse.series[0], StudyInstanceUID: '' },
      ],
    })
    expect(parsed.rows).toEqual([])
  })

  it('returns nothing for a response that is not the expected shape', () => {
    // The API is a beta; a drift must disable the feature, not break the viewer.
    expect(parseManifestResponse(null).rows).toEqual([])
    expect(parseManifestResponse('nope').rows).toEqual([])
    expect(parseManifestResponse({ series: 'not an array' }).rows).toEqual([])
    expect(parseManifestResponse({}).totalSeries).toBe(0)
  })

  it('never reports fewer total series than it parsed', () => {
    // A too-low total would stop pagination early and truncate the download.
    const parsed = parseManifestResponse({
      total_series: 0,
      series: [liveResponse.series[0]],
    })
    expect(parsed.totalSeries).toBe(1)
  })

  it('surfaces server warnings', () => {
    const parsed = parseManifestResponse({
      total_series: 0,
      series: [],
      counts: { warnings: ['value "sm" not found; did you mean "SM"?'] },
    })
    expect(parsed.warnings).toHaveLength(1)
  })
})

describe('createIdcSeriesResolver', () => {
  it('posts a v3 cohort/manifest request filtered by series UID', async () => {
    const resolver = createIdcSeriesResolver()
    const { ctx, calls } = contextFor([liveResponse])
    await resolver.resolve({ seriesInstanceUIDs: [SERIES_UID] }, ctx)

    expect(calls[0].url).toBe(`${IDC_API_BASE}/cohort/manifest`)
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(calls[0].init.body ?? '{}')).toEqual({
      filters: { terms: { SeriesInstanceUID: [SERIES_UID] } },
      page: 0,
      page_size: 500,
    })
  })

  it('maps a row to an AWS object-list source', async () => {
    const resolver = createIdcSeriesResolver()
    const { ctx } = contextFor([liveResponse])
    const result = await resolver.resolve(
      { seriesInstanceUIDs: [SERIES_UID] },
      ctx,
    )

    expect(result.unresolved).toEqual([])
    expect(result.series[0].sources).toEqual([
      {
        kind: 'object-list',
        baseUrl: 'https://idc-open-data.s3.us-east-1.amazonaws.com',
        prefix: CRDC_UUID,
        listing: 's3v2',
      },
    ])
    expect(result.series[0].facets).toEqual({
      collection: 'ccdi_mci',
      patientId: 'PBCFZC',
      studyInstanceUID: STUDY_UID,
      seriesInstanceUID: SERIES_UID,
      modality: 'SM',
    })
    expect(result.series[0].estimatedBytes).toBe(
      Math.round(373.46427 * 1024 * 1024),
    )
  })

  it('emits one source per bucket for a multi-bucket series', async () => {
    const resolver = createIdcSeriesResolver()
    const { ctx } = contextFor([
      {
        total_series: 1,
        series: [
          {
            ...liveResponse.series[0],
            aws_bucket: ['idc-open-data', 'idc-open-data-two'],
          },
        ],
      },
    ])
    const result = await resolver.resolve(
      { seriesInstanceUIDs: [SERIES_UID] },
      ctx,
    )
    expect(result.series[0].sources.map((s) => s.baseUrl)).toEqual([
      'https://idc-open-data.s3.us-east-1.amazonaws.com',
      'https://idc-open-data-two.s3.us-east-1.amazonaws.com',
    ])
  })

  it('reports a series absent from the archive as unresolved', async () => {
    // The clean total_series: 0 signal the fallback tier depends on.
    const resolver = createIdcSeriesResolver()
    const { ctx } = contextFor([emptyResponse])
    const result = await resolver.resolve(
      { seriesInstanceUIDs: ['1.2.3.4.5.6.7.8.9.999999'] },
      ctx,
    )
    expect(result.series).toEqual([])
    expect(result.unresolved).toEqual(['1.2.3.4.5.6.7.8.9.999999'])
  })

  it('reports the missing subset when only some series resolve', async () => {
    const resolver = createIdcSeriesResolver()
    const { ctx } = contextFor([liveResponse])
    const result = await resolver.resolve(
      { seriesInstanceUIDs: [SERIES_UID, 'local.only.1'] },
      ctx,
    )
    expect(result.series).toHaveLength(1)
    expect(result.unresolved).toEqual(['local.only.1'])
  })

  it('uses a single study filter when given no series UIDs', async () => {
    const resolver = createIdcSeriesResolver()
    const { ctx, calls } = contextFor([liveResponse])
    await resolver.resolve(
      { studyInstanceUID: STUDY_UID, seriesInstanceUIDs: [] },
      ctx,
    )
    expect(JSON.parse(calls[0].init.body ?? '{}').filters).toEqual({
      terms: { StudyInstanceUID: [STUDY_UID] },
    })
    expect(calls).toHaveLength(1)
  })

  it('chunks a long series list across requests', async () => {
    const resolver = createIdcSeriesResolver({ maxUidsPerRequest: 2 })
    const { ctx, calls } = contextFor([emptyResponse])
    await resolver.resolve({ seriesInstanceUIDs: ['a', 'b', 'c', 'd', 'e'] }, ctx)
    expect(calls).toHaveLength(3)
    expect(JSON.parse(calls[2].init.body ?? '{}').filters.terms
      .SeriesInstanceUID).toEqual(['e'])
  })

  it('paginates until the reported total is covered', async () => {
    const resolver = createIdcSeriesResolver({ pageSize: 1 })
    const rowB = {
      ...liveResponse.series[0],
      SeriesInstanceUID: 'second',
      crdc_series_uuid: 'uuid-b',
    }
    const { ctx, calls } = contextFor([
      { total_series: 2, series: [liveResponse.series[0]] },
      { total_series: 2, series: [rowB] },
    ])
    const result = await resolver.resolve(
      { seriesInstanceUIDs: [SERIES_UID, 'second'] },
      ctx,
    )
    expect(calls).toHaveLength(2)
    expect(result.series).toHaveLength(2)
  })

  it('drops a row with no crdc_series_uuid, since it has no object prefix', async () => {
    const resolver = createIdcSeriesResolver()
    const { ctx } = contextFor([
      {
        total_series: 1,
        series: [{ ...liveResponse.series[0], crdc_series_uuid: undefined }],
      },
    ])
    const result = await resolver.resolve(
      { seriesInstanceUIDs: [SERIES_UID] },
      ctx,
    )
    expect(result.series).toEqual([])
    expect(result.unresolved).toEqual([SERIES_UID])
  })

  it('honours a custom S3 URL template', async () => {
    const resolver = createIdcSeriesResolver({
      s3UrlTemplate: (bucket) => `https://mirror.example/${bucket}`,
    })
    const { ctx } = contextFor([liveResponse])
    const result = await resolver.resolve(
      { seriesInstanceUIDs: [SERIES_UID] },
      ctx,
    )
    expect(result.series[0].sources[0].baseUrl).toBe(
      'https://mirror.example/idc-open-data',
    )
  })

  it('throws on an API error rather than reporting an empty archive', async () => {
    const resolver = createIdcSeriesResolver()
    const { ctx } = contextFor([
      () => ({
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: async () => '',
        json: async () => ({}),
        body: null,
      }),
    ])
    await expect(
      resolver.resolve({ seriesInstanceUIDs: [SERIES_UID] }, ctx),
    ).rejects.toThrow(/HTTP 500/)
  })
})

describe('describeFallback', () => {
  it('offers install plus study and series commands', () => {
    const resolver = createIdcSeriesResolver()
    const recipe = resolver.describeFallback?.(
      { studyInstanceUID: STUDY_UID, seriesInstanceUIDs: [SERIES_UID] },
      null,
    )
    const codes = recipe?.snippets.map((s) => s.code) ?? []
    expect(codes[0]).toBe('pip install --upgrade idc-index')
    expect(codes).toContain(`idc download ${STUDY_UID}`)
    expect(codes).toContain(`idc download ${SERIES_UID}`)
    expect(recipe?.docsUrl).toContain('learn.canceridc.dev')
  })

  it('adds exact s5cmd paths once resolution has succeeded', async () => {
    // prepare() needs no browser capability, so an unsupported browser can
    // still be handed a command containing the real prefix.
    const resolver = createIdcSeriesResolver()
    const { ctx } = contextFor([liveResponse])
    const resolved = await resolver.resolve(
      { seriesInstanceUIDs: [SERIES_UID] },
      ctx,
    )
    const recipe = resolver.describeFallback?.(
      { seriesInstanceUIDs: [SERIES_UID] },
      resolved,
    )
    expect(recipe?.snippets.map((s) => s.code).join('\n')).toContain(
      `s5cmd --no-sign-request cp 's3://idc-open-data/${CRDC_UUID}/*' .`,
    )
  })

  it('omits the s5cmd snippet when nothing resolved', () => {
    const resolver = createIdcSeriesResolver()
    const recipe = resolver.describeFallback?.(
      { seriesInstanceUIDs: ['x'] },
      { series: [], unresolved: ['x'] },
    )
    expect(recipe?.snippets.some((s) => s.code.indexOf('s5cmd') !== -1)).toBe(
      false,
    )
  })
})

describe('licenseForBucket', () => {
  it('treats the -cr buckets as non-commercial', () => {
    // Bucket-derived rather than fetched: getting this wrong is a licensing
    // problem, so it must not depend on a network call that can fail.
    expect(licenseForBucket('idc-open-data-cr').commercialUseAllowed).toBe(false)
    expect(licenseForBucket('idc-open-cr').commercialUseAllowed).toBe(false)
  })

  it('treats the open buckets as CC BY', () => {
    expect(licenseForBucket('idc-open-data')).toMatchObject({
      id: 'CC-BY-4.0',
      commercialUseAllowed: true,
    })
    expect(licenseForBucket('idc-open-data-two').commercialUseAllowed).toBe(true)
  })
})

describe('mostRestrictive', () => {
  it('prefers a non-commercial license in a mixed set', () => {
    expect(
      mostRestrictive([
        licenseForBucket('idc-open-data'),
        licenseForBucket('idc-open-data-cr'),
      ])?.commercialUseAllowed,
    ).toBe(false)
  })

  it('returns undefined for an empty set', () => {
    expect(mostRestrictive([])).toBeUndefined()
  })
})
