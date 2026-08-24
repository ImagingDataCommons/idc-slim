import { probeCapabilities } from '../platform/capabilities'
import type { CapabilityEnv } from '../types'

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const FIREFOX_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Mobile Safari/537.36'

const env = (overrides: Partial<CapabilityEnv> = {}): CapabilityEnv => ({
  hasWindow: true,
  isSecureContext: true,
  hasDirectoryPicker: true,
  isTopFrame: true,
  platform: 'MacIntel',
  maxTouchPoints: 0,
  userAgent: CHROME_MAC,
  ...overrides,
})

describe('probeCapabilities', () => {
  it('supports a capable desktop browser', () => {
    const result = probeCapabilities(env())
    expect(result.directDownload).toBe('supported')
    expect(result.reasons).toEqual([])
    expect(result.platform).toEqual({ os: 'macos', mobile: false })
    expect(result.needsPathLengthProbe).toBe(false)
  })

  it('short-circuits with no DOM', () => {
    const result = probeCapabilities(env({ hasWindow: false }))
    expect(result.reasons).toEqual(['no-dom'])
    expect(result.directDownload).toBe('unsupported')
  })

  it('rejects an insecure context', () => {
    // FSA is secure-context only, so plain HTTP on a LAN address cannot work
    // however capable the browser is.
    const result = probeCapabilities(env({ isSecureContext: false }))
    expect(result.reasons).toEqual(['insecure-context'])
    expect(result.directDownload).toBe('unsupported')
  })

  it('rejects a browser with no File System Access API', () => {
    const result = probeCapabilities(
      env({ hasDirectoryPicker: false, userAgent: FIREFOX_LINUX, platform: 'Linux x86_64' }),
    )
    expect(result.reasons).toEqual(['no-file-system-access'])
    expect(result.platform.os).toBe('linux')
  })

  it('rejects a cross-origin frame', () => {
    // The picker throws SecurityError in a cross-origin subframe. Detecting it
    // turns a mystery exception into copy the user can act on.
    const result = probeCapabilities(env({ isTopFrame: false }))
    expect(result.reasons).toEqual(['cross-origin-frame'])
    expect(result.directDownload).toBe('unsupported')
  })

  it('reports every failing reason, not just the first', () => {
    const result = probeCapabilities(
      env({
        isSecureContext: false,
        hasDirectoryPicker: false,
        isTopFrame: false,
      }),
    )
    expect(result.reasons).toEqual([
      'insecure-context',
      'no-file-system-access',
      'cross-origin-frame',
    ])
  })

  it('treats mobile as advisory rather than disqualifying', () => {
    const result = probeCapabilities(
      env({
        userAgent: CHROME_ANDROID,
        platform: 'Linux armv8l',
        maxTouchPoints: 5,
      }),
    )
    expect(result.platform.mobile).toBe(true)
    expect(result.reasons).toEqual(['mobile'])
    // Still supported: the plan surfaces this as a warning, not a blocker.
    expect(result.directDownload).toBe('supported')
  })

  it('does not call a touchscreen laptop mobile', () => {
    const result = probeCapabilities(env({ maxTouchPoints: 10 }))
    expect(result.platform.mobile).toBe(false)
    expect(result.reasons).toEqual([])
  })

  it('asks for a path-length probe only on Windows', () => {
    expect(
      probeCapabilities(
        env({ platform: 'Win32', userAgent: CHROME_WINDOWS }),
      ).needsPathLengthProbe,
    ).toBe(true)
    expect(probeCapabilities(env()).needsPathLengthProbe).toBe(false)
  })

  it('combines mobile with a blocking reason correctly', () => {
    const result = probeCapabilities(
      env({
        hasDirectoryPicker: false,
        userAgent: CHROME_ANDROID,
        maxTouchPoints: 5,
        platform: 'Linux armv8l',
      }),
    )
    expect(result.directDownload).toBe('unsupported')
    expect(result.reasons).toEqual(['no-file-system-access', 'mobile'])
  })
})
