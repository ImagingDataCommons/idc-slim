import { createMemorySink } from '../sinks/memorySink'
import { isFatalSinkError, SinkError } from '../sinks/types'

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

describe('createMemorySink', () => {
  it('reports no entry before a file is committed', async () => {
    const sink = createMemorySink()
    expect(await sink.stat(['a', 'b.dcm'])).toBeNull()
  })

  it('publishes a file only on close', async () => {
    // Mirrors a real FileSystemWritableFileStream, which stages into a swap file
    // and only publishes on close. Tests of the transfer path depend on it.
    const sink = createMemorySink()
    const writer = await sink.open(['a', 'b.dcm'])
    await writer.write(bytes(1, 2, 3))

    expect(await sink.stat(['a', 'b.dcm'])).toBeNull()
    expect(sink.openPaths).toEqual(['a/b.dcm'])

    await writer.close()

    expect(await sink.stat(['a', 'b.dcm'])).toEqual({ size: 3 })
    expect(sink.contents(['a', 'b.dcm'])).toEqual(bytes(1, 2, 3))
    expect(sink.openPaths).toEqual([])
  })

  it('concatenates chunks in write order', async () => {
    const sink = createMemorySink()
    const writer = await sink.open(['f.dcm'])
    await writer.write(bytes(1, 2))
    await writer.write(bytes(3))
    await writer.write(bytes(4, 5))
    await writer.close()
    expect(sink.contents(['f.dcm'])).toEqual(bytes(1, 2, 3, 4, 5))
  })

  it('discards everything on abort, leaving no entry for a new file', async () => {
    // This is the assertion that pins the cancellation-cleanup contract.
    const sink = createMemorySink()
    const writer = await sink.open(['a', 'b.dcm'])
    await writer.write(bytes(1, 2, 3))
    await writer.abort()

    expect(await sink.stat(['a', 'b.dcm'])).toBeNull()
    expect(sink.openPaths).toEqual([])
  })

  it('leaves a pre-existing file untouched when a rewrite aborts', async () => {
    const sink = createMemorySink()
    const first = await sink.open(['f.dcm'])
    await first.write(bytes(9, 9, 9))
    await first.close()

    const second = await sink.open(['f.dcm'])
    await second.write(bytes(1))
    await second.abort()

    expect(sink.contents(['f.dcm'])).toEqual(bytes(9, 9, 9))
  })

  it('treats abort as idempotent', async () => {
    // The transfer path's finally block may abort a writer that already settled.
    const sink = createMemorySink()
    const writer = await sink.open(['f.dcm'])
    await writer.abort()
    await expect(writer.abort()).resolves.toBeUndefined()
  })

  it('rejects a write or close after the writer settled', async () => {
    const sink = createMemorySink()
    const writer = await sink.open(['f.dcm'])
    await writer.close()
    await expect(writer.write(bytes(1))).rejects.toBeInstanceOf(SinkError)
    await expect(writer.close()).rejects.toBeInstanceOf(SinkError)
  })

  it('discards staged bytes on truncate(0)', async () => {
    const sink = createMemorySink()
    const writer = await sink.open(['f.dcm'])
    await writer.write(bytes(1, 2, 3))
    await writer.truncate(0)
    await writer.write(bytes(7))
    await writer.close()
    expect(sink.contents(['f.dcm'])).toEqual(bytes(7))
  })

  it('creates parent directories when opening', async () => {
    const sink = createMemorySink()
    const writer = await sink.open(['a', 'b', 'c', 'd.dcm'])
    await writer.close()
    expect(Array.from(sink.directories).sort()).toEqual(['a', 'a/b', 'a/b/c'])
  })

  it('creates the whole chain on mkdirp', async () => {
    const sink = createMemorySink()
    await sink.mkdirp(['x', 'y', 'z'])
    expect(Array.from(sink.directories).sort()).toEqual(['x', 'x/y', 'x/y/z'])
  })

  it('removes a directory subtree and its files', async () => {
    const sink = createMemorySink()
    const writer = await sink.open(['probe', 'deep', 'f.dcm'])
    await writer.close()
    await sink.removeDirectory(['probe'])
    expect(sink.contents(['probe', 'deep', 'f.dcm'])).toBeUndefined()
    expect(Array.from(sink.directories)).toEqual([])
  })

  it('does not throw when removing an absent file', async () => {
    const sink = createMemorySink()
    await expect(sink.remove(['nope.dcm'])).resolves.toBeUndefined()
  })

  it('injects a failure at a chosen operation', async () => {
    const sink = createMemorySink({
      failOn: (operation) => (operation === 'open' ? 'permission' : undefined),
    })
    await expect(sink.open(['f.dcm'])).rejects.toBeInstanceOf(SinkError)
  })

  it('injects a mid-transfer write failure once a byte threshold is passed', async () => {
    const sink = createMemorySink({
      failOn: (operation, _path, written) =>
        operation === 'write' && written >= 2 ? 'quota' : undefined,
    })
    const writer = await sink.open(['f.dcm'])
    await writer.write(bytes(1, 2))
    await expect(writer.write(bytes(3))).rejects.toMatchObject({
      code: 'quota',
    })
  })
})

describe('isFatalSinkError', () => {
  it('treats a full disk and a revoked grant as fatal for the whole job', () => {
    // Retrying 300 more files after the disk filled up just produces 300 more
    // failures, so these abandon the job rather than the file.
    expect(isFatalSinkError(new SinkError('quota', 'full'))).toBe(true)
    expect(isFatalSinkError(new SinkError('permission', 'denied'))).toBe(true)
  })

  it('treats a path or unknown failure as per-file', () => {
    expect(isFatalSinkError(new SinkError('path-not-found', 'too long'))).toBe(
      false,
    )
    expect(isFatalSinkError(new SinkError('unknown', 'huh'))).toBe(false)
  })

  it('ignores unrelated errors', () => {
    expect(isFatalSinkError(new Error('nope'))).toBe(false)
    expect(isFatalSinkError(undefined)).toBe(false)
  })
})
