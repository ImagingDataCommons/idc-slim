import { render, screen } from '@testing-library/react'
// babel.config.js uses @babel/preset-react's classic runtime, so JSX in tests
// needs React in scope. Matches the convention in the existing test suites.
import React, { useState } from 'react'

import {
  DownloadProvider,
  DownloadRegistration,
  useDownloadContext,
} from '../DownloadContext'

/** Renders whatever the context currently holds, plus a render counter. */
const Probe = (): JSX.Element => {
  const context = useDownloadContext()
  return (
    <div>
      <span data-testid="uids">
        {context?.slide?.seriesInstanceUIDs.join(',') ?? 'none'}
      </span>
      <span data-testid="label">{context?.slide?.label ?? 'none'}</span>
    </div>
  )
}

describe('DownloadContext', () => {
  it('reports no slide before one is registered', () => {
    render(
      <DownloadProvider>
        <Probe />
      </DownloadProvider>,
    )
    expect(screen.getByTestId('uids').textContent).toBe('none')
  })

  it('publishes the registered slide', () => {
    render(
      <DownloadProvider>
        <DownloadRegistration
          seriesInstanceUIDs={['1.1', '1.2']}
          label="Slide A"
        />
        <Probe />
      </DownloadProvider>,
    )
    expect(screen.getByTestId('uids').textContent).toBe('1.1,1.2')
    expect(screen.getByTestId('label').textContent).toBe('Slide A')
  })

  it('clears the slide on unmount', () => {
    const Host = ({ mounted }: { mounted: boolean }): JSX.Element => (
      <DownloadProvider>
        {mounted ? (
          <DownloadRegistration seriesInstanceUIDs={['1.1']} />
        ) : null}
        <Probe />
      </DownloadProvider>
    )
    const { rerender } = render(<Host mounted />)
    expect(screen.getByTestId('uids').textContent).toBe('1.1')

    // Without this the dialog would keep offering a slide the user has left.
    rerender(<Host mounted={false} />)
    expect(screen.getByTestId('uids').textContent).toBe('none')
  })

  it('does not update state when re-registering identical UIDs', () => {
    // SlideViewer re-renders often and passes a fresh array each time. Without
    // content comparison that is a state update per render, and a loop.
    let providerRenders = 0
    const Counting = (): JSX.Element => {
      providerRenders += 1
      return <Probe />
    }
    const Host = (): JSX.Element => {
      const [, setTick] = useState(0)
      return (
        <DownloadProvider>
          <DownloadRegistration seriesInstanceUIDs={['1.1', '1.2']} />
          <Counting />
          <button
            type="button"
            onClick={() => {
              setTick((n) => n + 1)
            }}
          >
            rerender
          </button>
        </DownloadProvider>
      )
    }

    const { rerender } = render(<Host />)
    const afterFirst = providerRenders
    rerender(<Host />)
    rerender(<Host />)

    // Re-rendering the host must not keep growing the render count through
    // repeated context updates.
    expect(providerRenders - afterFirst).toBeLessThanOrEqual(2)
    expect(screen.getByTestId('uids').textContent).toBe('1.1,1.2')
  })

  it('publishes a replacement when the UIDs actually change', () => {
    const Host = ({ uids }: { uids: string[] }): JSX.Element => (
      <DownloadProvider>
        <DownloadRegistration seriesInstanceUIDs={uids} />
        <Probe />
      </DownloadProvider>
    )
    const { rerender } = render(<Host uids={['1.1']} />)
    rerender(<Host uids={['2.1', '2.2']} />)
    expect(screen.getByTestId('uids').textContent).toBe('2.1,2.2')
  })

  it('handles an empty UID list', () => {
    render(
      <DownloadProvider>
        <DownloadRegistration seriesInstanceUIDs={[]} />
        <Probe />
      </DownloadProvider>,
    )
    expect(screen.getByTestId('uids').textContent).toBe('')
  })

  it('renders nothing outside a provider rather than throwing', () => {
    // The registration is mounted by SlideViewer, which can render on routes
    // that have no provider above it.
    render(<DownloadRegistration seriesInstanceUIDs={['1.1']} />)
    expect(document.body).toBeTruthy()
  })
})
