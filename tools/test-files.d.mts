/** Types of test-files.mjs, for the TypeScript tools that import it. */

/** Folder of the test data. */
export declare const testDataFolder: () => string

/** Role map read from test-data.json (role → relative path). */
export declare const testDataRoles: () => Record<string, string>

/** Path of the sample file with that role (or of something inside it). */
export declare const testFile: (role: string, ...rest: string[]) => string
