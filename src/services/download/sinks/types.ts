/**
 * The destination seam.
 *
 * Everything that writes bytes goes through `DirectorySink`, so the engine has
 * no direct dependency on the File System Access API. That buys two things:
 * the whole transfer path is unit-testable under jsdom against an in-memory
 * implementation, and a host on a different platform can supply its own
 * destination without the engine changing.
 */

/** Reason a sink operation failed, mapped from platform errors by the adapter. */
export type SinkErrorCode =
  /** Out of disk space or over a storage quota. Fatal for a whole job. */
  | 'quota'
  /** The grant was revoked or never included write access. Fatal for a job. */
  | 'permission'
  /**
   * A path could not be created. On Windows this is how a MAX_PATH violation
   * presents, which is why it is distinguished from a generic failure.
   */
  | 'path-not-found'
  | 'unknown'

export class SinkError extends Error {
  readonly code: SinkErrorCode
  readonly cause?: unknown

  constructor(code: SinkErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'SinkError'
    this.code = code
    this.cause = cause
    // Restores the prototype chain under `target: es5`, where subclassing a
    // built-in otherwise leaves `instanceof SinkError` false.
    Object.setPrototypeOf(this, SinkError.prototype)
  }
}

/** True when this failure should abandon the entire job, not just one file. */
export const isFatalSinkError = (error: unknown): boolean =>
  error instanceof SinkError &&
  (error.code === 'quota' || error.code === 'permission')

export interface FileStat {
  size: number
}

/**
 * An open file being written.
 *
 * `write` returns a promise and callers must await it: that is what gives the
 * read loop backpressure instead of letting the writable's queue grow to the
 * difference between network and disk throughput.
 */
export interface ByteWriter {
  write: (chunk: Uint8Array) => Promise<void>
  /** Discards previously written bytes; used when a ranged retry is refused. */
  truncate: (size: number) => Promise<void>
  /** Commits the file. Must not be called after `abort`. */
  close: () => Promise<void>
  /** Discards the file's pending contents. Safe to call more than once. */
  abort: () => Promise<void>
}

export interface DirectorySink {
  /** Human-readable destination name, for progress UI. */
  readonly label: string
  /** Null when the entry does not exist. */
  stat: (segments: readonly string[]) => Promise<FileStat | null>
  /** Opens a file for writing, creating parent directories as needed. */
  open: (segments: readonly string[]) => Promise<ByteWriter>
  /** Removes a file. Must not throw when the entry is already absent. */
  remove: (segments: readonly string[]) => Promise<void>
  /** Creates a directory chain. Used by the path-length probe. */
  mkdirp: (segments: readonly string[]) => Promise<void>
  /** Removes a directory and everything under it. Used to clean up probes. */
  removeDirectory: (segments: readonly string[]) => Promise<void>
}
