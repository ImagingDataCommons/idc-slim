/**
 * Bucket-to-license mapping for IDC.
 *
 * Derived from the bucket name rather than fetched, deliberately: the
 * commercial-use question must be answerable without a network call that could
 * fail, because getting it wrong is a licensing problem rather than a UX one.
 * The `-cr` buckets exist precisely to isolate commercial-use-restricted data.
 *
 * The authoritative license *name* can still be fetched from `POST /v3/licenses`
 * for display; that call is best-effort and falls back to what is known here.
 */

import type { LicenseInfo } from '../../types'

const CC_BY: LicenseInfo = {
  id: 'CC-BY-4.0',
  name: 'CC BY 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
  commercialUseAllowed: true,
}

const CC_BY_NC: LicenseInfo = {
  id: 'CC-BY-NC-4.0',
  name: 'CC BY-NC 4.0',
  url: 'https://creativecommons.org/licenses/by-nc/4.0/',
  commercialUseAllowed: false,
}

/**
 * Buckets whose contents carry a non-commercial restriction.
 *
 * Matched by suffix so a future sibling bucket following the same convention is
 * treated conservatively rather than being assumed permissive.
 */
const isCommercialRestricted = (bucket: string): boolean =>
  bucket.endsWith('-cr') || bucket.endsWith('-nc') || bucket === 'idc-open-cr'

export const licenseForBucket = (bucket: string): LicenseInfo =>
  isCommercialRestricted(bucket) ? CC_BY_NC : CC_BY

/** The most restrictive license in a set governs the whole selection. */
export const mostRestrictive = (
  licenses: readonly LicenseInfo[],
): LicenseInfo | undefined => {
  if (licenses.length === 0) {
    return undefined
  }
  const restricted = licenses.find((license) => !license.commercialUseAllowed)
  return restricted ?? licenses[0]
}
