import {
  fileNameFromKey,
  fileSegments,
  joinSegments,
  manifestRow,
  projectLongestPathLength,
  sanitizeSegment,
  seriesDirectorySegments,
} from '../core/layout'
import type { PathFacets } from '../types'

const facets: PathFacets = {
  collection: 'ccdi_mci',
  patientId: 'PBCFZC',
  studyInstanceUID: '2.25.142706219041623035237066035829917608689',
  seriesInstanceUID: '1.3.6.1.4.1.5962.99.1.3120421285.85402270.1738287241637.4.0',
  modality: 'SM',
}

describe('sanitizeSegment', () => {
  it('preserves characters that are legal on all targets', () => {
    // Hyphens and spaces must survive: real patient identifiers contain them,
    // and rewriting them would diverge from the idc download CLI's tree.
    expect(sanitizeSegment('TCGA-A1-A0SB')).toBe('TCGA-A1-A0SB')
    expect(sanitizeSegment('Study 1')).toBe('Study 1')
    expect(sanitizeSegment('tcga_luad')).toBe('tcga_luad')
    expect(sanitizeSegment('1.3.6.1.4.1')).toBe('1.3.6.1.4.1')
  })

  it('replaces characters Windows rejects', () => {
    expect(sanitizeSegment('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h')
    expect(sanitizeSegment('a/b')).toBe('a_b')
    expect(sanitizeSegment(`a${String.fromCharCode(92)}b`)).toBe('a_b')
  })

  it('replaces control characters', () => {
    expect(sanitizeSegment(`a${String.fromCharCode(0)}b`)).toBe('a_b')
    expect(sanitizeSegment(`a${String.fromCharCode(31)}b`)).toBe('a_b')
    expect(sanitizeSegment(`a${String.fromCharCode(127)}b`)).toBe('a_b')
  })

  it('strips trailing dots and spaces, which Windows silently drops', () => {
    // Without this, two identifiers differing only by a trailing dot would
    // collapse to one filename and overwrite each other.
    expect(sanitizeSegment('name.')).toBe('name')
    expect(sanitizeSegment('name ')).toBe('name')
    expect(sanitizeSegment('name. . ')).toBe('name')
  })

  it('escapes reserved device names regardless of extension', () => {
    expect(sanitizeSegment('CON')).toBe('_CON')
    expect(sanitizeSegment('con.dcm')).toBe('_con.dcm')
    expect(sanitizeSegment('NUL')).toBe('_NUL')
    expect(sanitizeSegment('COM9.dcm')).toBe('_COM9.dcm')
    // Not reserved: only the exact names are.
    expect(sanitizeSegment('CONSOLE')).toBe('CONSOLE')
    expect(sanitizeSegment('COM10')).toBe('COM10')
  })

  it('falls back when nothing usable survives', () => {
    expect(sanitizeSegment('')).toBe('_')
    expect(sanitizeSegment('.')).toBe('_')
    expect(sanitizeSegment('..')).toBe('_')
    expect(sanitizeSegment('...', 'x')).toBe('x')
  })
})

describe('seriesDirectorySegments', () => {
  it('matches the idc download CLI default template when nested', () => {
    expect(seriesDirectorySegments(facets, 'nested')).toEqual([
      'ccdi_mci',
      'PBCFZC',
      '2.25.142706219041623035237066035829917608689',
      'SM_1.3.6.1.4.1.5962.99.1.3120421285.85402270.1738287241637.4.0',
    ])
  })

  it('collapses to the collection directory when flat', () => {
    expect(seriesDirectorySegments(facets, 'flat')).toEqual(['ccdi_mci'])
  })

  it('substitutes placeholders for absent facets', () => {
    const sparse: PathFacets = {
      studyInstanceUID: '1.2.3',
      seriesInstanceUID: '4.5.6',
    }
    expect(seriesDirectorySegments(sparse, 'nested')).toEqual([
      'unknown',
      'unknown',
      '1.2.3',
      'NA_4.5.6',
    ])
  })

  it('treats a blank facet as absent rather than emitting an empty segment', () => {
    const blank: PathFacets = { ...facets, patientId: '   ' }
    expect(seriesDirectorySegments(blank, 'nested')[1]).toBe('unknown')
  })
})

describe('fileNameFromKey', () => {
  it('takes the last path element', () => {
    expect(
      fileNameFromKey(
        '129578c4-7a00-4b4d-804f-f58228123df8/13b0d6c7-34c5-445e-a368-eb90b6f8d174.dcm',
      ),
    ).toBe('13b0d6c7-34c5-445e-a368-eb90b6f8d174.dcm')
  })

  it('handles a key with no separator', () => {
    expect(fileNameFromKey('a.dcm')).toBe('a.dcm')
  })
})

describe('projectLongestPathLength', () => {
  it('reports the worst case across entries, not the first', () => {
    const entries = [
      { facets, fileName: 'a.dcm' },
      {
        facets: { ...facets, patientId: 'A-MUCH-LONGER-PATIENT-IDENTIFIER' },
        fileName: '13b0d6c7-34c5-445e-a368-eb90b6f8d174.dcm',
      },
    ]
    const longest = projectLongestPathLength(entries, 'nested')
    const second = joinSegments(
      fileSegments(entries[1].facets, 'nested', entries[1].fileName),
    ).length
    expect(longest).toBe(second)
  })

  it('is much shorter under the flat layout', () => {
    const entries = [{ facets, fileName: 'uuid.dcm' }]
    expect(projectLongestPathLength(entries, 'flat')).toBeLessThan(
      projectLongestPathLength(entries, 'nested'),
    )
  })

  it('exceeds the Windows probe threshold for a realistic IDC series', () => {
    // This is the reason the probe exists at all: a real nested path is already
    // ~180+ characters before the user's chosen root, which FSA never exposes.
    const entries = [
      { facets, fileName: '13b0d6c7-34c5-445e-a368-eb90b6f8d174.dcm' },
    ]
    expect(projectLongestPathLength(entries, 'nested')).toBeGreaterThan(150)
  })

  it('returns zero for no entries', () => {
    expect(projectLongestPathLength([], 'nested')).toBe(0)
  })
})

describe('manifestRow', () => {
  it('emits identifiers in header order', () => {
    expect(manifestRow('uuid.dcm', facets)).toBe(
      'uuid.dcm,ccdi_mci,PBCFZC,' +
        '2.25.142706219041623035237066035829917608689,' +
        '1.3.6.1.4.1.5962.99.1.3120421285.85402270.1738287241637.4.0,SM\n',
    )
  })

  it('leaves absent facets empty rather than writing "undefined"', () => {
    const row = manifestRow('uuid.dcm', {
      studyInstanceUID: '1.2',
      seriesInstanceUID: '3.4',
    })
    expect(row).toBe('uuid.dcm,,,1.2,3.4,\n')
  })

  it('quotes and escapes values containing separators', () => {
    const row = manifestRow('uuid.dcm', {
      ...facets,
      collection: 'a,b',
      patientId: 'say "hi"',
    })
    expect(row).toContain('"a,b"')
    expect(row).toContain('"say ""hi"""')
  })
})
