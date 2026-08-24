import React, { useCallback, useRef, useState } from 'react'

/**
 * Carries the active slide's series up to the Header's download button.
 *
 * The button lives in the Header but the only thing that knows which series
 * belong to the slide in view is `SlideViewer` — a slide spans its VOLUME,
 * LABEL and OVERVIEW series, which cannot be derived from the route. This
 * mirrors `SettingsContext`, the established pattern in this codebase for
 * exactly that shape of problem.
 *
 * The study tier needs no context: its identifier is already in the route.
 */
export interface SlideDownloadContext {
  /** Every series belonging to the slide currently displayed. */
  seriesInstanceUIDs: string[]
  /** Shown in the dialog so the user can tell which slide is being offered. */
  label?: string
}

export interface DownloadContextValue {
  /** The active slide, or null when no slide is open. */
  slide: SlideDownloadContext | null
  registerSlide: (slide: SlideDownloadContext | null) => void
}

const DownloadContext = React.createContext<DownloadContextValue | null>(null)

export const useDownloadContext = (): DownloadContextValue | null =>
  React.useContext(DownloadContext)

interface DownloadProviderProps {
  children: React.ReactNode
}

export const DownloadProvider: React.FC<DownloadProviderProps> = ({
  children,
}) => {
  const [slide, setSlide] = useState<SlideDownloadContext | null>(null)

  const registerSlide = useCallback(
    (next: SlideDownloadContext | null): void => {
      setSlide((current) => {
        // Compare by content: SlideViewer re-renders often, and a new array
        // with the same UIDs must not cause a state update and another render.
        if (current === null && next === null) {
          return current
        }
        if (
          current !== null &&
          next !== null &&
          current.label === next.label &&
          current.seriesInstanceUIDs.length ===
            next.seriesInstanceUIDs.length &&
          current.seriesInstanceUIDs.every(
            (uid, index) => uid === next.seriesInstanceUIDs[index],
          )
        ) {
          return current
        }
        return next
      })
    },
    [],
  )

  return (
    <DownloadContext.Provider value={{ slide, registerSlide }}>
      {children}
    </DownloadContext.Provider>
  )
}

interface DownloadRegistrationProps {
  seriesInstanceUIDs: string[]
  label?: string
}

/**
 * Registers the active slide while mounted and clears it on unmount, so the
 * dialog never offers a slide the user has navigated away from.
 */
export const DownloadRegistration: React.FC<DownloadRegistrationProps> = ({
  seriesInstanceUIDs,
  label,
}) => {
  const context = useDownloadContext()
  const registerRef = useRef(context?.registerSlide)
  registerRef.current = context?.registerSlide

  // Join rather than pass the array: a fresh array with identical contents would
  // re-run this effect on every render of the viewer.
  const key = seriesInstanceUIDs.join('|')

  React.useEffect(() => {
    const register = registerRef.current
    if (register === undefined) {
      return undefined
    }
    register({ seriesInstanceUIDs: key === '' ? [] : key.split('|'), label })
    return () => {
      registerRef.current?.(null)
    }
  }, [key, label])

  return null
}
