/**
 * Public types for the direct-download module.
 *
 * This file has zero logic and zero imports by design: it is the vocabulary
 * both the engine and its hosts speak, and keeping it inert means a host can
 * `import type` from it without pulling in any runtime code.
 *
 * See ./README.md for the extraction contract these types are shaped by.
 */

// ---------------------------------------------------------------------------
// HTTP seam
// ---------------------------------------------------------------------------

/**
 * The subset of `fetch` this module uses.
 *
 * Deliberately narrower than the real thing so a test double is a few lines
 * rather than a polyfill: jsdom has no `fetch` and no `ReadableStream`, and the
 * engine must stay unit-testable there.
 */
export type HttpLike = (
  url: string,
  init?: HttpInit,
) => Promise<HttpResponseLike>

export interface HttpInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export interface HttpResponseLike {
  ok: boolean
  status: number
  headers: { get: (name: string) => string | null }
  text: () => Promise<string>
  json: () => Promise<unknown>
  /** Null for responses with no body (e.g. a 204, or a stubbed error). */
  body: { getReader: () => ByteReaderLike } | null
}

/**
 * A byte-stream reader. Modelled on `ReadableStreamDefaultReader<Uint8Array>`.
 *
 * The engine reads through this rather than `for await (… of response.body)`
 * so that it always knows how many bytes it has consumed — which is what makes
 * range-resume possible — and so a test can inject a mid-stream failure by
 * rejecting a single `read()`.
 */
export interface ByteReaderLike {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>
  cancel?: (reason?: unknown) => Promise<void>
}

// ---------------------------------------------------------------------------
// Resolution: turning DICOM identifiers into object-store locations
// ---------------------------------------------------------------------------

/** What the host asks to download. */
export interface SeriesSelector {
  /** Present when the selection came from a study rather than a slide. */
  studyInstanceUID?: string
  seriesInstanceUIDs: readonly string[]
}

export interface ResolveContext {
  signal: AbortSignal
  http: HttpLike
}

/**
 * Resolves DICOM identifiers to object-store locations.
 *
 * This is the boundary that keeps archive-specific knowledge out of the engine:
 * an implementation may talk to whatever index it likes, but it hands back a
 * finished `baseUrl` and `prefix`. The engine never composes a hostname, never
 * knows a bucket name, and never knows a region — which is why the engine
 * cannot develop the class of bug where a region field drifts out of sync with
 * a hardcoded URL.
 */
export interface SeriesResolver {
  /** Stable id, used in logs and to attribute a fallback recipe. */
  readonly id: string
  resolve: (
    selector: SeriesSelector,
    ctx: ResolveContext,
  ) => Promise<ResolveResult>
  /**
   * Commands the user can run when direct download is unavailable. Optional so
   * a minimal resolver need not implement it; when present it is the only place
   * archive-specific user-facing copy lives.
   */
  describeFallback?: (
    selector: SeriesSelector,
    resolved: ResolveResult | null,
  ) => FallbackRecipe
}

export interface ResolveResult {
  series: readonly ResolvedSeries[]
  /**
   * Requested UIDs the resolver could not place, never silently dropped.
   *
   * This is load-bearing rather than defensive: a slide annotated in the viewer
   * has SR/ANN series that exist only on the local DICOMweb server and will
   * never appear in a public archive index, so a slide-level request routinely
   * resolves fewer series than it asked for.
   */
  unresolved: readonly string[]
  notices?: readonly Notice[]
}

export interface ResolvedSeries {
  seriesInstanceUID: string
  studyInstanceUID: string
  /**
   * Every store holding this series. An array, not a single value, so a series
   * spanning two buckets is representable instead of being coerced into a
   * malformed hostname; the engine lists all of them and unions the keys.
   */
  sources: readonly SeriesSource[]
  instanceCount?: number
  /**
   * Rough size, used only to refuse a pathological request before issuing
   * listing calls. Authoritative sizes come from the listing itself.
   */
  estimatedBytes?: number
  facets: PathFacets
  license?: LicenseInfo
  citation?: string
}

/** Identifiers used to build on-disk paths. The engine only sanitizes these. */
export interface PathFacets {
  collection?: string
  patientId?: string
  studyInstanceUID: string
  seriesInstanceUID: string
  modality?: string
}

/**
 * v1 has a single member. The union exists so a DICOMweb/WADO-RS transport can
 * be added later without reshaping `ResolvedSeries`.
 */
export type SeriesSource = ObjectListSource

export interface ObjectListSource {
  kind: 'object-list'
  /** Fully-formed origin with no trailing slash, e.g. `https://b.s3.r.amazonaws.com`. */
  baseUrl: string
  /** Key prefix identifying this series within the store. */
  prefix: string
  /** Listing dialect. Only S3 ListObjectsV2 is implemented. */
  listing: 's3v2'
  /** Extra query parameters to include on listing requests. */
  listParams?: Readonly<Record<string, string>>
}

export interface LicenseInfo {
  id: string
  name: string
  url?: string
  commercialUseAllowed: boolean
}

export interface Notice {
  severity: 'info' | 'warning'
  code: string
  message: string
}

export interface FallbackRecipe {
  title: string
  docsUrl?: string
  snippets: readonly FallbackSnippet[]
}

export interface FallbackSnippet {
  language: 'python' | 'shell'
  label: string
  code: string
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type LayoutKind = 'nested' | 'flat'

/**
 * Everything needed to run a download, and everything the UI needs to decide
 * whether to offer one. Produced by `prepare()`; immutable.
 */
export interface DownloadPlan {
  readonly id: string
  readonly layout: LayoutKind
  readonly series: readonly PlannedSeries[]
  readonly files: readonly PlannedFile[]
  readonly totals: PlanTotals
  readonly unresolvedSeriesInstanceUIDs: readonly string[]
  readonly licenses: readonly LicenseInfo[]
  readonly citations: readonly string[]
  readonly warnings: readonly PlanIssue[]
  /** Non-empty means `start()` must refuse. */
  readonly blockers: readonly PlanIssue[]
  /** Longest projected relative path, in characters. Drives the MAX_PATH probe. */
  readonly longestRelativePathLength: number
}

export interface PlanTotals {
  series: number
  files: number
  bytes: number
  /** False when any listed object lacked a size, making `bytes` a lower bound. */
  bytesAreExact: boolean
}

export interface PlannedSeries {
  readonly seriesInstanceUID: string
  readonly studyInstanceUID: string
  readonly facets: PathFacets
  readonly fileCount: number
  readonly bytes: number
  readonly license?: LicenseInfo
}

export interface PlannedFile {
  readonly url: string
  /** Null when the listing did not report a size. */
  readonly sizeBytes: number | null
  /** Path relative to the destination root; last element is the filename. */
  readonly segments: readonly string[]
  readonly seriesInstanceUID: string
}

export type PlanIssueCode =
  | 'size-warning'
  | 'size-refused'
  | 'file-count-refused'
  | 'partial-resolution'
  | 'nothing-resolved'
  | 'non-commercial-license'
  | 'multi-source-series'
  | 'mobile-device'

export interface PlanIssue {
  code: PlanIssueCode
  /**
   * English, for hosts with no localization. A host that localizes should
   * switch on `code` and read `detail` rather than parsing this.
   */
  message: string
  detail?: Readonly<Record<string, string | number>>
}

export interface TransferLimits {
  /** Warn above this many bytes. */
  warnBytes: number
  /** Refuse above this many bytes. */
  refuseBytes: number
  /** Refuse above this many files. */
  maxFiles: number
}

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  factor: number
  maxDelayMs: number
  /** Cap on an honored `Retry-After`, beyond which the failure is not retried. */
  maxRetryAfterMs: number
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type CapabilityReason =
  | 'no-dom'
  | 'insecure-context'
  | 'no-file-system-access'
  | 'cross-origin-frame'
  | 'mobile'

export interface Capabilities {
  directDownload: 'supported' | 'unsupported'
  /** Every failing check, not just the first — the UI copy differs per reason. */
  reasons: readonly CapabilityReason[]
  platform: {
    os: 'windows' | 'macos' | 'linux' | 'other' | 'unknown'
    mobile: boolean
  }
  /** True when the destination should be probed for a path-length limit. */
  needsPathLengthProbe: boolean
}

/** Injectable view of the environment, so the ordered checks are testable. */
export interface CapabilityEnv {
  hasWindow: boolean
  isSecureContext: boolean
  hasDirectoryPicker: boolean
  isTopFrame: boolean
  platform: string
  maxTouchPoints: number
  userAgent: string
}

// ---------------------------------------------------------------------------
// Destination and progress
// ---------------------------------------------------------------------------

export type DownloadPhase =
  | 'idle'
  | 'resolving'
  | 'listing'
  | 'verifying'
  | 'transferring'
  | 'finalizing'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface ActiveFileProgress {
  name: string
  bytesWritten: number
  bytesTotal: number | null
}

export interface DownloadProgress {
  readonly phase: DownloadPhase
  readonly bytesTotal: number
  readonly bytesAreExact: boolean
  readonly bytesWritten: number
  readonly filesTotal: number
  readonly filesCompleted: number
  readonly filesSkipped: number
  readonly filesFailed: number
  readonly bytesPerSecond: number
  /** Null while unknowable, so a host never renders a fabricated estimate. */
  readonly etaSeconds: number | null
  readonly active: readonly ActiveFileProgress[]
  readonly lastError?: { code: string; message: string }
}

export type FailureCode =
  | 'http'
  | 'network'
  | 'sink'
  | 'size-mismatch'
  | 'quota'
  | 'permission'
  | 'aborted'

export interface FileFailure {
  segments: readonly string[]
  url: string
  code: FailureCode
  status?: number
  message: string
  attempts: number
}

export type DownloadOutcome =
  | 'completed'
  | 'completed-with-errors'
  | 'cancelled'
  | 'failed'

export interface DownloadReport {
  readonly outcome: DownloadOutcome
  readonly filesWritten: number
  readonly filesSkipped: number
  readonly filesFailed: number
  readonly bytesWritten: number
  readonly durationMs: number
  readonly failures: readonly FileFailure[]
  readonly manifestPath?: string
}

export interface DownloadJob {
  readonly id: string
  /**
   * Resolves with a report describing what happened. Never rejects: failures
   * are data, so a host cannot accidentally leave one unhandled.
   */
  readonly done: Promise<DownloadReport>
  readonly progress: DownloadProgress
  cancel: (reason?: string) => void
  subscribe: (listener: (progress: DownloadProgress) => void) => () => void
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type Logger = (level: LogLevel, message: string, data?: unknown) => void
