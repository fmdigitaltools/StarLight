/*
 * Sample files for the tests (real images and generated frames): they are
 * not distributed with the project. The STARLIGHT_TEST_DATA environment
 * variable points to the folder that contains them; its test-data.json
 * maps each role used here ("m27", "synthetic-frames"…) to the relative
 * path of the file or folder. Tests that need them are skipped if they are
 * missing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Folder of the test data. */
export const testDataFolder = () => resolve(process.env.STARLIGHT_TEST_DATA ?? '.')

let roles = null

/** Reads the role map (test-data.json). */
export const testDataRoles = () => {
  if (roles === null) {
    const file = join(testDataFolder(), 'test-data.json')
    roles = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  }
  return roles
}

/** Path of the sample file with that role (or of something inside it). */
export const testFile = (role, ...rest) => join(testDataFolder(), testDataRoles()[role] ?? role, ...rest)
