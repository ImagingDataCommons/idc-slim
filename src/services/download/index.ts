/**
 * Direct in-browser download of DICOM objects.
 *
 * This is the module's only public entry point. Importing from an internal path
 * (`download/core/transfer`, say) is unsupported: those paths are free to move.
 *
 * The module has no dependencies, no React, and no imports from the surrounding
 * application, so it can be lifted into a standalone package without code
 * changes. `__tests__/extraction.test.ts` enforces that mechanically.
 *
 * See ./README.md for the four-call protocol and the user-activation rule that
 * shapes it.
 */

// Thresholds and formatting, so a host can render the same numbers.
export { assessLimits, DEFAULT_LIMITS, formatBytes } from './core/limits'
export { DEFAULT_RETRY_POLICY } from './core/retry'
export { defaultConcurrency } from './core/scheduler'
// Capability detection, for deciding which UI tier to show.
export {
  detectCapabilities,
  probeCapabilities,
  readEnvironment,
} from './platform/capabilities'

// Destination verification, including the Windows path-length probe.
export {
  type DestinationCheck,
  PROBE_PATH_LENGTH_THRESHOLD,
  verifyDestination,
} from './platform/pathProbe'
// Destination selection. Must be called first in a user-gesture handler.
export {
  type PickFailureReason,
  type PickResult,
  pickDestination,
} from './platform/picker'
export { licenseForBucket, mostRestrictive } from './resolvers/idc/licenses'
// Resolvers. The IDC implementation is the only archive-aware code here, and a
// host selects it explicitly — nothing in the engine references it.
export {
  createIdcSeriesResolver,
  IDC_API_BASE,
  IDC_AWS_REGION,
  type IdcResolverOptions,
} from './resolvers/idc/resolver'
// The service: prepare -> pick -> verify -> start.
export {
  createDownloadService,
  DownloadBlockedError,
  DownloadBusyError,
  type DownloadService,
  type DownloadServiceConfig,
  type PrepareResult,
} from './service'
export { createFileSystemAccessSink } from './sinks/fsaSink'
export type {
  DirectoryPickerOptions,
  FileSystemDirectoryHandleLike,
} from './sinks/fsaTypes'
export { createMemorySink, type MemorySink } from './sinks/memorySink'
// Sinks: the destination seam.
export type {
  ByteWriter,
  DirectorySink,
  FileStat,
  SinkErrorCode,
} from './sinks/types'
export { isFatalSinkError, SinkError } from './sinks/types'
// Types — the vocabulary hosts speak.
export type {
  ActiveFileProgress,
  ByteReaderLike,
  Capabilities,
  CapabilityEnv,
  CapabilityReason,
  DownloadJob,
  DownloadOutcome,
  DownloadPhase,
  DownloadPlan,
  DownloadProgress,
  DownloadReport,
  FailureCode,
  FallbackRecipe,
  FallbackSnippet,
  FileFailure,
  HttpInit,
  HttpLike,
  HttpResponseLike,
  LayoutKind,
  LicenseInfo,
  Logger,
  LogLevel,
  Notice,
  ObjectListSource,
  PathFacets,
  PlanIssue,
  PlanIssueCode,
  PlannedFile,
  PlannedSeries,
  PlanTotals,
  ResolveContext,
  ResolvedSeries,
  ResolveResult,
  RetryPolicy,
  SeriesResolver,
  SeriesSelector,
  SeriesSource,
  TransferLimits,
} from './types'
