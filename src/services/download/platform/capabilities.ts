/**
 * Browser capability detection.
 *
 * Returns *every* failing check rather than the first, because the user-facing
 * copy differs per reason and collapsing them all to "your browser is not
 * supported" hides the ones a user could actually act on — serving over HTTPS,
 * or opening the viewer outside an embedded frame.
 *
 * The ordered logic is separated from reading the real `window` so it is fully
 * unit-testable: `probeCapabilities` takes an injectable `CapabilityEnv`, and
 * only the small `readEnvironment` function touches globals.
 */

import type { Capabilities, CapabilityEnv, CapabilityReason } from '../types'

const detectOs = (
  platform: string,
  userAgent: string,
): Capabilities['platform']['os'] => {
  const haystack = `${platform} ${userAgent}`.toLowerCase()
  if (haystack.indexOf('win') !== -1) {
    return 'windows'
  }
  if (
    haystack.indexOf('mac') !== -1 ||
    haystack.indexOf('iphone') !== -1 ||
    haystack.indexOf('ipad') !== -1
  ) {
    return 'macos'
  }
  if (haystack.indexOf('linux') !== -1 || haystack.indexOf('android') !== -1) {
    return 'linux'
  }
  if (haystack === ' ') {
    return 'unknown'
  }
  return 'other'
}

const detectMobile = (userAgent: string, maxTouchPoints: number): boolean => {
  const ua = userAgent.toLowerCase()
  const looksMobile =
    ua.indexOf('android') !== -1 ||
    ua.indexOf('iphone') !== -1 ||
    ua.indexOf('ipad') !== -1 ||
    ua.indexOf('mobile') !== -1
  return looksMobile && maxTouchPoints > 0
}

export const probeCapabilities = (env: CapabilityEnv): Capabilities => {
  const reasons: CapabilityReason[] = []

  if (!env.hasWindow) {
    // Server-side rendering or a non-DOM host. Nothing else is meaningful.
    return {
      directDownload: 'unsupported',
      reasons: ['no-dom'],
      platform: { os: 'unknown', mobile: false },
      needsPathLengthProbe: false,
    }
  }

  if (!env.isSecureContext) {
    // The File System Access API is secure-context only, so a viewer served
    // over plain HTTP on a LAN address cannot use it however capable the browser.
    reasons.push('insecure-context')
  }

  if (!env.hasDirectoryPicker) {
    reasons.push('no-file-system-access')
  }

  if (!env.isTopFrame) {
    // A cross-origin subframe cannot open a file picker: the call throws
    // SecurityError. Detecting it here turns a mystery exception into copy that
    // tells the user to open the viewer directly.
    reasons.push('cross-origin-frame')
  }

  const mobile = detectMobile(env.userAgent, env.maxTouchPoints)
  if (mobile) {
    // Advisory, not disqualifying: a capable mobile browser may still work, and
    // the plan surfaces this as a warning rather than a blocker.
    reasons.push('mobile')
  }

  const os = detectOs(env.platform, env.userAgent)
  const blocking = reasons.filter((reason) => reason !== 'mobile')

  return {
    directDownload: blocking.length === 0 ? 'supported' : 'unsupported',
    reasons,
    platform: { os, mobile },
    needsPathLengthProbe: os === 'windows',
  }
}

/**
 * Reads the real environment. The only function here that touches globals, and
 * deliberately branch-free so there is nothing in it worth unit-testing.
 */
export const readEnvironment = (): CapabilityEnv => {
  if (typeof window === 'undefined') {
    return {
      hasWindow: false,
      isSecureContext: false,
      hasDirectoryPicker: false,
      isTopFrame: false,
      platform: '',
      maxTouchPoints: 0,
      userAgent: '',
    }
  }

  const globalWindow = window as unknown as Record<string, unknown>
  let isTopFrame = true
  try {
    isTopFrame = window.top === window.self
  } catch {
    // Reading window.top across origins throws, which itself proves the frame
    // is cross-origin.
    isTopFrame = false
  }

  return {
    hasWindow: true,
    isSecureContext: window.isSecureContext === true,
    hasDirectoryPicker: typeof globalWindow.showDirectoryPicker === 'function',
    isTopFrame,
    platform: navigator.platform ?? '',
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    userAgent: navigator.userAgent ?? '',
  }
}

/** Convenience for hosts that just want the answer for the current browser. */
export const detectCapabilities = (): Capabilities =>
  probeCapabilities(readEnvironment())
