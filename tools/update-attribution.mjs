/**
 * Aligns the package configuration files with the attribution declared in
 * src/shared/version.ts.
 *
 * The properties embedded in the executable (author, license notice,
 * version) are written when the package is built: this script rewrites
 * them on every build so they stay consistent with the notice shown in
 * the interface.
 *
 * Run automatically by "npm run dist".
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Reads a string constant from version.ts without importing TypeScript. */
function constant(source, name) {
  const found = new RegExp('export const ' + name + " = '([^']*)'").exec(source)
  if (!found) throw new Error('Constant not found in version.ts: ' + name)
  return found[1]
}

const versionSource = readFileSync(join(root, 'src/shared/version.ts'), 'utf8')

const author = constant(versionSource, 'AUTHOR')
const url = constant(versionSource, 'AUTHOR_URL')
const license = constant(versionSource, 'SPDX_LICENSE')
const appVersion = constant(versionSource, 'APP_VERSION')

// The Copyright field in the file properties holds only the license, with no
// symbol or years. The field must still be filled in: when empty,
// electron-builder would write its own "Copyright © year".
const notice = 'GNU General Public License versione 3 o successiva (GPL-3.0-or-later)'

// --- package.json ---
const packagePath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
pkg.author = { name: author, url }
pkg.version = appVersion
pkg.license = license
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

// --- electron-builder.yml ---
const builderPath = join(root, 'electron-builder.yml')
let builder = readFileSync(builderPath, 'utf8')
builder = builder.replace(/^copyright:.*$/m, 'copyright: ' + notice)
writeFileSync(builderPath, builder, 'utf8')

console.log('Attribution updated')
console.log('  author:    ' + author + ' (' + url + ')')
console.log('  copyright: ' + notice)
console.log('  license:   ' + license)
console.log('  version:   ' + appVersion)
