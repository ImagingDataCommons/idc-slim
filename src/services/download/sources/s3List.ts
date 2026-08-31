/**
 * Enumerates the objects under a prefix via S3 `ListObjectsV2`.
 *
 * Anonymous and unsigned: the archive buckets this targets are public and
 * CORS-enabled for `GET`/`HEAD`, so no credentials or signing are involved.
 */

import {
  backoffDelayMs,
  isRetryableS3Code,
  isRetryableStatus,
  parseRetryAfter,
} from '../core/retry'
import type { HttpLike, ObjectListSource, RetryPolicy } from '../types'
import { parseListObjectsV2, type S3ListPage, type S3Object } from './s3Xml'

export class S3ListError extends Error {
  readonly code?: string
  readonly status?: number

  constructor(message: string, code?: string, status?: number) {
    super(message)
    this.name = 'S3ListError'
    this.code = code
    this.status = status
    Object.setPrototypeOf(this, S3ListError.prototype)
  }
}

export interface ListOptions {
  http: HttpLike
  signal: AbortSignal
  retry: RetryPolicy
  now: () => number
  random: () => number
  sleep: (ms: number) => Promise<void>
  /** Guards against a malformed continuation loop. */
  maxPages?: number
}

const buildUrl = (source: ObjectListSource, token?: string): string => {
  const params: string[] = ['list-type=2']
  if (source.prefix !== '') {
    params.push(`prefix=${encodeURIComponent(source.prefix)}`)
  }
  if (token !== undefined) {
    params.push(`continuation-token=${encodeURIComponent(token)}`)
  }
  if (source.listParams !== undefined) {
    for (const name of Object.keys(source.listParams)) {
      params.push(
        `${encodeURIComponent(name)}=${encodeURIComponent(source.listParams[name])}`,
      )
    }
  }
  return `${source.baseUrl}/?${params.join('&')}`
}

/**
 * Lists every object under the source's prefix, following continuation tokens.
 *
 * Retries the transient cases, including an `<Error>` document returned under
 * HTTP 200. A page that fails permanently throws rather than returning a partial
 * listing: a truncated listing would silently become a truncated download, which
 * is the failure mode this whole design is trying to avoid.
 */
export const listObjects = async (
  source: ObjectListSource,
  options: ListOptions,
): Promise<S3Object[]> => {
  const maxPages = options.maxPages ?? 1000
  const objects: S3Object[] = []
  let token: string | undefined
  let pages = 0

  for (;;) {
    if (options.signal.aborted) {
      throw new S3ListError('Listing aborted')
    }

    const url = buildUrl(source, token)
    let attempt = 0
    let page: S3ListPage | undefined

    for (;;) {
      let status = 0
      let retryAfterMs: number | undefined
      let transient = false
      let failure: string | undefined
      let code: string | undefined

      try {
        const response = await options.http(url, { signal: options.signal })
        status = response.status
        if (!response.ok) {
          retryAfterMs = parseRetryAfter(
            response.headers.get('retry-after'),
            options.now(),
          )
          transient = isRetryableStatus(status)
          failure = `Listing failed with HTTP ${status}`
        } else {
          const parsed = parseListObjectsV2(await response.text())
          if (parsed.kind === 'error') {
            code = parsed.code
            transient = isRetryableS3Code(parsed.code)
            failure =
              `Listing failed: ${parsed.code ?? 'unknown'} ${parsed.message ?? ''}`.trim()
          } else {
            page = parsed
          }
        }
      } catch (error) {
        if (options.signal.aborted) {
          throw new S3ListError('Listing aborted')
        }
        // A network-level failure has no status and is always worth retrying.
        transient = true
        failure = error instanceof Error ? error.message : 'Network error'
      }

      if (page !== undefined) {
        break
      }

      attempt += 1
      if (!transient || attempt >= options.retry.maxAttempts) {
        throw new S3ListError(failure ?? 'Listing failed', code, status)
      }
      await options.sleep(
        backoffDelayMs(
          attempt - 1,
          options.retry,
          options.random,
          retryAfterMs,
        ),
      )
    }

    for (const object of page.objects) {
      objects.push(object)
    }

    pages += 1
    if (!page.isTruncated || page.nextContinuationToken === undefined) {
      break
    }
    if (pages >= maxPages) {
      throw new S3ListError(
        `Listing exceeded ${maxPages} pages; refusing to continue`,
      )
    }
    token = page.nextContinuationToken
  }

  return objects
}
