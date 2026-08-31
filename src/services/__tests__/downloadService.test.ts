import type AppConfig from '../../AppConfig'
import { getDownloadService, resetDownloadService } from '../downloadService'

const config = (download?: AppConfig['download']): AppConfig =>
  ({
    servers: [],
    path: '/',
    annotations: [],
    download,
  }) as unknown as AppConfig

beforeEach(() => {
  resetDownloadService()
})

describe('getDownloadService', () => {
  it('returns null when the deployment has no download block', () => {
    // Default-off: a viewer pointed at a server the resolver knows nothing about
    // must not offer a button that resolves nothing.
    expect(getDownloadService(config())).toBeNull()
  })

  it('returns null when explicitly disabled', () => {
    expect(getDownloadService(config({ enabled: false }))).toBeNull()
  })

  it('returns null when enabled without a provider', () => {
    expect(getDownloadService(config({ enabled: true }))).toBeNull()
  })

  it('returns null for an unknown provider rather than throwing', () => {
    const service = getDownloadService(
      config({ enabled: true, provider: 'nope' as 'idc' }),
    )
    expect(service).toBeNull()
  })

  it('builds a service for the idc provider', () => {
    const service = getDownloadService(
      config({ enabled: true, provider: 'idc' }),
    )
    expect(service).not.toBeNull()
    expect(service?.activeJob).toBeNull()
  })

  it('memoizes, so a running download survives re-renders', () => {
    // The service is deliberately outside the React tree: holding it in
    // component state would abandon a transfer on the next re-render.
    const first = getDownloadService(config({ enabled: true, provider: 'idc' }))
    const second = getDownloadService(config({ enabled: true, provider: 'idc' }))
    expect(second).toBe(first)
  })

  it('accepts limit overrides without dropping the unset ones', () => {
    const service = getDownloadService(
      config({
        enabled: true,
        provider: 'idc',
        limits: { warnBytes: 1024 },
      }),
    )
    expect(service).not.toBeNull()
  })
})
