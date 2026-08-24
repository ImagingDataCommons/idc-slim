/**
 * Local structural typings for the File System Access API.
 *
 * These are declared as plain interfaces rather than a `declare global`
 * augmentation on purpose. TypeScript 4.7's `lib.dom` has
 * `FileSystemDirectoryHandle` but not `createWritable` or
 * `FileSystemWritableFileStream`, so something has to supply them here — but a
 * global augmentation would collide with a newer `lib.dom`, or with
 * `@types/wicg-file-system-access`, the moment this module is lifted into a host
 * on a later TypeScript. Structural interfaces plus one cast at the picker
 * boundary port cleanly to either.
 */

export interface FileSystemWritableFileStreamLike {
  write: (data: BufferSource) => Promise<void>
  truncate: (size: number) => Promise<void>
  close: () => Promise<void>
  abort: (reason?: unknown) => Promise<void>
}

export interface FileSystemFileHandleLike {
  readonly kind: 'file'
  readonly name: string
  getFile: () => Promise<{ size: number }>
  createWritable: (options?: {
    keepExistingData?: boolean
  }) => Promise<FileSystemWritableFileStreamLike>
}

export interface FileSystemDirectoryHandleLike {
  readonly kind: 'directory'
  readonly name: string
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<FileSystemDirectoryHandleLike>
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<FileSystemFileHandleLike>
  removeEntry: (
    name: string,
    options?: { recursive?: boolean },
  ) => Promise<void>
}

export interface DirectoryPickerOptions {
  id?: string
  startIn?:
    | 'downloads'
    | 'documents'
    | 'desktop'
    | 'pictures'
    | 'videos'
    | 'music'
  mode?: 'read' | 'readwrite'
}

/** The subset of `window` this module reaches for. */
export interface FileSystemAccessWindow {
  showDirectoryPicker: (
    options?: DirectoryPickerOptions,
  ) => Promise<FileSystemDirectoryHandleLike>
}
