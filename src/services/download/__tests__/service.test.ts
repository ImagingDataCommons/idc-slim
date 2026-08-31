import { createDownloadService } from '../service'
import { createMemorySink, type MemorySink } from '../sinks/memorySink'
import type {
  DownloadProgress,
  HttpResponseLike,
  ResolveResult,
  ResolvedSeries,
  SeriesResolver,
} from '../types'

const BASE = 'https://idc-open-data.s3.us-east-1.amazonaws.com'
const PREFIX_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const PREFIX_B = 'bbbbbbbb-0000-0000-0000-000000000002'

const series = (
  uid: string,
  prefix: string,
  overrides: Partial<ResolvedSeries> = {},
): ResolvedSeries => ({
  seriesInstanceUID: uid,
  studyInstanceUID: '2.25.9999',
  sources: [{ kind: 'object-list', baseUrl: BASE, prefix, listing: 's3v2' }],
  facets: {
    collection: 'ccdi_mci',
    patientId: 'PBCFZC',
    studyInstanceUID: '2.25.9999',
    seriesInstanceUID: uid,
    modality: 'SM',
  },
  license: {
    id: 'CC-BY-4.0',
    name: 'CC BY 4.0',
    commercialUseAllowed: true,
  },
  ...overrides,
})

const listing = (prefix: string, entries: Array<[string, number]>): string =>
  `<ListBucketResult><IsTruncated>false</IsTruncated>${entries
    .map(
      ([name, size]) =>
        `<Contents><Key>${prefix}/${name}</Key><Size>${size}</Size></Contents>`,
    )
    .join('')}</ListBucketResult>`

const textResponse = (body: string): HttpResponseLike => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => body,
  json: async () => ({}),
  body: null,
})

const bytesResponse = (size: number, fill = 7): HttpResponseLike => {
  let served = false
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '',
    json: async () => ({}),
    body: {
      getReader: () => ({
        read: async () => {
          if (served) {
            return { done: true }
          }
          served = true
          return { done: false, value: new Uint8Array(size).fill(fill) }
        },
      }),
    },
  }
}

const resolverFor = (
  resolved: ResolveResult,
  fallbackTitle = 'Command line',
): SeriesResolver => ({
  id: 'fake',
  resolve: async () => resolved,
  describeFallback: () => ({
    title: fallbackTitle,
    snippets: [{ language: 'python', label: 'Install', code: 'pip install x' }],
  }),
})

interface Env {
  sink: MemorySink
  service: ReturnType<typeof createDownloadService>
  requests: string[]
}

const env = (
  resolved: ResolveResult,
  objectResponses: Record<string, () => HttpResponseLike> = {},
  overrides: { concurrency?: number } = {},
): Env => {
  const sink = createMemorySink()
  const requests: string[] = []
  const service = createDownloadService({
    resolver: resolverFor(resolved),
    concurrency: overrides.concurrency,
    http: async (url) => {
      requests.push(url)
      if (url.indexOf('list-type=2') !== -1) {
        const prefix = url.indexOf(PREFIX_A) !== -1 ? PREFIX_A : PREFIX_B
        return textResponse(
          listing(prefix, [
            ['one.dcm', 10],
            ['two.dcm', 20],
          ]),
        )
      }
      const custom = objectResponses[url]
      if (custom !== undefined) {
        return custom()
      }
      return bytesResponse(url.endsWith('one.dcm') ? 10 : 20)
    },
    now: () => 0,
    random: () => 0,
    sleep: async () => undefined,
    randomId: () => 'plan-1',
    progressIntervalMs: 0,
  })
  return { sink, service, requests }
}

describe('prepare', () => {
  it('produces exact totals from the listing', async () => {
    const { service } = env({
      series: [series('1.1', PREFIX_A)],
      unresolved: [],
    })
    const { plan } = await service.prepare({ seriesInstanceUIDs: ['1.1'] })

    expect(plan.totals).toEqual({
      series: 1,
      files: 2,
      bytes: 30,
      bytesAreExact: true,
    })
    expect(plan.blockers).toEqual([])
    expect(plan.licenses).toEqual([
      { id: 'CC-BY-4.0', name: 'CC BY 4.0', commercialUseAllowed: true },
    ])
  })

  it('lays out files under the nested template', async () => {
    const { service } = await Promise.resolve(
      env({ series: [series('1.1', PREFIX_A)], unresolved: [] }),
    )
    const { plan } = await service.prepare({ seriesInstanceUIDs: ['1.1'] })
    expect(plan.files[0].segments).toEqual([
      'ccdi_mci',
      'PBCFZC',
      '2.25.9999',
      'SM_1.1',
      'one.dcm',
    ])
  })

  it('warns when only some requested series resolved', async () => {
    // Routine: a slide annotated in the viewer has series that exist only on
    // the local DICOMweb server and never in the archive.
    const { service } = env({
      series: [series('1.1', PREFIX_A)],
      unresolved: ['9.9'],
    })
    const { plan } = await service.prepare({
      seriesInstanceUIDs: ['1.1', '9.9'],
    })

    const warning = plan.warnings.find((w) => w.code === 'partial-resolution')
    expect(warning?.message).toContain('1 of 2 series')
    expect(plan.blockers).toEqual([])
  })

  it('blocks when nothing resolved', async () => {
    const { service } = env({ series: [], unresolved: ['9.9'] })
    const { plan } = await service.prepare({ seriesInstanceUIDs: ['9.9'] })
    expect(plan.blockers.map((b) => b.code)).toEqual(['nothing-resolved'])
  })

  it('flags non-commercial licensing', async () => {
    const { service } = env({
      series: [
        series('1.1', PREFIX_A, {
          license: {
            id: 'CC-BY-NC-4.0',
            name: 'CC BY-NC 4.0',
            commercialUseAllowed: false,
          },
        }),
      ],
      unresolved: [],
    })
    const { plan } = await service.prepare({ seriesInstanceUIDs: ['1.1'] })
    const warning = plan.warnings.find(
      (w) => w.code === 'non-commercial-license',
    )
    expect(warning?.message).toContain('CC BY-NC 4.0')
  })

  it('merges multiple series into one plan', async () => {
    const { service } = env({
      series: [series('1.1', PREFIX_A), series('2.2', PREFIX_B)],
      unresolved: [],
    })
    const { plan } = await service.prepare({
      seriesInstanceUIDs: ['1.1', '2.2'],
    })
    expect(plan.totals.series).toBe(2)
    expect(plan.totals.files).toBe(4)
    expect(plan.totals.bytes).toBe(60)
  })
})

describe('start', () => {
  it('writes every file and reports completion', async () => {
    const { service, sink } = env({
      series: [series('1.1', PREFIX_A)],
      unresolved: [],
    })
    const { plan } = await service.prepare({ seriesInstanceUIDs: ['1.1'] })
    const job = service.start(plan, sink)
    const report = await job.done

    expect(report.outcome).toBe('completed')
    expect(report.filesWritten).toBe(2)
    expect(report.filesFailed).toBe(0)
    expect(report.bytesWritten).toBe(30)
    expect(
      sink.contents(['ccdi_mci', 'PBCFZC', '2.25.9999', 'SM_1.1', 'one.dcm']),
    ).toHaveLength(10)
  })

  it('emits progress reaching the total', async () => {
    const { service, sink } = env({
      series: [series('1.1', PREFIX_A)],
      unresolved: [],
    })
    const { plan } = await service.prepare({ seriesInstanceUIDs: ['1.1'] })
    const job = service.start(plan, sink)

    const snapshots: DownloadProgress[] = []
    job.subscribe((p) => snapshots.push(p))
    await job.done

    const last = snapshots[snapshots.length - 1]
    expect(last.phase).toBe('completed')
    expect(last.bytesWritten).toBe(30)
    expect(last.filesCompleted).toBe(2)
  })

  it('refuses a second concurrent job', async () => {
    const { service, sink } = env({
      series: [series('1.1', PREFIX_A)],
      unresolved: [],
    })
    const { plan } = await service.prepare({ seriesInstanceUIDs: ['1.1'] })
    const first = service.start(plan, sink)

    expect(() => service.start(plan, sink)).toThrow(
      /already running/,
    )
    await first.done
  })

  it('allows a new job once the previous one finished', async () => {
    const { service, sink } = env({
      series: [series('1.1', PREFIX_A)],
      unresolved: [],
    })
    const { plan } = await service.prepare({ seriesInstanceUIDs: ['1.1'] })
    await service.start(plan, sink).done
    expect(service.activeJob).toBeNull()
    await expect(service.start(plan, sink).done).resolves.toMatchObject({
      // Second run finds both files already at the right size.
      filesSkipped: 2,
    })
  })

  it('refuses to start a blocked plan', async () => {
    const { service, sink } = env({ series: [], unresolved: ['9.9'] })
    const { plan } = await service.prepare({ seriesInstanceUIDs: ['9.9'] })
    expect(() => service.start(plan, sink)).toThrow(/available for direct/)
  })

  it('records a per-file failure and still finishes the rest', async () => {
    const { service, sink } = env(
      { series: [series('1.1', PREFIX_A)], unresolved: [] },
      {
        [`${BASE}/${PREFIX_A}/two.dcm`]: () => ({
          ok: false,
          status: 404,
          headers: { get: () => null },
          text: async () => '',
          json: async () => ({}),
          body: null,
        }),
      },
    )
    const { plan } = await service.prepare({ seriesInstanceUIDs: ['1.1'] })
    const report = await service.start(plan, sink).done

    expect(report.outcome).toBe('completed-with-errors')
    expect(report.filesWritten).toBe(1)
    expect(report.failures).toHaveLength(1)
    // The failure must name the file, not just say something went wrong.
    expect(report.failures[0].status).toBe(404)
    expect(report.failures[0].url).toContain('two.dcm')
  })

  it('stops the whole job on a fatal sink failure', async () => {
    // A full disk must not produce one failure per remaining file. Run one lane
    // at a time so the guard is observable: with more lanes than files, every
    // task has already started before the first failure lands, and there is
    // nothing left for the guard to skip.
    const sink = createMemorySink({
      failOn: (operation) => (operation === 'write' ? 'quota' : undefined),
    })
    const base = env(
      {
        series: [series('1.1', PREFIX_A), series('2.2', PREFIX_B)],
        unresolved: [],
      },
      {},
      { concurrency: 1 },
    )
    const { plan } = await base.service.prepare({
      seriesInstanceUIDs: ['1.1', '2.2'],
    })
    expect(plan.totals.files).toBe(4)

    const report = await base.service.start(plan, sink).done

    expect(report.outcome).toBe('failed')
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0].code).toBe('quota')
  })

  it('reports cancellation and leaves no partial files', async () => {
    const sink = createMemorySink()
    const base = env({
      series: [series('1.1', PREFIX_A), series('2.2', PREFIX_B)],
      unresolved: [],
    })
    const { plan } = await base.service.prepare({
      seriesInstanceUIDs: ['1.1', '2.2'],
    })
    const job = base.service.start(plan, sink)
    job.cancel('user clicked cancel')
    const report = await job.done

    expect(report.outcome).toBe('cancelled')
    expect(sink.openPaths).toEqual([])
    // Whatever did not complete must not be on disk under its real name.
    expect(report.filesWritten + report.filesSkipped).toBeLessThanOrEqual(
      plan.totals.files,
    )
  })

  it('never rejects, so a host cannot leave a failure unhandled', async () => {
    const { service, sink } = env({
      series: [series('1.1', PREFIX_A)],
      unresolved: [],
    })
    const { plan } = await service.prepare({ seriesInstanceUIDs: ['1.1'] })
    await expect(service.start(plan, sink).done).resolves.toBeDefined()
  })
})

describe('relayout', () => {
  it('re-projects paths onto the flat layout without changing totals', async () => {
    const { service } = env({
      series: [series('1.1', PREFIX_A)],
      unresolved: [],
    })
    const prepared = await service.prepare({ seriesInstanceUIDs: ['1.1'] })
    const flat = service.relayout(prepared, 'flat')

    expect(flat.plan.layout).toBe('flat')
    expect(flat.plan.totals).toEqual(prepared.plan.totals)
    expect(flat.plan.files[0].segments).toEqual(['ccdi_mci', 'one.dcm'])
    expect(flat.plan.longestRelativePathLength).toBeLessThan(
      prepared.plan.longestRelativePathLength,
    )
  })

  it('writes a manifest mapping opaque filenames back to identifiers', async () => {
    const { service, sink } = env({
      series: [series('1.1', PREFIX_A)],
      unresolved: [],
    })
    const prepared = await service.prepare({ seriesInstanceUIDs: ['1.1'] })
    const flat = service.relayout(prepared, 'flat')
    const report = await service.start(flat.plan, sink).done

    expect(report.manifestPath).toBeDefined()
    const manifest = sink.contents(report.manifestPath?.split('/') ?? [])
    const text = String.fromCharCode(...Array.from(manifest ?? []))
    expect(text).toContain('File Name,Collection ID')
    expect(text).toContain('one.dcm,ccdi_mci,PBCFZC,2.25.9999,1.1,SM')
    expect(text).toContain('two.dcm,ccdi_mci,PBCFZC,2.25.9999,1.1,SM')
  })
})

describe('describeFallback', () => {
  it('delegates to the resolver', async () => {
    const { service } = env({ series: [], unresolved: ['9.9'] })
    expect(
      service.describeFallback({ seriesInstanceUIDs: ['9.9'] })?.title,
    ).toBe('Command line')
  })
})
