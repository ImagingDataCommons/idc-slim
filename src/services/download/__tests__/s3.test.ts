import { DEFAULT_RETRY_POLICY } from '../core/retry'
import { listObjects, S3ListError } from '../sources/s3List'
import { decodeXmlEntities, parseListObjectsV2 } from '../sources/s3Xml'
import type { HttpResponseLike, ObjectListSource } from '../types'

const PREFIX = '129578c4-7a00-4b4d-804f-f58228123df8'

const source: ObjectListSource = {
  kind: 'object-list',
  baseUrl: 'https://idc-open-data.s3.us-east-1.amazonaws.com',
  prefix: PREFIX,
  listing: 's3v2',
}

/** Shaped after a real ListObjectsV2 response for an IDC slide microscopy series. */
const page = (
  entries: Array<[string, number]>,
  options: { truncated?: boolean; token?: string } = {},
): string => `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>idc-open-data</Name><Prefix>${PREFIX}</Prefix>
<KeyCount>${entries.length}</KeyCount><MaxKeys>1000</MaxKeys>
<IsTruncated>${options.truncated === true ? 'true' : 'false'}</IsTruncated>
${options.token !== undefined ? `<NextContinuationToken>${options.token}</NextContinuationToken>` : ''}
${entries
  .map(
    ([key, size]) =>
      `<Contents><Key>${key}</Key><LastModified>2024-03-29T16:12:02.000Z</LastModified>` +
      `<ETag>&quot;abc&quot;</ETag><Size>${size}</Size>` +
      '<StorageClass>STANDARD</StorageClass></Contents>',
  )
  .join('\n')}
</ListBucketResult>`

const errorDoc = (code: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>${code}</Code><Message>Please reduce your request rate.</Message>
<RequestId>ABC</RequestId></Error>`

const respondText = (status: number, body: string): HttpResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => body,
  json: async () => ({}),
  body: null,
})

const listWith = async (
  responses: string[] | (() => HttpResponseLike)[],
  signal?: AbortSignal,
): Promise<{ keys: string[]; urls: string[] }> => {
  const urls: string[] = []
  let index = 0
  const objects = await listObjects(source, {
    http: async (url) => {
      urls.push(url)
      const next = responses[Math.min(index, responses.length - 1)]
      index += 1
      return typeof next === 'string' ? respondText(200, next) : next()
    },
    signal: signal ?? new AbortController().signal,
    retry: DEFAULT_RETRY_POLICY,
    now: () => 0,
    random: () => 0,
    sleep: async () => undefined,
  })
  return { keys: objects.map((o) => o.key), urls }
}

describe('decodeXmlEntities', () => {
  it('decodes the five predefined entities', () => {
    expect(decodeXmlEntities('a&lt;b&gt;c&quot;d&apos;e&amp;f')).toBe(
      'a<b>c"d\'e&f',
    )
  })

  it('returns the input untouched when there is nothing to decode', () => {
    expect(decodeXmlEntities('plain/key.dcm')).toBe('plain/key.dcm')
  })

  it('does not doubly decode an encoded entity', () => {
    // &amp;lt; means the literal text "&lt;", not "<".
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;')
  })
})

describe('parseListObjectsV2', () => {
  it('reads keys and sizes', () => {
    const result = parseListObjectsV2(
      page([
        [`${PREFIX}/a.dcm`, 281641958],
        [`${PREFIX}/b.dcm`, 26271542],
      ]),
    )
    expect(result).toEqual({
      kind: 'page',
      objects: [
        { key: `${PREFIX}/a.dcm`, size: 281641958 },
        { key: `${PREFIX}/b.dcm`, size: 26271542 },
      ],
      isTruncated: false,
      nextContinuationToken: undefined,
    })
  })

  it('reports truncation with its continuation token', () => {
    const result = parseListObjectsV2(
      page([[`${PREFIX}/a.dcm`, 1]], { truncated: true, token: 'TOKEN==' }),
    )
    expect(result).toMatchObject({
      isTruncated: true,
      nextContinuationToken: 'TOKEN==',
    })
  })

  it('ignores a continuation token when not truncated', () => {
    const result = parseListObjectsV2(
      page([[`${PREFIX}/a.dcm`, 1]], { truncated: false, token: 'STALE' }),
    )
    expect(result).toMatchObject({ nextContinuationToken: undefined })
  })

  it('detects an <Error> document returned under HTTP 200', () => {
    // S3 really does this, so status alone cannot classify a listing.
    expect(parseListObjectsV2(errorDoc('SlowDown'))).toEqual({
      kind: 'error',
      code: 'SlowDown',
      message: 'Please reduce your request rate.',
    })
  })

  it('decodes entities inside keys', () => {
    const result = parseListObjectsV2(page([[`${PREFIX}/a&amp;b.dcm`, 5]]))
    expect(result).toMatchObject({
      objects: [{ key: `${PREFIX}/a&b.dcm`, size: 5 }],
    })
  })

  it('skips directory placeholder objects', () => {
    // A key ending in a separator is not a file and must not be downloaded.
    const result = parseListObjectsV2(
      page([
        [`${PREFIX}/`, 0],
        [`${PREFIX}/a.dcm`, 5],
      ]),
    )
    expect(result).toMatchObject({ objects: [{ key: `${PREFIX}/a.dcm` }] })
  })

  it('yields a null size when the size is missing or malformed', () => {
    const xml = `<ListBucketResult><IsTruncated>false</IsTruncated>
      <Contents><Key>${PREFIX}/a.dcm</Key></Contents>
      <Contents><Key>${PREFIX}/b.dcm</Key><Size>abc</Size></Contents>
      </ListBucketResult>`
    const result = parseListObjectsV2(xml)
    expect(result).toMatchObject({
      objects: [
        { key: `${PREFIX}/a.dcm`, size: null },
        { key: `${PREFIX}/b.dcm`, size: null },
      ],
    })
  })

  it('does not read a Size from a neighbouring Contents block', () => {
    const xml = `<ListBucketResult><IsTruncated>false</IsTruncated>
      <Contents><Key>a.dcm</Key></Contents>
      <Contents><Key>b.dcm</Key><Size>99</Size></Contents>
      </ListBucketResult>`
    expect(parseListObjectsV2(xml)).toMatchObject({
      objects: [
        { key: 'a.dcm', size: null },
        { key: 'b.dcm', size: 99 },
      ],
    })
  })

  it('returns an empty page for a listing with no contents', () => {
    expect(parseListObjectsV2(page([]))).toMatchObject({ objects: [] })
  })
})

describe('listObjects', () => {
  it('builds an anonymous ListObjectsV2 URL with the prefix', async () => {
    const { urls } = await listWith([page([[`${PREFIX}/a.dcm`, 1]])])
    expect(urls[0]).toBe(
      `https://idc-open-data.s3.us-east-1.amazonaws.com/?list-type=2&prefix=${PREFIX}`,
    )
  })

  it('follows continuation tokens across pages', async () => {
    const { keys, urls } = await listWith([
      page([[`${PREFIX}/a.dcm`, 1]], { truncated: true, token: 'T1+/=' }),
      page([[`${PREFIX}/b.dcm`, 2]]),
    ])
    expect(keys).toEqual([`${PREFIX}/a.dcm`, `${PREFIX}/b.dcm`])
    // The token must be percent-encoded: real tokens contain + / and =.
    expect(urls[1]).toContain('continuation-token=T1%2B%2F%3D')
  })

  it('appends caller-supplied list parameters', async () => {
    const urls: string[] = []
    await listObjects(
      { ...source, listParams: { 'max-keys': '2' } },
      {
        http: async (url) => {
          urls.push(url)
          return respondText(200, page([]))
        },
        signal: new AbortController().signal,
        retry: DEFAULT_RETRY_POLICY,
        now: () => 0,
        random: () => 0,
        sleep: async () => undefined,
      },
    )
    expect(urls[0]).toContain('max-keys=2')
  })

  it('retries a SlowDown document returned with HTTP 200', async () => {
    const { keys, urls } = await listWith([
      () => respondText(200, errorDoc('SlowDown')),
      () => respondText(200, page([[`${PREFIX}/a.dcm`, 1]])),
    ])
    expect(keys).toEqual([`${PREFIX}/a.dcm`])
    expect(urls).toHaveLength(2)
  })

  it('retries a 503', async () => {
    const { keys } = await listWith([
      () => respondText(503, ''),
      () => respondText(200, page([[`${PREFIX}/a.dcm`, 1]])),
    ])
    expect(keys).toEqual([`${PREFIX}/a.dcm`])
  })

  it('throws rather than returning a partial listing', async () => {
    // A truncated listing would silently become a truncated download.
    await expect(listWith([() => respondText(503, '')])).rejects.toBeInstanceOf(
      S3ListError,
    )
  })

  it('does not retry a permanent S3 error', async () => {
    const { urls } = await listWith([
      () => respondText(200, errorDoc('NoSuchBucket')),
    ]).catch((error: unknown) => {
      expect(error).toBeInstanceOf(S3ListError)
      expect((error as S3ListError).code).toBe('NoSuchBucket')
      return { keys: [], urls: [] as string[] }
    })
    expect(urls).toEqual([])
  })

  it('aborts mid-pagination', async () => {
    const controller = new AbortController()
    let calls = 0
    await expect(
      listObjects(source, {
        http: async () => {
          calls += 1
          if (calls === 1) {
            return respondText(
              200,
              page([[`${PREFIX}/a.dcm`, 1]], {
                truncated: true,
                token: 'NEXT',
              }),
            )
          }
          controller.abort()
          throw new Error('aborted')
        },
        signal: controller.signal,
        retry: DEFAULT_RETRY_POLICY,
        now: () => 0,
        random: () => 0,
        sleep: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(S3ListError)
  })

  it('refuses a runaway continuation loop', async () => {
    await expect(
      listObjects(source, {
        http: async () =>
          respondText(
            200,
            page([['a.dcm', 1]], { truncated: true, token: 'SAME' }),
          ),
        signal: new AbortController().signal,
        retry: DEFAULT_RETRY_POLICY,
        now: () => 0,
        random: () => 0,
        sleep: async () => undefined,
        maxPages: 3,
      }),
    ).rejects.toThrow(/exceeded 3 pages/)
  })
})
