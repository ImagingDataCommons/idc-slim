/**
 * On-disk path construction. Pure.
 *
 * The nested layout deliberately matches the `idc download` CLI's default
 * directory template
 * (`%collection_id/%PatientID/%StudyInstanceUID/%Modality_%SeriesInstanceUID`)
 * so a browser download and a CLI download of the same series produce
 * interchangeable trees.
 *
 * That layout is also why the path-length probe exists: two ~64-character DICOM
 * UIDs plus a 36-character UUID filename is roughly 200 characters before the
 * user's chosen root, and the File System Access API never exposes that root's
 * absolute path — `handle.name` is the leaf only. So Windows' 260-character
 * limit cannot be computed, only probed. `projectLongestPathLength` supplies the
 * number the probe needs.
 */

import type { LayoutKind, PathFacets } from '../types'

/**
 * Characters that may not appear in a path component on Windows, plus both path
 * separators. Expressed as a set of code points rather than a regular
 * expression: the class would otherwise need escaped backslashes and a control
 * range, which is easy to get subtly wrong and hard to review.
 *
 * Spaces and hyphens are absent on purpose. They are legal on every target
 * platform, patient and collection identifiers contain them (`TCGA-A1-A0SB`),
 * and rewriting them would defeat the goal of matching the CLI's tree.
 */
const ILLEGAL_CHARACTERS = '<>:"|?*/'

const isIllegal = (character: string): boolean => {
  if (ILLEGAL_CHARACTERS.indexOf(character) !== -1) {
    return true
  }
  if (character === String.fromCharCode(92)) {
    // Backslash, the Windows separator.
    return true
  }
  // C0 controls and DEL are illegal in filenames on every target platform.
  const code = character.charCodeAt(0)
  return code < 32 || code === 127
}

const replaceIllegal = (raw: string): string => {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const character = raw.charAt(i)
    out += isIllegal(character) ? '_' : character
  }
  return out
}

/**
 * Names Windows reserves regardless of extension. A file called `CON.dcm` is
 * unopenable there, and archive identifiers are arbitrary strings.
 */
const RESERVED_NAMES = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]

/** Strips trailing dots and spaces, which Windows silently drops. */
const stripTrailingDotsAndSpaces = (value: string): string => {
  let end = value.length
  while (end > 0) {
    const character = value.charAt(end - 1)
    if (character !== '.' && character !== ' ') {
      break
    }
    end -= 1
  }
  return value.slice(0, end)
}

/**
 * Makes one path component safe on Windows, macOS and Linux.
 *
 * The trailing-dot rule matters for correctness, not tidiness: Windows drops
 * them, so two identifiers differing only in a trailing dot would collapse to
 * one filename and silently overwrite each other.
 */
export const sanitizeSegment = (raw: string, fallback = '_'): string => {
  const value = stripTrailingDotsAndSpaces(replaceIllegal(raw))
  if (value === '' || value === '.' || value === '..') {
    return fallback
  }
  const stem = value.split('.')[0].toUpperCase()
  if (RESERVED_NAMES.indexOf(stem) !== -1) {
    return `_${value}`
  }
  return value
}

const orFallback = (value: string | undefined, fallback: string): string =>
  value !== undefined && value.trim() !== '' ? value : fallback

/**
 * Directory segments for a series, excluding the filename.
 *
 * The flat layout returns a single collection-level directory; a manifest CSV
 * maps the opaque UUID filenames back to identifiers, which is what makes it a
 * usable fallback rather than an unlabelled bag of files.
 */
export const seriesDirectorySegments = (
  facets: PathFacets,
  layout: LayoutKind,
): string[] => {
  const collection = sanitizeSegment(orFallback(facets.collection, 'unknown'))
  if (layout === 'flat') {
    return [collection]
  }
  const patient = sanitizeSegment(orFallback(facets.patientId, 'unknown'))
  const study = sanitizeSegment(facets.studyInstanceUID)
  const modality = orFallback(facets.modality, 'NA')
  const series = sanitizeSegment(`${modality}_${facets.seriesInstanceUID}`)
  return [collection, patient, study, series]
}

/** Full relative path for one object, including the filename. */
export const fileSegments = (
  facets: PathFacets,
  layout: LayoutKind,
  fileName: string,
): string[] => [
  ...seriesDirectorySegments(facets, layout),
  sanitizeSegment(fileName),
]

/** Filename from an object key, i.e. the part after the last separator. */
export const fileNameFromKey = (key: string): string => {
  const parts = key.split('/')
  return parts[parts.length - 1]
}

export const joinSegments = (segments: readonly string[]): string =>
  segments.join('/')

/**
 * Longest relative path this plan would create, in characters.
 *
 * Computed across every entry rather than inferred from one, because patient and
 * collection identifiers vary in length within a single study, and the probe
 * needs the worst case.
 */
export const projectLongestPathLength = (
  entries: readonly { facets: PathFacets; fileName: string }[],
  layout: LayoutKind,
): number => {
  let longest = 0
  for (const entry of entries) {
    const length = joinSegments(
      fileSegments(entry.facets, layout, entry.fileName),
    ).length
    if (length > longest) {
      longest = length
    }
  }
  return longest
}

/** Header row for the flat-layout manifest. */
export const MANIFEST_HEADER =
  'File Name,Collection ID,Patient ID,Study Instance UID,Series Instance UID,Modality\n'

const needsQuoting = (value: string): boolean =>
  value.indexOf('"') !== -1 ||
  value.indexOf(',') !== -1 ||
  value.indexOf('\n') !== -1 ||
  value.indexOf('\r') !== -1

const escapeCsv = (value: string): string =>
  needsQuoting(value) ? `"${value.split('"').join('""')}"` : value

export const manifestRow = (fileName: string, facets: PathFacets): string =>
  `${[
    fileName,
    orFallback(facets.collection, ''),
    orFallback(facets.patientId, ''),
    facets.studyInstanceUID,
    facets.seriesInstanceUID,
    orFallback(facets.modality, ''),
  ]
    .map(escapeCsv)
    .join(',')}\n`
