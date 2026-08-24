/**
 * Adapts a `FileSystemDirectoryHandle` to the module's `DirectorySink`.
 *
 * Deliberately thin and policy-free: it translates calls and maps
 * `DOMException.name` to a `SinkErrorCode`, and does nothing else. All the
 * decisions — what to retry, when to abort, whether a failure is fatal — live in
 * `core/transfer.ts`, where they can be unit-tested. This file cannot be tested
 * under jsdom, so the less it contains, the less goes unverified.
 */

import type {
  FileSystemDirectoryHandleLike,
  FileSystemFileHandleLike,
} from './fsaTypes'
import type { ByteWriter, DirectorySink, FileStat } from './types'
import { SinkError, type SinkErrorCode } from './types'

const classify = (error: unknown): SinkErrorCode => {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : ''
  switch (name) {
    case 'QuotaExceededError':
      return 'quota'
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permission'
    case 'NotFoundError':
      // Also how a Windows MAX_PATH violation presents on a create attempt,
      // which is why the path probe reads this specific code.
      return 'path-not-found'
    default:
      return 'unknown'
  }
}

const wrap = (error: unknown, context: string): SinkError => {
  const message =
    error instanceof Error ? error.message : 'File system operation failed'
  return new SinkError(classify(error), `${context}: ${message}`, error)
}

export const createFileSystemAccessSink = (
  root: FileSystemDirectoryHandleLike,
  label?: string,
): DirectorySink => {
  // Each directory is resolved once and reused. The reference implementation
  // re-walked the whole chain per file, which both costs a round trip per level
  // and lets concurrent transfers race on creating the same directory.
  const directories = new Map<string, Promise<FileSystemDirectoryHandleLike>>()

  const resolveDirectory = (
    segments: readonly string[],
  ): Promise<FileSystemDirectoryHandleLike> => {
    const key = segments.join('/')
    const cached = directories.get(key)
    if (cached !== undefined) {
      return cached
    }
    const parent =
      segments.length === 0
        ? Promise.resolve(root)
        : resolveDirectory(segments.slice(0, -1))
    const created = parent.then(async (handle) => {
      if (segments.length === 0) {
        return handle
      }
      return await handle.getDirectoryHandle(segments[segments.length - 1], {
        create: true,
      })
    })
    directories.set(key, created)
    return created
  }

  const fileHandle = async (
    segments: readonly string[],
    create: boolean,
  ): Promise<FileSystemFileHandleLike> => {
    const directory = await resolveDirectory(segments.slice(0, -1))
    return await directory.getFileHandle(segments[segments.length - 1], {
      create,
    })
  }

  return {
    label: label ?? root.name,

    stat: async (segments): Promise<FileStat | null> => {
      try {
        const handle = await fileHandle(segments, false)
        const file = await handle.getFile()
        return { size: file.size }
      } catch (error) {
        if (classify(error) === 'path-not-found') {
          // Absent, which is a normal answer rather than a failure.
          return null
        }
        throw wrap(error, `stat ${segments.join('/')}`)
      }
    },

    open: async (segments): Promise<ByteWriter> => {
      let stream: Awaited<
        ReturnType<FileSystemFileHandleLike['createWritable']>
      >
      try {
        const handle = await fileHandle(segments, true)
        stream = await handle.createWritable()
      } catch (error) {
        throw wrap(error, `open ${segments.join('/')}`)
      }

      // Guards double-settling: the transfer path's finally block may abort a
      // writer that already closed, and close-after-abort throws.
      let settled = false

      return {
        write: async (chunk) => {
          try {
            await stream.write(chunk)
          } catch (error) {
            throw wrap(error, `write ${segments.join('/')}`)
          }
        },
        truncate: async (size) => {
          try {
            await stream.truncate(size)
          } catch (error) {
            throw wrap(error, `truncate ${segments.join('/')}`)
          }
        },
        close: async () => {
          if (settled) {
            return
          }
          settled = true
          try {
            await stream.close()
          } catch (error) {
            throw wrap(error, `close ${segments.join('/')}`)
          }
        },
        abort: async () => {
          if (settled) {
            return
          }
          settled = true
          try {
            await stream.abort()
          } catch {
            // Already on a failure path; a rejection here would mask the cause.
          }
        },
      }
    },

    remove: async (segments) => {
      try {
        const directory = await resolveDirectory(segments.slice(0, -1))
        await directory.removeEntry(segments[segments.length - 1])
      } catch (error) {
        if (classify(error) === 'path-not-found') {
          return
        }
        throw wrap(error, `remove ${segments.join('/')}`)
      }
    },

    mkdirp: async (segments) => {
      try {
        await resolveDirectory(segments)
      } catch (error) {
        throw wrap(error, `mkdir ${segments.join('/')}`)
      }
    },

    removeDirectory: async (segments) => {
      try {
        const parent = await resolveDirectory(segments.slice(0, -1))
        await parent.removeEntry(segments[segments.length - 1], {
          recursive: true,
        })
      } catch (error) {
        if (classify(error) === 'path-not-found') {
          return
        }
        throw wrap(error, `rmdir ${segments.join('/')}`)
      } finally {
        // Drop cached handles beneath the removed path so a later write does not
        // reuse a handle to a directory that no longer exists.
        const prefix = segments.join('/')
        for (const key of Array.from(directories.keys())) {
          if (key === prefix || key.indexOf(`${prefix}/`) === 0) {
            directories.delete(key)
          }
        }
      }
    },
  }
}
