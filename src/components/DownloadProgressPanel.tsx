import { Alert, Button, Progress, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'
import type {
  DownloadJob,
  DownloadProgress,
  DownloadReport,
} from '../services/download'
import { formatBytes } from '../services/download'

const { Text } = Typography

const formatDuration = (seconds: number): string => {
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m ${rest < 10 ? '0' : ''}${rest}s`
}

/**
 * Percentages are clamped here rather than in the engine.
 *
 * The engine reports honest numbers: a total that is only a lower bound, and
 * bytes written that can briefly exceed it if a listing was stale. Deciding what
 * to show for that is a presentation question, so it belongs in the view.
 */
const percentOf = (progress: DownloadProgress): number => {
  if (progress.bytesTotal <= 0) {
    return 0
  }
  const raw = (progress.bytesWritten / progress.bytesTotal) * 100
  return Math.max(0, Math.min(100, Math.round(raw)))
}

const statusOf = (
  report: DownloadReport | null,
): 'active' | 'success' | 'exception' | 'normal' => {
  if (report === null) {
    return 'active'
  }
  if (report.outcome === 'completed') {
    return 'success'
  }
  if (report.outcome === 'cancelled') {
    return 'normal'
  }
  return 'exception'
}

const summarize = (report: DownloadReport): string => {
  const parts = [`${report.filesWritten} file(s) saved`]
  if (report.filesSkipped > 0) {
    parts.push(`${report.filesSkipped} already present`)
  }
  if (report.filesFailed > 0) {
    parts.push(`${report.filesFailed} failed`)
  }
  return `${parts.join(', ')} — ${formatBytes(report.bytesWritten)}`
}

interface DownloadProgressPanelProps {
  job: DownloadJob
  destinationLabel: string
  onDone?: (report: DownloadReport) => void
}

const DownloadProgressPanel = ({
  job,
  destinationLabel,
  onDone,
}: DownloadProgressPanelProps): JSX.Element => {
  const [progress, setProgress] = useState<DownloadProgress>(job.progress)
  const [report, setReport] = useState<DownloadReport | null>(null)

  useEffect(() => {
    const unsubscribe = job.subscribe(setProgress)
    let active = true
    // `done` never rejects, so there is no failure branch to handle here.
    void job.done.then((result) => {
      if (active) {
        setReport(result)
        onDone?.(result)
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [job, onDone])

  const percent = percentOf(progress)
  const running = report === null

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="small">
      <Progress percent={percent} status={statusOf(report)} />

      <Text type="secondary">
        {running
          ? `${progress.filesCompleted + progress.filesSkipped} of ${
              progress.filesTotal
            } files · ${formatBytes(progress.bytesWritten)} of ${
              progress.bytesAreExact ? '' : 'at least '
            }${formatBytes(progress.bytesTotal)}`
          : summarize(report)}
      </Text>

      {running && progress.bytesPerSecond > 0 ? (
        <Text type="secondary">
          {formatBytes(progress.bytesPerSecond)}/s
          {progress.etaSeconds !== null
            ? ` · about ${formatDuration(progress.etaSeconds)} remaining`
            : ''}
        </Text>
      ) : null}

      <Text type="secondary">Saving to “{destinationLabel}”</Text>

      {running ? (
        <>
          <Alert
            type="info"
            showIcon
            message="Keep this tab open"
            description="A transfer cannot resume after a reload. Re-running a download does skip files that already arrived."
          />
          <Button
            danger
            onClick={() => {
              job.cancel('user cancelled')
            }}
          >
            Cancel download
          </Button>
        </>
      ) : null}

      {report !== null && report.failures.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`${report.failures.length} file(s) did not download`}
          description={
            // Naming the files matters: without it the user knows only that
            // "something" failed, and cannot tell what they are missing.
            <div style={{ maxHeight: '8rem', overflow: 'auto' }}>
              {report.failures.slice(0, 20).map((failure) => (
                <div key={failure.url}>
                  <Text code>
                    {failure.segments[failure.segments.length - 1]}
                  </Text>{' '}
                  <Text type="secondary">{failure.message}</Text>
                </div>
              ))}
              {report.failures.length > 20 ? (
                <Text type="secondary">
                  …and {report.failures.length - 20} more
                </Text>
              ) : null}
            </div>
          }
        />
      ) : null}

      {report !== null && report.outcome === 'failed' ? (
        <Alert
          type="error"
          showIcon
          message="The download stopped early"
          description="This usually means the disk is full or permission to the folder was withdrawn. Free some space or pick another folder, then try again — files that already arrived will be skipped."
        />
      ) : null}
    </Space>
  )
}

export default DownloadProgressPanel
