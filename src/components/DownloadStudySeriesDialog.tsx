import { PaperClipOutlined } from '@ant-design/icons'
import { useCallback, useState } from 'react'
import type AppConfig from '../AppConfig'
import type { DownloadStudyDialogSettings } from '../AppConfig'

/**
 * If there's a downloadStudyDialogSettings in the appConfig object then it will return it, otherwise it will return the default settings
 * @param appConfig the object with all app config
 * @returns the downloadStudyDialogSettings config object
 */
const getConfig = (appConfig: AppConfig): DownloadStudyDialogSettings => {
  if (appConfig.downloadStudyDialog != null) {
    return appConfig.downloadStudyDialog
  }

  const defaultConfig = {
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

  return defaultConfig
}

const DialogInstruction = ({
  instruction,
}: {
  instruction: { command: string; label: string }
}): JSX.Element => {
  const [message, setMessage] = useState('')
  const { command, label } = instruction

  const resetState = useCallback((): void => {
    setMessage('')
  }, [])

  const copyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command)
      setMessage('Copied')
    } catch (err) {
      console.error('Failed to copy: ', err)
      setMessage('Failed')
    } finally {
      setTimeout((): void => {
        resetState()
      }, 500)
    }
  }, [command, resetState])

  return (
    <div>
      {typeof label === 'string' ? <section>{label}</section> : null}
      <section
        style={{
          margin: '1rem 0',
          padding: '0.25rem 0.5rem',
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'space-between',
          backgroundColor: '#EFFBFE',
          alignItems: 'center',
        }}
      >
        {command}
        <div
          style={{
            position: 'relative',
            display: 'flex',
            height: '2rem',
            alignItems: 'center',
          }}
        >
          {message !== '' ? (
            message
          ) : (
            <button
              type="button"
              style={{
                cursor: 'pointer',
                background: 'none',
                border: 'none',
                padding: 0,
              }}
              onClick={copyToClipboard}
            >
              <PaperClipOutlined />
            </button>
          )}
        </div>
      </section>
    </div>
  )
}

/**
 * Gets the studyInstanceUID and seriesInstanceUID params from the URL using the location object
 * based on the position of the /series and /studies strings
 * @returns an object with the studyInstanceUID and seriesInstanceUID from the URL
 */
const getStudyAndSeriesInfo = (): {
  studyInstanceUID: string
  seriesInstanceUID: string
} => {
  const urlParams = window.location.pathname.split('/')
  const studiesIndex = urlParams.indexOf('studies')
  const seriesIndex = urlParams.indexOf('series')
  const studyInstanceUID = urlParams[studiesIndex + 1]
  const seriesInstanceUID = urlParams[seriesIndex + 1]

  return { studyInstanceUID, seriesInstanceUID }
}

const DownloadStudySeriesDialog = ({
  appConfig,
}: {
  appConfig: AppConfig
}): JSX.Element => {
  const { studyInstanceUID, seriesInstanceUID } = getStudyAndSeriesInfo()
  const config = getConfig(appConfig)

  const replaceVariables = useCallback(
    (text: string): string =>
      text
        .replace(/\{\{StudyInstanceUID\}\}/g, studyInstanceUID)
        .replace(/\{\{SeriesInstanceUID\}\}/g, seriesInstanceUID),
    [studyInstanceUID, seriesInstanceUID],
  )

  const instructions = config.instructions.map((instruction) => {
    const { command, label } = instruction
    return {
      command: replaceVariables(command),
      label: replaceVariables(label),
    }
  })

  return (
    <div style={{ width: '850px' }}>
      <h1>{config.description}</h1>
      <div
        style={{ marginTop: '0.5rem', padding: '0.5rem' }}
        className="mt-2 p-2"
      >
        {instructions.map((instruction) => (
          <DialogInstruction
            instruction={instruction}
            key={instruction.command}
          />
        ))}
      </div>
    </div>
  )
}

export default DownloadStudySeriesDialog
