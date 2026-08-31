/**
 * An in-memory `DirectorySink`.
 *
 * This is the test double the transfer path is exercised against — jsdom has no
 * File System Access API, so without it the interesting code (retry,
 * range-resume, abort cleanup) would only ever be verified by hand in a browser.
 *
 * It models the two behaviours that matter for correctness assertions: a file
 * only becomes visible once `close()` commits it, and `abort()` discards it —
 * mirroring how a real `FileSystemWritableFileStream` uses a swap file. That is
 * what lets a test assert "after an aborted transfer of a new file, the sink
 * holds no entry" and "after an aborted transfer of an existing file, the old
 * bytes are unchanged".
 */

import {
  type ByteWriter,
  type DirectorySink,
  type FileStat,
  SinkError,
  type SinkErrorCode,
} from './types'

export type SinkOperation =
  | 'stat'
  | 'open'
  | 'write'
  | 'close'
  | 'remove'
  | 'mkdirp'

export interface MemorySinkOptions {
  label?: string
  /**
   * Injects a failure. Return a code to fail the operation, or undefined to let
   * it proceed. `bytesWritten` is set for 'write' so a test can fail a transfer
   * partway through.
   */
  failOn?: (
    operation: SinkOperation,
    path: string,
    bytesWritten: number,
  ) => SinkErrorCode | undefined
}

export interface MemorySink extends DirectorySink {
  /** Committed files only, keyed by '/'-joined path. */
  readonly files: ReadonlyMap<string, Uint8Array>
  /** Directories created via mkdirp or as a side effect of open. */
  readonly directories: ReadonlySet<string>
  /** Paths currently open and not yet closed or aborted. */
  readonly openPaths: readonly string[]
  contents: (segments: readonly string[]) => Uint8Array | undefined
}

const joinPath = (segments: readonly string[]): string => segments.join('/')

const concat = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total)
  let offset = 0
  for (let i = 0; i < chunks.length; i += 1) {
    out.set(chunks[i], offset)
    offset += chunks[i].byteLength
  }
  return out
}

export const createMemorySink = (
  options: MemorySinkOptions = {},
): MemorySink => {
  const files = new Map<string, Uint8Array>()
  const directories = new Set<string>()
  const open = new Set<string>()
  const label = options.label ?? 'memory'

  const check = (
    operation: SinkOperation,
    path: string,
    bytesWritten = 0,
  ): void => {
    const code = options.failOn?.(operation, path, bytesWritten)
    if (code !== undefined) {
      throw new SinkError(code, `${operation} failed for ${path}`)
    }
  }

  const addDirectories = (segments: readonly string[]): void => {
    for (let i = 1; i <= segments.length; i += 1) {
      directories.add(joinPath(segments.slice(0, i)))
    }
  }

  return {
    label,

    files,
    directories,
    get openPaths(): readonly string[] {
      return Array.from(open)
    },

    contents: (segments) => files.get(joinPath(segments)),

    stat: async (segments): Promise<FileStat | null> => {
      const path = joinPath(segments)
      check('stat', path)
      const existing = files.get(path)
      return existing === undefined ? null : { size: existing.byteLength }
    },

    open: async (segments): Promise<ByteWriter> => {
      const path = joinPath(segments)
      check('open', path)
      addDirectories(segments.slice(0, -1))
      open.add(path)

      // Buffered, not written through: a real writable stages into a swap file
      // and only publishes on close, and tests depend on that distinction.
      let chunks: Uint8Array[] = []
      let total = 0
      let settled = false

      return {
        write: async (chunk) => {
          if (settled) {
            throw new SinkError('unknown', `write after settle for ${path}`)
          }
          check('write', path, total)
          chunks.push(chunk)
          total += chunk.byteLength
        },
        truncate: async (size) => {
          if (size !== 0) {
            throw new SinkError(
              'unknown',
              `memory sink only supports truncate(0), got ${size}`,
            )
          }
          chunks = []
          total = 0
        },
        close: async () => {
          if (settled) {
            throw new SinkError('unknown', `close after settle for ${path}`)
          }
          check('close', path, total)
          settled = true
          open.delete(path)
          files.set(path, concat(chunks, total))
        },
        abort: async () => {
          // Idempotent, because the transfer path's `finally` may abort a writer
          // that already settled on an error.
          if (settled) {
            return
          }
          settled = true
          open.delete(path)
          chunks = []
          total = 0
        },
      }
    },

    remove: async (segments) => {
      const path = joinPath(segments)
      check('remove', path)
      files.delete(path)
    },

    mkdirp: async (segments) => {
      check('mkdirp', joinPath(segments))
      addDirectories(segments)
    },

    removeDirectory: async (segments) => {
      const prefix = `${joinPath(segments)}/`
      const root = joinPath(segments)
      directories.delete(root)
      for (const dir of Array.from(directories)) {
        if (dir.startsWith(prefix)) {
          directories.delete(dir)
        }
      }
      for (const file of Array.from(files.keys())) {
        if (file.startsWith(prefix)) {
          files.delete(file)
        }
      }
    },
  }
}
