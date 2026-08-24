/**
 * CSV manifest for the flat layout.
 *
 * The flat layout exists so a download can survive a destination with a
 * path-length limit, but it names files by their opaque object UUID — so
 * without this mapping the result is an unlabelled bag of files. The manifest is
 * what makes the fallback usable rather than merely successful.
 *
 * Appends are serialized onto a single awaited promise chain. Concurrent
 * un-awaited writes to one writable can reject or interleave, which would splice
 * rows together in exactly the file whose job is to be readable.
 */

import type { ByteWriter, DirectorySink } from '../sinks/types'
import type { PathFacets } from '../types'
import { MANIFEST_HEADER, manifestRow } from './layout'

const encode = (text: string): Uint8Array => {
  // Deliberately not TextEncoder: it is absent in some test environments, and
  // manifest content is ASCII by construction (identifiers and separators).
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    out[i] = code < 128 ? code : 63 // '?' for anything outside ASCII
  }
  return out
}

export interface ManifestWriter {
  readonly path: readonly string[]
  append: (fileName: string, facets: PathFacets) => void
  /** Waits for every queued append, then commits. */
  close: () => Promise<void>
  abort: () => Promise<void>
}

export interface ManifestOptions {
  sink: DirectorySink
  /** Directory the manifest is written into. */
  directory: readonly string[]
  /** Stable timestamp for the filename; injected so runs are reproducible. */
  timestamp: string
}

export const createManifestWriter = async (
  options: ManifestOptions,
): Promise<ManifestWriter> => {
  const path = [
    ...options.directory,
    `slim_download_manifest_${options.timestamp}.csv`,
  ]
  const writer: ByteWriter = await options.sink.open(path)

  // Every append chains onto this, so writes reach the stream one at a time and
  // in call order regardless of how many transfers complete at once.
  let chain: Promise<void> = writer.write(encode(MANIFEST_HEADER))
  let settled = false

  return {
    path,
    append: (fileName, facets) => {
      if (settled) {
        return
      }
      chain = chain.then(async () => {
        await writer.write(encode(manifestRow(fileName, facets)))
      })
    },
    close: async () => {
      if (settled) {
        return
      }
      settled = true
      await chain
      await writer.close()
    },
    abort: async () => {
      if (settled) {
        return
      }
      settled = true
      // Swallow: the queued writes are being discarded anyway, and a rejection
      // here would mask whatever caused the abort.
      await chain.catch(() => undefined)
      await writer.abort()
    },
  }
}
