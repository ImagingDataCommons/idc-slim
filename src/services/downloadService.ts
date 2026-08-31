/**
 * The bridge between this application and the download module.
 *
 * This is the **only** file that imports both `AppConfig` and
 * `services/download`, which is what keeps the module liftable: everything
 * application-shaped stops here.
 *
 * The service is memoized at module scope rather than held in component state,
 * deliberately. A running download must survive the user switching slides or the
 * viewer unmounting — putting it in the React tree would abandon a transfer on
 * the next re-render.
 */

import type AppConfig from '../AppConfig'
import { logger } from '../utils/logger'
import {
  type Capabilities,
  createDownloadService,
  createIdcSeriesResolver,
  type DownloadService,
  detectCapabilities,
  type Logger,
} from './download'

const toModuleLogger = (): Logger => (level, message, data) => {
  const line = `[download] ${message}`
  if (level === 'error') {
    logger.error(line, data)
  } else if (level === 'warn') {
    logger.warn(line, data)
  } else if (level === 'info') {
    logger.log(line, data)
  } else {
    logger.debug(line, data)
  }
}

let cached: DownloadService | null | undefined
let cachedCapabilities: Capabilities | undefined

/** Capabilities of the current browser. Probed once; the answer cannot change. */
export const getDownloadCapabilities = (): Capabilities => {
  if (cachedCapabilities === undefined) {
    cachedCapabilities = detectCapabilities()
  }
  return cachedCapabilities
}

/**
 * The configured service, or null when this deployment has not enabled direct
 * download or names a provider we do not implement.
 *
 * Null is a normal answer, not an error: it is how a non-archive deployment ends
 * up with the command-line instructions and no download button.
 */
export const getDownloadService = (
  config: AppConfig,
): DownloadService | null => {
  if (cached !== undefined) {
    return cached
  }

  const settings = config.download
  if (settings?.enabled !== true) {
    cached = null
    return cached
  }
  if (settings.provider !== 'idc') {
    logger.warn(
      `[download] unknown provider "${String(settings.provider)}"; direct download disabled`,
    )
    cached = null
    return cached
  }

  const limits = settings.limits
  cached = createDownloadService({
    resolver: createIdcSeriesResolver(settings.idc),
    capabilities: getDownloadCapabilities(),
    layout: settings.layout,
    concurrency: settings.concurrency,
    limits:
      limits === undefined
        ? undefined
        : {
            ...(limits.warnBytes !== undefined
              ? { warnBytes: limits.warnBytes }
              : {}),
            ...(limits.refuseBytes !== undefined
              ? { refuseBytes: limits.refuseBytes }
              : {}),
            ...(limits.maxFiles !== undefined
              ? { maxFiles: limits.maxFiles }
              : {}),
          },
    logger: toModuleLogger(),
  })
  return cached
}

/** Test seam: forgets the memoized service. */
export const resetDownloadService = (): void => {
  cached = undefined
  cachedCapabilities = undefined
}
