import React from 'react'
import * as dmv from 'dicom-microscopy-viewer'
import * as dwc from 'dicomweb-client'
import { Menu } from 'antd'

import SeriesItem from './SeriesItem'

interface SeriesListProps {
  metadata: dmv.metadata.Series[]
  client: dwc.api.DICOMwebClient
  onSeriesSelection: (
    { seriesInstanceUID }: { seriesInstanceUID: string }
  ) => void
}

interface SeriesListState {
  selectedSeriesInstanceUID: string
}

class SeriesList extends React.Component<SeriesListProps, SeriesListState> {
  constructor (props: SeriesListProps) {
    super(props)
    this.state = {
      selectedSeriesInstanceUID: this.props.metadata[0].SeriesInstanceUID
    }
  }

  componentDidMount (): void {
    this.props.onSeriesSelection({
      seriesInstanceUID: this.state.selectedSeriesInstanceUID
    })
  }

  render (): React.ReactNode {
    const items = this.props.metadata.map((series, index: number) => {
      return (
        <SeriesItem
          key={series.SeriesInstanceUID}
          metadata={series}
          client={this.props.client}
        />
      )
    })

    const handleMenuItemSelection = (
      object: any
    ): void => {
      this.setState(state => ({
        selectedSeriesInstanceUID: object.key
      }))
      this.props.onSeriesSelection({ seriesInstanceUID: object.key })
    }

    return (
      <Menu
        style={{ width: '100%' }}
        selectedKeys={[this.state.selectedSeriesInstanceUID]}
        onSelect={handleMenuItemSelection}
        onClick={handleMenuItemSelection}
        mode='inline'
        inlineIndent={0}
      >
        {items}
      </Menu>
    )
  }
}

export default SeriesList
