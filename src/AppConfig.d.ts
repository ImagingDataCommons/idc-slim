// skipcq: JS-C1003
import * as dcmjs from 'dcmjs'

export type DicomWebManagerErrorHandler = (
  error: dwc.api.DICOMwebClientError,
  serverSettings: ServerSettings,
) => void

export interface DICOMwebClientRequestHookMetadata {
  url: string
  method: string
  /** Combined request headers from dicomweb-client (needed to re-apply after retry open()). */
  headers?: Record<string, string>
}

export interface RetryRequestSettings {
  retries?: number
  factor?: number
  minTimeout?: number
  maxTimeout?: number
  randomize?: boolean
  retryableStatusCodes?: number[]
}

export interface EvaluationSetting {
  name: dcmjs.sr.coding.CodeOptions
  values: dcmjs.sr.coding.CodeOptions[]
}

export interface MeasurementSetting {
  name: dcmjs.sr.coding.CodeOptions
  unit: dcmjs.sr.coding.CodeOptions
}

export interface AnnotationSettings {
  finding: dcmjs.sr.coding.CodeOptions
  findingCategory?: dcmjs.sr.coding.CodeOptions
  evaluations?: EvaluationSetting[]
  measurements?: MeasurementSetting[]
  geometryTypes?: string[]
  style?: {
    stroke: {
      color: number[]
      width: number
    }
    fill: {
      color: number[]
    }
    radius?: number
  }
}

export interface ErrorMessageSettings {
  status: number
  message: string
}

export interface ServerSettings {
  id: string
  url?: string
  path?: string
  write: boolean
  read?: boolean
  qidoPathPrefix?: string
  wadoPathPrefix?: string
  stowPathPrefix?: string
  retry?: RetryRequestSettings
  errorMessages?: ErrorMessageSettings[]
  storageClasses?: string[]
  upgradeInsecureRequests?: boolean
}

export interface OidcSettings {
  authority: string
  clientId: string
  scope: string
  grantType?: string
  authorizationEndpoint?: string
  endSessionEndpoint?: string
}

export interface DownloadStudyDialogSettings {
  description: string
  instructions: Array<{
    command: string
    label: string
  }>
}

/**
 * Direct in-browser download of DICOM files, streamed from public object
 * storage into a folder the user picks.
 *
 * Absent or `enabled: false` leaves the existing command-line instructions as
 * the only option, which is the right default: a deployment pointed at a
 * DICOMweb server that is not backed by a supported archive has nothing for the
 * resolver to find, and offering a button that resolves nothing is worse than
 * not offering one.
 */
export interface DownloadSettings {
  /** Defaults to false. Must be set explicitly to show the direct option. */
  enabled?: boolean
  /** Which archive to resolve identifiers against. */
  provider?: 'idc'
  /** Overrides for the IDC resolver; only read when `provider` is 'idc'. */
  idc?: {
    /** Defaults to the public IDC v3 API. v1 and v2 are deprecated. */
    baseUrl?: string
    region?: string
    pageSize?: number
    docsUrl?: string
  }
  /**
   * On-disk layout. 'nested' mirrors the `idc download` CLI's tree; 'flat'
   * keeps paths short for destinations with a length limit and writes a CSV
   * manifest mapping filenames back to identifiers.
   */
  layout?: 'nested' | 'flat'
  /** Parallel transfers. Defaults to the per-origin connection limit. */
  concurrency?: number
  limits?: {
    /** Warn above this size, in bytes. */
    warnBytes?: number
    /** Refuse above this size, in bytes. */
    refuseBytes?: number
    maxFiles?: number
  }
}

export default interface AppConfig {
  /**
   * Currently, only one server is supported. However, support for multiple
   * servers is planned and the "server" parameter therefore expects an array.
   * Authentication and authorization for any of the servers is expected to go
   * through the same identity provider and authorization server using the OIDC
   * and OAuth 2.0 protocols (see "oidc" parameter).
   */
  servers: ServerSettings[]
  path: string
  annotations: AnnotationSettings[]
  organization?: string
  gcpBaseUrl?: string
  oidc?: OidcSettings
  disableWorklist?: boolean
  disableAnnotationTools?: boolean
  enableServerSelection?: boolean
  mode?: string
  preload?: boolean
  downloadStudyDialog?: DownloadStudyDialogSettings
  download?: DownloadSettings
  messages?: {
    disabled?: boolean | string[]
    top?: number
    duration?: number
  }
  logger?: {
    level?: 'DEBUG' | 'LOG' | 'WARN' | 'ERROR' | 'NONE'
    enableInProduction?: boolean
    enableInDevelopment?: boolean
  }
  enableMemoryMonitoring?: boolean
}
