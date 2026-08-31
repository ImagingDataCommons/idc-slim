/**
 * Enforces the extraction contract mechanically.
 *
 * The module is meant to be liftable into a standalone package with no code
 * changes, so that another viewer can consume it. That property is easy to state
 * and easy to break by accident — one convenient import of the app's logger and
 * it is gone. This test reads the module's own source and fails the build
 * instead, which is cheaper than discovering it during a migration.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

const MODULE_ROOT = join(__dirname, '..')

const listSourceFiles = (directory: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__') {
        out.push(...listSourceFiles(full))
      }
      continue
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

const sourceFiles = listSourceFiles(MODULE_ROOT)

const readImports = (source: string): string[] => {
  const specifiers: string[] = []
  const pattern = /(?:from|import)\s+['"]([^'"]+)['"]/g
  for (;;) {
    const match = pattern.exec(source)
    if (match === null) {
      break
    }
    specifiers.push(match[1])
  }
  return specifiers
}

/**
 * Strips comments before the textual rules run.
 *
 * Without this the guard flags its own subject matter: `types.ts` documents why
 * it avoids `for await`, `fsaTypes.ts` why it avoids `declare global`, and
 * `s3Xml.ts` why it avoids `DOMParser`. A rule that cannot tell an explanation
 * from a violation is worse than no rule, because the fix is to delete the
 * explanation.
 */
const stripComments = (source: string): string => {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlocks
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed.indexOf('//') !== 0 && trimmed.indexOf('*') !== 0
    })
    .join('\n')
}

/** [relative path, source] for every file, comments intact. */
const each = (): Array<[string, string]> =>
  sourceFiles.map((file) => [
    relative(MODULE_ROOT, file),
    readFileSync(file, 'utf8'),
  ])

/** [relative path, code] with comments removed. */
const eachCode = (): Array<[string, string]> =>
  each().map(([name, source]) => [name, stripComments(source)])

/** True when a relative import stays inside the module. */
const staysInsideModule = (fromFile: string, specifier: string): boolean => {
  if (specifier.charAt(0) !== '.') {
    return true
  }
  const target = resolve(join(MODULE_ROOT, fromFile), '..', specifier)
  return target === MODULE_ROOT || target.indexOf(`${MODULE_ROOT}/`) === 0
}

describe('module inventory', () => {
  it('finds the source files', () => {
    // Guards against the walker silently returning nothing, which would make
    // every assertion below vacuously pass.
    expect(sourceFiles.length).toBeGreaterThan(10)
  })

  it('exposes exactly one entry point', () => {
    expect(
      sourceFiles.some((file) => relative(MODULE_ROOT, file) === 'index.ts'),
    ).toBe(true)
  })
})

describe('extraction contract', () => {
  it('never imports from outside the module', () => {
    // A single `../../utils/logger` would tie the module to this application.
    // Checked by resolving the path, not by counting `../` segments: a nested
    // file legitimately reaches the module root that way.
    for (const [name, source] of each()) {
      for (const specifier of readImports(source)) {
        expect({
          name,
          specifier,
          insideModule: staysInsideModule(name, specifier),
        }).toMatchObject({ insideModule: true })
      }
    }
  })

  it('uses no path aliases', () => {
    // Aliases are the most common thing that breaks a lift-and-shift.
    for (const [name, source] of each()) {
      for (const specifier of readImports(source)) {
        expect({ name, specifier }).toMatchObject({
          specifier: expect.not.stringMatching(/^[@~]\//),
        })
      }
    }
  })

  it('takes no runtime dependencies', () => {
    const banned = [
      'react',
      'react-dom',
      'antd',
      '@ant-design/icons',
      'dcmjs',
      'dicom-microscopy-viewer',
      'dicomweb-client',
      'lodash',
      'ol',
      'retry',
      'uuid',
    ]
    for (const [name, source] of each()) {
      for (const specifier of readImports(source)) {
        const bare = specifier.charAt(0) !== '.'
        if (!bare) {
          continue
        }
        expect({ name, specifier }).toMatchObject({
          specifier: expect.not.stringMatching(
            new RegExp(`^(${banned.join('|')})(/|$)`),
          ),
        })
      }
    }
  })

  it('keeps the engine free of archive-specific code', () => {
    // The whole point of the resolver seam: nothing in the engine may know that
    // IDC exists.
    for (const [name, source] of each()) {
      // The barrel re-exports the resolver by design; the engine must not
      // reach for it.
      if (name.indexOf('resolvers/') === 0 || name === 'index.ts') {
        continue
      }
      for (const specifier of readImports(source)) {
        expect({ name, specifier }).toMatchObject({
          specifier: expect.not.stringContaining('resolvers/'),
        })
      }
    }
  })

  it('mentions no archive hostnames outside the resolver', () => {
    for (const [name, source] of eachCode()) {
      if (name.indexOf('resolvers/') === 0 || name === 'index.ts') {
        continue
      }
      expect({ name, source }).toMatchObject({
        source: expect.not.stringContaining('amazonaws.com'),
      })
      expect({ name, source }).toMatchObject({
        source: expect.not.stringContaining('datacommons.cancer.gov'),
      })
    }
  })

  it('uses no build-tool or Node-specific globals', () => {
    // `import.meta` breaks babel-jest's CJS transform, and `process.env` ties
    // the module to a bundler's define step.
    for (const [name, source] of eachCode()) {
      expect({ name, source }).toMatchObject({
        source: expect.not.stringContaining('import.meta'),
      })
      expect({ name, source }).toMatchObject({
        source: expect.not.stringContaining('process.env'),
      })
      expect({ name, source }).toMatchObject({
        source: expect.not.stringContaining('NodeJS.'),
      })
    }
  })

  it('declares no global augmentation', () => {
    // Would collide with a newer lib.dom, or with the WICG typings, in a host on
    // a later TypeScript.
    for (const [name, source] of eachCode()) {
      expect({ name, source }).toMatchObject({
        source: expect.not.stringContaining('declare global'),
      })
    }
  })

  it('avoids syntax that changes shape under target es5', () => {
    for (const [name, source] of eachCode()) {
      expect({ name, source }).toMatchObject({
        source: expect.not.stringMatching(/\bfor\s+await\b/),
      })
      expect({ name, source }).toMatchObject({
        source: expect.not.stringMatching(/\basync\s+function\s*\*/),
      })
    }
  })

  it('logs only through the injected logger', () => {
    for (const [name, source] of eachCode()) {
      expect({ name, source }).toMatchObject({
        source: expect.not.stringMatching(/\bconsole\.(log|warn|error|info)\(/),
      })
    }
  })

  it('touches browser globals only in the platform and FSA adapters', () => {
    const allowed = ['platform/capabilities.ts', 'platform/picker.ts']
    for (const [name, source] of eachCode()) {
      if (allowed.indexOf(name) !== -1) {
        continue
      }
      expect({ name, source }).toMatchObject({
        source: expect.not.stringMatching(/\bwindow\./),
      })
      expect({ name, source }).toMatchObject({
        source: expect.not.stringMatching(/\bdocument\./),
      })
      expect({ name, source }).toMatchObject({
        source: expect.not.stringContaining('DOMParser'),
      })
    }
  })

  it('uses no default exports', () => {
    // Named exports survive a package boundary and a re-export chain better.
    for (const [name, source] of eachCode()) {
      expect({ name, source }).toMatchObject({
        source: expect.not.stringMatching(/^export default /m),
      })
    }
  })

  it('declares no enums, which break isolatedModules', () => {
    for (const [name, source] of eachCode()) {
      expect({ name, source }).toMatchObject({
        source: expect.not.stringMatching(/\b(const\s+)?enum\s+\w/),
      })
    }
  })
})
