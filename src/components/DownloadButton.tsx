import { CloudDownloadOutlined } from '@ant-design/icons'
import { Modal } from 'antd'
import { useCallback, useEffect } from 'react'

import type AppConfig from '../AppConfig'
import { useDownloadContext } from '../contexts/DownloadContext'
import {
  getDownloadCapabilities,
  getDownloadService,
} from '../services/downloadService'
import Button from './Button'
import DownloadStudySeriesDialog from './DownloadStudySeriesDialog'

interface DownloadButtonProps {
  appConfig: AppConfig
  studyInstanceUID: string
  seriesInstanceUID: string
}

/**
 * Opens the download dialog.
 *
 * A function component rather than markup inside `Header` so it can read the
 * download context, which is where `SlideViewer` publishes the series belonging
 * to the slide in view. Same indirection as `SettingsButton`.
 */
const DownloadButton = ({
  appConfig,
  studyInstanceUID,
  seriesInstanceUID,
}: DownloadButtonProps): JSX.Element => {
  const context = useDownloadContext()
  const service = getDownloadService(appConfig)
  const capabilities = getDownloadCapabilities()
  const activeJob = service?.activeJob ?? null

  /**
   * Warns before a reload discards a running transfer.
   *
   * File System Access handles do not survive a page load, so there is no way to
   * resume — only to re-run, which skips whatever already arrived.
   */
  useEffect(() => {
    if (activeJob === null) {
      return undefined
    }
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [activeJob])

  const onClick = useCallback((): void => {
    Modal.info({
      title: 'Download study or series',
      width: 820,
      content: (
        <DownloadStudySeriesDialog
          appConfig={appConfig}
          studyInstanceUID={studyInstanceUID}
          seriesInstanceUID={seriesInstanceUID}
          slide={context?.slide ?? null}
          service={service}
          capabilities={capabilities}
        />
      ),
      // The dialog owns a running transfer's progress view, so closing it must
      // not tear the transfer down — the service outlives the React tree.
      okText: 'Close',
      onOk(): void {},
    })
  }, [
    appConfig,
    capabilities,
    context?.slide,
    seriesInstanceUID,
    service,
    studyInstanceUID,
  ])

  return (
    <Button
      icon={CloudDownloadOutlined}
      tooltip="Download Study/Series"
      onClick={onClick}
    />
  )
}

export default DownloadButton
