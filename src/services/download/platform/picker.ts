/**
 * The only place `showDirectoryPicker()` is called.
 *
 * **Call this as the first statement of a click handler.** The picker requires
 * transient user activation, and any `await` before it — a network request, an
 * async confirmation dialog, even a state update that yields — consumes that
 * activation and makes the call throw. That is why the service exposes
 * `prepare()` separately: everything that needs the network happens before the
 * user clicks, so the click handler has nothing to do but pick and start.
 *
 * Failures are returned, not thrown, so a host cannot accidentally treat a user
 * pressing Escape as an error worth reporting.
 */

import { createFileSystemAccessSink } from '../sinks/fsaSink'
import type {
  DirectoryPickerOptions,
  FileSystemAccessWindow,
} from '../sinks/fsaTypes'
import type { DirectorySink } from '../sinks/types'

export type PickFailureReason =
  /** The user dismissed the picker. Not an error. */
  | 'dismissed'
  /** The call was refused: no activation, or a cross-origin frame. */
  | 'blocked'
  /** No File System Access API in this browser. */
  | 'unsupported'

export type PickResult =
  | { ok: true; sink: DirectorySink; label: string }
  | { ok: false; reason: PickFailureReason; cause?: unknown }

export const pickDestination = async (
  options: DirectoryPickerOptions = {},
): Promise<PickResult> => {
  if (typeof window === 'undefined') {
    return { ok: false, reason: 'unsupported' }
  }

  const picker = (window as unknown as Partial<FileSystemAccessWindow>)
    .showDirectoryPicker
  if (typeof picker !== 'function') {
    return { ok: false, reason: 'unsupported' }
  }

  try {
    const handle = await picker({
      id: options.id ?? 'slim-downloads',
      startIn: options.startIn ?? 'downloads',
      mode: options.mode ?? 'readwrite',
    })
    return {
      ok: true,
      sink: createFileSystemAccessSink(handle),
      label: handle.name,
    }
  } catch (error) {
    const name =
      typeof error === 'object' && error !== null && 'name' in error
        ? String((error as { name: unknown }).name)
        : ''
    if (name === 'AbortError') {
      // The user closed the dialog. Expected, and not worth surfacing.
      return { ok: false, reason: 'dismissed', cause: error }
    }
    // SecurityError is the cross-origin-frame case; NotAllowedError is a lost
    // or absent user activation.
    return { ok: false, reason: 'blocked', cause: error }
  }
}
