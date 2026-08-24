/**
 * Scanner for S3 `ListObjectsV2` XML. Pure string handling — no `DOMParser`.
 *
 * Avoiding `DOMParser` is deliberate. It is a DOM global, so depending on it
 * would tie this file to a window, block the module from ever running inside a
 * worker, and make it untestable in any non-DOM environment. The listing format
 * is machine-generated and narrow enough that a scanner is the simpler
 * dependency-free option.
 *
 * The one non-obvious requirement: S3 can return an `<Error>` document under
 * HTTP 200, so a caller cannot classify a listing by status alone and must
 * inspect what comes back here.
 */

export interface S3Object {
  key: string
  /** Null when the listing omitted or malformed the size. */
  size: number | null
}

export interface S3ListPage {
  kind: 'page'
  objects: S3Object[]
  isTruncated: boolean
  nextContinuationToken?: string
}

export interface S3ErrorDocument {
  kind: 'error'
  code?: string
  message?: string
}

export type S3ListResult = S3ListPage | S3ErrorDocument

/** Decodes the five XML predefined entities. */
export const decodeXmlEntities = (value: string): string => {
  if (value.indexOf('&') === -1) {
    return value
  }
  return (
    value
      .split('&lt;')
      .join('<')
      .split('&gt;')
      .join('>')
      .split('&quot;')
      .join('"')
      .split('&apos;')
      .join("'")
      // Ampersand last, so a doubly-encoded entity is not decoded twice.
      .split('&amp;')
      .join('&')
  )
}

/**
 * Extracts the text of the first occurrence of `tag`.
 *
 * Scoped by an optional search window so a `<Key>` inside one `<Contents>` block
 * is never read as belonging to another.
 */
const readTag = (
  xml: string,
  tag: string,
  from = 0,
  to = xml.length,
): string | undefined => {
  const openTag = `<${tag}>`
  const closeTag = `</${tag}>`
  const start = xml.indexOf(openTag, from)
  if (start === -1 || start >= to) {
    return undefined
  }
  const valueStart = start + openTag.length
  const end = xml.indexOf(closeTag, valueStart)
  if (end === -1 || end > to) {
    return undefined
  }
  return decodeXmlEntities(xml.slice(valueStart, end))
}

const parseSize = (raw: string | undefined): number | null => {
  if (raw === undefined) {
    return null
  }
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Parses one listing response.
 *
 * Empty keys are skipped: S3 represents a "directory placeholder" object as a
 * key ending in the prefix itself, which is not a file and must not become a
 * zero-byte download.
 */
export const parseListObjectsV2 = (xml: string): S3ListResult => {
  if (xml.indexOf('<Error') !== -1 && xml.indexOf('<ListBucketResult') === -1) {
    return {
      kind: 'error',
      code: readTag(xml, 'Code'),
      message: readTag(xml, 'Message'),
    }
  }

  const objects: S3Object[] = []
  const openTag = '<Contents>'
  const closeTag = '</Contents>'
  let cursor = 0

  for (;;) {
    const start = xml.indexOf(openTag, cursor)
    if (start === -1) {
      break
    }
    const end = xml.indexOf(closeTag, start)
    if (end === -1) {
      break
    }
    const key = readTag(xml, 'Key', start, end)
    if (key !== undefined && key !== '' && !key.endsWith('/')) {
      objects.push({ key, size: parseSize(readTag(xml, 'Size', start, end)) })
    }
    cursor = end + closeTag.length
  }

  const isTruncated = readTag(xml, 'IsTruncated') === 'true'
  const nextContinuationToken = readTag(xml, 'NextContinuationToken')

  return {
    kind: 'page',
    objects,
    isTruncated,
    nextContinuationToken:
      isTruncated && nextContinuationToken !== ''
        ? nextContinuationToken
        : undefined,
  }
}
