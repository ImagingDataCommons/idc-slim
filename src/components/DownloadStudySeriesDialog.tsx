import { CopyOutlined } from '@ant-design/icons'
import { Alert, Button, Divider, Space, Spin, Tooltip, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type AppConfig from '../AppConfig'
import type { DownloadStudyDialogSettings } from '../AppConfig'
import type { SlideDownloadContext } from '../contexts/DownloadContext'
import {
  type Capabilities,
  type DirectorySink,
  type DownloadJob,
  type DownloadService,
  formatBytes,
  type PrepareResult,
  pickDestination,
  type SeriesSelector,
  verifyDestination,
} from '../services/download'
import { logger } from '../utils/logger'
import DownloadProgressPanel from './DownloadProgressPanel'

const { Text, Title, Paragraph } = Typography

/**
 * Deployment-supplied instructions, or the built-in defaults.
 *
 * Unchanged from the original implementation on purpose: deployments may already
 * be overriding `downloadStudyDialog`, and that must keep working exactly as it
 * did when the direct option was added above it.
 */
const getConfig = (appConfig: AppConfig): DownloadStudyDialogSettings => {
  if (appConfig.downloadStudyDialog != null) {
    return appConfig.downloadStudyDialog
  }

  return {
    description:
      'Follow the instructions below to download the study or series:',
    instructions: [
      {
        command: 'pip install idc-index --upgrade',
        label: 'First, install the idc-index python package:',
      },
      {
        command: 'idc download {{StudyInstanceUID}}',
        label: 'Then, to download the whole study, run:',
      },
      {
        command: 'idc download {{SeriesInstanceUID}}',
        label: "Or, to download just the active viewport's series, run:",
      },
    ],
  }
}

const CommandBlock = ({
  command,
  label,
}: {
  command: string
  label?: string
}): JSX.Element => {
  const [message, setMessage] = useState('')
  // Held in a ref so the timeout can be cleared on unmount: the original
  // implementation left it running and set state on a gone component.
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(
    () => () => {
      if (timer.current !== undefined) {
        clearTimeout(timer.current)
      }
    },
    [],
  )

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command)
      setMessage('Copied')
    } catch (error) {
      logger.error('failed to copy command to clipboard', error)
      setMessage('Press Ctrl+C')
    } finally {
      if (timer.current !== undefined) {
        clearTimeout(timer.current)
      }
      timer.current = setTimeout(() => {
        setMessage('')
      }, 1500)
    }
  }, [command])

  return (
    <div style={{ marginBottom: '0.75rem' }}>
      {label !== undefined && label !== '' ? (
        <Text type="secondary">{label}</Text>
      ) : null}
      <div
        style={{
          marginTop: '0.25rem',
          padding: '0.4rem 0.5rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.5rem',
          // Theme tokens rather than a fixed light-mode colour: the original
          // hardcoded #EFFBFE, which is unreadable in dark mode.
          background: 'var(--slim-code-bg, rgba(127, 127, 127, 0.12))',
          borderRadius: '2px',
        }}
      >
        <Text code copyable={false} style={{ whiteSpace: 'pre-wrap' }}>
          {command}
        </Text>
        <Tooltip title={message === '' ? 'Copy' : message}>
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            onClick={() => {
              void copy()
            }}
            aria-label={`Copy command: ${command}`}
          />
        </Tooltip>
      </div>
    </div>
  )
}

/** Human-readable explanation for why direct download is unavailable. */
const unavailableReason = (capabilities: Capabilities): string => {
  const reasons = capabilities.reasons
  if (reasons.indexOf('insecure-context') !== -1) {
    return 'Saving files to a folder requires a secure (HTTPS) connection.'
  }
  if (reasons.indexOf('cross-origin-frame') !== -1) {
    return 'Saving files to a folder is not possible when the viewer is embedded in another page. Open the viewer directly to use it.'
  }
  if (reasons.indexOf('no-file-system-access') !== -1) {
    return 'Saving files to a folder is only available in Chromium-based browsers such as Chrome or Edge.'
  }
  return 'Saving files to a folder is not available in this browser.'
}

interface DirectSectionProps {
  service: DownloadService
  capabilities: Capabilities
  scopeLabel: string
  studyInstanceUID: string
  /** Empty for the study scope, which is resolved by study UID alone. */
  seriesInstanceUIDs: readonly string[]
}

/**
 * One download scope: resolve on mount, then offer a button.
 *
 * Resolution happens here, on open, rather than in the click handler — the
 * directory picker needs transient user activation, and any await before it
 * spends that activation. See the module README.
 */
const DirectSection = ({
  service,
  capabilities,
  scopeLabel,
  studyInstanceUID,
  seriesInstanceUIDs,
}: DirectSectionProps): JSX.Element => {
  const [prepared, setPrepared] = useState<PrepareResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<DownloadJob | null>(null)
  const [destination, setDestination] = useState<string>('')
  const [starting, setStarting] = useState(false)

  // Identity derived from primitives, not from an object. A selector built in
  // the parent's render is a new object every time, which as an effect
  // dependency re-resolves on every render.
  const uidsKey = seriesInstanceUIDs.join('|')

  const selector: SeriesSelector = useMemo(
    () => ({
      studyInstanceUID,
      seriesInstanceUIDs: uidsKey === '' ? [] : uidsKey.split('|'),
    }),
    [studyInstanceUID, uidsKey],
  )

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setPrepared(null)
    setError(null)

    void service
      .prepare(selector, { signal: controller.signal })
      .then((result) => {
        if (active) {
          setPrepared(result)
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          logger.error('failed to prepare download', cause)
          // A resolver failure is not fatal to the dialog: the command-line
          // instructions below remain valid and are the whole point of the
          // fallback tier.
          setError(
            'Could not look up these files in the archive. The commands below still work.',
          )
        }
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [service, selector])

  const onClick = useCallback(async () => {
    // MUST be first: any await before this consumes the user activation and the
    // picker throws.
    const picked = await pickDestination({ id: 'slim-downloads' })
    if (!picked.ok) {
      if (picked.reason === 'blocked') {
        setError(unavailableReason(capabilities))
      }
      // 'dismissed' is the user closing the dialog — not worth reporting.
      return
    }

    if (prepared === null) {
      return
    }

    setStarting(true)
    try {
      const check = await verifyDestination({
        plan: prepared.plan,
        sink: picked.sink,
        needsPathLengthProbe: capabilities.needsPathLengthProbe,
        probeId: prepared.plan.id,
      })

      let planToRun = prepared.plan
      if (!check.ok) {
        if (check.kind === 'not-writable') {
          setError(
            'That folder could not be written to. Check permissions and free space, then try again.',
          )
          return
        }
        // Windows path-length limit. The flat layout plus a manifest is the
        // documented escape hatch; ask rather than silently reorganising.
        const accepted = window.confirm(
          'The folder structure for these files is too deep for this system ' +
            '(Windows limits paths to 260 characters).\n\n' +
            'Save all files in a single folder instead, with a CSV manifest ' +
            'listing which patient, study and series each file belongs to?',
        )
        if (!accepted) {
          return
        }
        planToRun = service.relayout(prepared, check.suggestedLayout).plan
      }

      setDestination(picked.sink.label)
      setJob(service.start(planToRun, picked.sink as DirectorySink))
    } catch (cause) {
      logger.error('failed to start download', cause)
      setError('The download could not be started.')
    } finally {
      setStarting(false)
    }
  }, [capabilities, prepared, service])

  if (job !== null) {
    return <DownloadProgressPanel job={job} destinationLabel={destination} />
  }

  if (error !== null && prepared === null) {
    return <Alert type="warning" showIcon message={error} />
  }

  if (prepared === null) {
    return (
      <Space>
        <Spin size="small" />
        <Text type="secondary">Looking up {scopeLabel}…</Text>
      </Space>
    )
  }

  const { plan } = prepared
  const blocked = plan.blockers.length > 0
  const supported = capabilities.directDownload === 'supported'

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="small">
      {blocked ? (
        plan.blockers.map((issue) => (
          <Alert
            key={issue.code}
            type="info"
            showIcon
            message={issue.message}
          />
        ))
      ) : (
        <>
          {plan.warnings.map((issue) => (
            <Alert
              key={issue.code}
              type="warning"
              showIcon
              message={issue.message}
            />
          ))}

          {supported ? null : (
            <Alert
              type="info"
              showIcon
              message={unavailableReason(capabilities)}
            />
          )}

          {error !== null ? (
            <Alert type="error" showIcon message={error} />
          ) : null}

          <Button
            type="primary"
            disabled={!supported || starting}
            loading={starting}
            onClick={() => {
              void onClick()
            }}
          >
            {`Save ${scopeLabel} — ${plan.totals.files} file${
              plan.totals.files === 1 ? '' : 's'
            }, ${plan.totals.bytesAreExact ? '' : 'at least '}${formatBytes(
              plan.totals.bytes,
            )}`}
          </Button>

          {plan.licenses.length > 0 ? (
            <Text type="secondary">
              Licensed {plan.licenses.map((l) => l.name).join(', ')}. Files are
              named by their archive identifier, matching what the command-line
              tools produce.
            </Text>
          ) : null}
        </>
      )}
    </Space>
  )
}

interface DownloadStudySeriesDialogProps {
  appConfig: AppConfig
  studyInstanceUID: string
  seriesInstanceUID: string
  /** Null when no slide is open, e.g. on a study route before selection. */
  slide: SlideDownloadContext | null
  /** Null when this deployment has not enabled direct download. */
  service: DownloadService | null
  capabilities: Capabilities
}

const DownloadStudySeriesDialog = ({
  appConfig,
  studyInstanceUID,
  seriesInstanceUID,
  slide,
  service,
  capabilities,
}: DownloadStudySeriesDialogProps): JSX.Element => {
  const config = getConfig(appConfig)

  const instructions = useMemo(
    () =>
      config.instructions.map((instruction) => {
        const substitute = (text: string): string =>
          text
            .split('{{StudyInstanceUID}}')
            .join(studyInstanceUID)
            .split('{{SeriesInstanceUID}}')
            .join(seriesInstanceUID)
        return {
          command: substitute(instruction.command),
          label: substitute(instruction.label),
        }
      }),
    [config.instructions, seriesInstanceUID, studyInstanceUID],
  )

  const slideUids = slide?.seriesInstanceUIDs ?? []
  const hasSlide = slideUids.length > 0
  const hasStudy = studyInstanceUID !== ''

  return (
    <div style={{ maxWidth: '48rem' }}>
      {service !== null ? (
        <>
          <Title level={5} style={{ marginTop: 0 }}>
            Save to this computer
          </Title>
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            {hasSlide ? (
              <DirectSection
                service={service}
                capabilities={capabilities}
                scopeLabel="this slide"
                studyInstanceUID={studyInstanceUID}
                seriesInstanceUIDs={slideUids}
              />
            ) : null}
            {hasStudy ? (
              <DirectSection
                service={service}
                capabilities={capabilities}
                scopeLabel="the whole study"
                studyInstanceUID={studyInstanceUID}
                seriesInstanceUIDs={[]}
              />
            ) : null}
          </Space>
          <Divider>or</Divider>
          <Title level={5}>Download with Python</Title>
        </>
      ) : null}

      <Paragraph>{config.description}</Paragraph>
      {instructions.map((instruction) => (
        <CommandBlock
          key={instruction.command}
          command={instruction.command}
          label={instruction.label}
        />
      ))}
    </div>
  )
}

export default DownloadStudySeriesDialog
