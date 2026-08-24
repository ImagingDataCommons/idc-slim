import { DEFAULT_RETRY_POLICY } from '../core/retry'
import { TransferError, transferFile } from '../core/transfer'
import { createMemorySink, type MemorySink } from '../sinks/memorySink'
import { SinkError } from '../sinks/types'
import type {
  ByteReaderLike,
  HttpInit,
  HttpResponseLike,
  PlannedFile,
} from '../types'

const URL = 'https://bucket.s3.us-east-1.amazonaws.com/uuid/file.dcm'

const file = (sizeBytes: number | null): PlannedFile => ({
  url: URL,
  sizeBytes,
  segments: ['coll', 'pat', 'study', 'SM_series', 'file.dcm'],
  seriesInstanceUID: '1.2.3',
})

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

/** A reader over a fixed list of chunks, optionally failing at one index. */
const reader = (
  chunks: Uint8Array[],
  failAt?: number,
): ByteReaderLike => {
  let i = 0
  let cancelled = false
  return {
    read: async () => {
      if (failAt !== undefined && i === failAt) {
        throw new Error('stream broke')
      }
      if (cancelled || i >= chunks.length) {
        return { done: true }
      }
      const value = chunks[i]
      i += 1
      return { done: false, value }
    },
    cancel: async () => {
      cancelled = true
    },
  }
}

const respond = (
  status: number,
  body: ByteReaderLike | null,
  headers: Record<string, string> = {},
): HttpResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => '',
  json: async () => ({}),
  body: body === null ? null : { getReader: () => body },
})

interface Harness {
  sink: MemorySink
  calls: HttpInit[]
  run: (
    f: PlannedFile,
    signal?: AbortSignal,
  ) => ReturnType<typeof transferFile>
}

const harness = (
  responses: Array<() => HttpResponseLike | Promise<HttpResponseLike>>,
  sink: MemorySink = createMemorySink(),
): Harness => {
  const calls: HttpInit[] = []
  let index = 0
  return {
    sink,
    calls,
    run: (f, signal) =>
      transferFile({
        file: f,
        sink,
        http: async (_url, init) => {
          calls.push(init ?? {})
          const next = responses[Math.min(index, responses.length - 1)]
          index += 1
          return next()
        },
        signal: signal ?? new AbortController().signal,
        retry: DEFAULT_RETRY_POLICY,
        random: () => 0,
        now: () => 0,
        sleep: async () => undefined,
      }),
  }
}

describe('transferFile — happy path', () => {
  it('writes the object and reports bytes written', async () => {
    const h = harness([() => respond(200, reader([bytes(1, 2), bytes(3)]))])
    const result = await h.run(file(3))

    expect(result).toEqual({ outcome: 'written', bytesWritten: 3, attempts: 1 })
    expect(h.sink.contents(file(3).segments)).toEqual(bytes(1, 2, 3))
  })

  it('reports each chunk to the progress hook', async () => {
    const seen: number[] = []
    await transferFile({
      file: file(3),
      sink: createMemorySink(),
      http: async () => respond(200, reader([bytes(1, 2), bytes(3)])),
      signal: new AbortController().signal,
      retry: DEFAULT_RETRY_POLICY,
      random: () => 0,
      now: () => 0,
      sleep: async () => undefined,
      hooks: { onBytes: (n) => seen.push(n) },
    })
    expect(seen).toEqual([2, 1])
  })

  it('accepts an unknown expected size and skips verification', async () => {
    const h = harness([() => respond(200, reader([bytes(1, 2, 3, 4)]))])
    const result = await h.run(file(null))
    expect(result.outcome).toBe('written')
    expect(result.bytesWritten).toBe(4)
  })

  it('sends no Range header on a first attempt', async () => {
    const h = harness([() => respond(200, reader([bytes(1)]))])
    await h.run(file(1))
    expect(h.calls[0].headers).toEqual({})
  })
})

describe('transferFile — skip existing', () => {
  it('skips a file already present at exactly the expected size', async () => {
    const sink = createMemorySink()
    const writer = await sink.open(file(3).segments)
    await writer.write(bytes(1, 2, 3))
    await writer.close()

    const h = harness([() => respond(200, reader([bytes(9)]))], sink)
    const result = await h.run(file(3))

    // This is what makes recovery after an interruption near-free.
    expect(result).toEqual({ outcome: 'skipped', bytesWritten: 0, attempts: 0 })
    expect(h.calls).toHaveLength(0)
    expect(sink.contents(file(3).segments)).toEqual(bytes(1, 2, 3))
  })

  it('re-downloads a file present at the wrong size', async () => {
    const sink = createMemorySink()
    const writer = await sink.open(file(3).segments)
    await writer.write(bytes(1))
    await writer.close()

    const h = harness([() => respond(200, reader([bytes(7, 8, 9)]))], sink)
    const result = await h.run(file(3))

    expect(result.outcome).toBe('written')
    expect(sink.contents(file(3).segments)).toEqual(bytes(7, 8, 9))
  })

  it('does not skip when the expected size is unknown', async () => {
    const sink = createMemorySink()
    const writer = await sink.open(file(null).segments)
    await writer.write(bytes(1, 2, 3))
    await writer.close()

    const h = harness([() => respond(200, reader([bytes(4)]))], sink)
    expect((await h.run(file(null))).outcome).toBe('written')
  })
})

describe('transferFile — retry and resume', () => {
  it('retries a 503 and succeeds', async () => {
    const h = harness([
      () => respond(503, null),
      () => respond(200, reader([bytes(1, 2, 3)])),
    ])
    const result = await h.run(file(3))
    expect(result).toEqual({ outcome: 'written', bytesWritten: 3, attempts: 2 })
  })

  it('resumes from the byte offset already written', async () => {
    // The first attempt writes 2 bytes then the stream breaks; the second must
    // ask for the remainder and produce a byte-identical file.
    const h = harness([
      () => respond(200, reader([bytes(1, 2)], 1)),
      () => respond(206, reader([bytes(3, 4)])),
    ])
    const result = await h.run(file(4))

    expect(result.outcome).toBe('written')
    expect(h.calls[1].headers).toEqual({ Range: 'bytes=2-' })
    expect(h.sink.contents(file(4).segments)).toEqual(bytes(1, 2, 3, 4))
  })

  it('discards prior bytes when a ranged retry is answered with 200', async () => {
    // A server that ignores the Range header sends the whole object; without
    // truncating, the file would end up with a duplicated prefix.
    const rewinds: number[] = []
    const sink = createMemorySink()
    let call = 0

    const result = await transferFile({
      file: file(3),
      sink,
      http: async () => {
        call += 1
        return call === 1
          ? respond(200, reader([bytes(1, 2)], 1))
          : respond(200, reader([bytes(7, 8, 9)]))
      },
      signal: new AbortController().signal,
      retry: DEFAULT_RETRY_POLICY,
      random: () => 0,
      now: () => 0,
      sleep: async () => undefined,
      hooks: { onRewind: (n) => rewinds.push(n) },
    })

    expect(result.outcome).toBe('written')
    expect(rewinds).toEqual([2])
    expect(sink.contents(file(3).segments)).toEqual(bytes(7, 8, 9))
  })

  it('gives up after maxAttempts and leaves no file behind', async () => {
    const h = harness([() => respond(503, null)])
    await expect(h.run(file(3))).rejects.toMatchObject({
      code: 'http',
      status: 503,
      attempts: DEFAULT_RETRY_POLICY.maxAttempts,
    })
    expect(h.sink.contents(file(3).segments)).toBeUndefined()
  })

  it('does not retry a 404', async () => {
    const h = harness([() => respond(404, null)])
    await expect(h.run(file(3))).rejects.toMatchObject({
      code: 'http',
      status: 404,
      attempts: 1,
    })
    expect(h.calls).toHaveLength(1)
  })

  it('does not retry a 403, so a bad prefix fails fast', async () => {
    const h = harness([() => respond(403, null)])
    await expect(h.run(file(3))).rejects.toMatchObject({ attempts: 1 })
  })

  it('honours Retry-After on a 429', async () => {
    const slept: number[] = []
    const sink = createMemorySink()
    let call = 0

    await transferFile({
      file: file(1),
      sink,
      http: async () => {
        call += 1
        return call === 1
          ? respond(429, null, { 'retry-after': '3' })
          : respond(200, reader([bytes(1)]))
      },
      signal: new AbortController().signal,
      retry: DEFAULT_RETRY_POLICY,
      random: () => 1,
      now: () => 0,
      sleep: async (ms) => {
        slept.push(ms)
      },
    })

    expect(slept).toEqual([3000])
  })
})

describe('transferFile — size verification', () => {
  it('rejects a short body rather than committing it', async () => {
    // The defence against silent truncation, whatever the cause.
    const h = harness([() => respond(200, reader([bytes(1, 2)]))])
    await expect(h.run(file(5))).rejects.toMatchObject({
      code: 'size-mismatch',
    })
    expect(h.sink.contents(file(5).segments)).toBeUndefined()
  })

  it('rejects an over-long body', async () => {
    const h = harness([() => respond(200, reader([bytes(1, 2, 3, 4)]))])
    await expect(h.run(file(2))).rejects.toMatchObject({
      code: 'size-mismatch',
    })
  })

  it('retries a short body and can complete via resume', async () => {
    const h = harness([
      () => respond(200, reader([bytes(1, 2)])),
      () => respond(206, reader([bytes(3)])),
    ])
    const result = await h.run(file(3))
    expect(result.outcome).toBe('written')
    expect(h.sink.contents(file(3).segments)).toEqual(bytes(1, 2, 3))
  })
})

describe('transferFile — cancellation', () => {
  it('leaves no file behind when a new download is cancelled mid-stream', async () => {
    // The headline guarantee: a cancelled transfer must never commit a
    // truncated file under the real filename.
    const controller = new AbortController()
    const sink = createMemorySink()

    const chunks = [bytes(1, 2), bytes(3, 4), bytes(5, 6)]
    let served = 0

    await expect(
      transferFile({
        file: file(6),
        sink,
        http: async () =>
          respond(200, {
            read: async () => {
              if (served >= chunks.length) {
                return { done: true }
              }
              const value = chunks[served]
              served += 1
              if (served === 2) {
                controller.abort()
              }
              return { done: false, value }
            },
          }),
        signal: controller.signal,
        retry: DEFAULT_RETRY_POLICY,
        random: () => 0,
        now: () => 0,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'aborted' })

    expect(sink.contents(file(6).segments)).toBeUndefined()
    expect(sink.openPaths).toEqual([])
  })

  it('leaves a pre-existing file byte-for-byte unchanged when cancelled', async () => {
    const controller = new AbortController()
    const sink = createMemorySink()
    const writer = await sink.open(file(6).segments)
    await writer.write(bytes(9, 9, 9))
    await writer.close()

    let served = 0
    await expect(
      transferFile({
        file: file(6),
        sink,
        http: async () =>
          respond(200, {
            read: async () => {
              served += 1
              if (served === 2) {
                controller.abort()
                return { done: false, value: bytes(2) }
              }
              return { done: false, value: bytes(1) }
            },
          }),
        signal: controller.signal,
        retry: DEFAULT_RETRY_POLICY,
        random: () => 0,
        now: () => 0,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'aborted' })

    expect(sink.contents(file(6).segments)).toEqual(bytes(9, 9, 9))
  })

  it('refuses to start when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = harness([() => respond(200, reader([bytes(1)]))])
    await expect(h.run(file(1), controller.signal)).rejects.toMatchObject({
      code: 'aborted',
      attempts: 0,
    })
    expect(h.calls).toHaveLength(0)
  })
})

describe('transferFile — sink failures', () => {
  it('marks a quota failure fatal for the whole job', async () => {
    // Retrying 300 more files after the disk filled up produces 300 more
    // errors, so this must stop the job rather than the file.
    const sink = createMemorySink({
      failOn: (operation, _path, written) =>
        operation === 'write' && written >= 2 ? 'quota' : undefined,
    })
    const h = harness([() => respond(200, reader([bytes(1, 2), bytes(3)]))], sink)

    const error = await h.run(file(3)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TransferError)
    expect(error).toMatchObject({ code: 'quota', fatal: true })
  })

  it('marks a revoked permission fatal', async () => {
    const sink = createMemorySink({
      failOn: (operation) => (operation === 'open' ? 'permission' : undefined),
    })
    const h = harness([() => respond(200, reader([bytes(1)]))], sink)
    await expect(h.run(file(1))).rejects.toMatchObject({
      code: 'permission',
      fatal: true,
    })
  })

  it('does not retry a sink failure as if it were a transport failure', async () => {
    const sink = createMemorySink({
      failOn: (operation) => (operation === 'write' ? 'unknown' : undefined),
    })
    const h = harness([() => respond(200, reader([bytes(1)]))], sink)
    await expect(h.run(file(1))).rejects.toMatchObject({ code: 'sink' })
    expect(h.calls).toHaveLength(1)
  })

  it('surfaces a stat failure without opening a writer', async () => {
    const sink = createMemorySink({
      failOn: (operation) => (operation === 'stat' ? 'unknown' : undefined),
    })
    const h = harness([() => respond(200, reader([bytes(1)]))], sink)
    await expect(h.run(file(1))).rejects.toBeInstanceOf(TransferError)
    expect(sink.openPaths).toEqual([])
  })

  it('treats a wrapped SinkError from close as a sink failure', async () => {
    const sink = createMemorySink({
      failOn: (operation) => (operation === 'close' ? 'quota' : undefined),
    })
    const h = harness([() => respond(200, reader([bytes(1)]))], sink)
    await expect(h.run(file(1))).rejects.toMatchObject({
      code: 'quota',
      fatal: true,
    })
    expect(sink.contents(file(1).segments)).toBeUndefined()
  })
})

describe('transferFile — malformed responses', () => {
  it('retries a response with no body', async () => {
    const h = harness([
      () => respond(200, null),
      () => respond(200, reader([bytes(1)])),
    ])
    expect((await h.run(file(1))).attempts).toBe(2)
  })

  it('ignores zero-length chunks', async () => {
    const h = harness([
      () => respond(200, reader([bytes(), bytes(1, 2), bytes()])),
    ])
    const result = await h.run(file(2))
    expect(result.bytesWritten).toBe(2)
    expect(h.sink.contents(file(2).segments)).toEqual(bytes(1, 2))
  })

  it('wraps a SinkError raised outside the sink adapter', async () => {
    await expect(
      transferFile({
        file: file(1),
        sink: {
          label: 'x',
          stat: async () => null,
          open: async () => {
            throw new SinkError('path-not-found', 'too deep')
          },
          remove: async () => undefined,
          mkdirp: async () => undefined,
          removeDirectory: async () => undefined,
        },
        http: async () => respond(200, reader([bytes(1)])),
        signal: new AbortController().signal,
        retry: DEFAULT_RETRY_POLICY,
        random: () => 0,
        now: () => 0,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'sink', fatal: false })
  })
})
