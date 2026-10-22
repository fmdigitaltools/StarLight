import type { CatalogManifest, CatalogIndexEntry } from '@core/catalog/package'

/** An installed catalog, as seen by the interface. */
export interface InstalledCatalog {
  /** Folder name: matches the manifest id when the catalog is valid. */
  id: string
  /**
   * The manifest; for a catalog that fails the checks and whose manifest
   * cannot be read, a reduced one with the folder name as id and name.
   */
  manifest: CatalogManifest
  /** Disk space used, in bytes. */
  byte: number
  /** False if the catalog has been disabled: it stays on disk but is not loaded. */
  active: boolean
  /**
   * Present if the catalog fails the checks (at startup, or because reading
   * it failed during this session): it is not loaded, and the gallery shows
   * the problem with buttons to uninstall or reinstall it. Ready-made
   * sentences (shared/protectionTexts.ts).
   */
  problems?: string[]
  remedy?: string
}

/** List of the catalogs available on the server, or the reason it is missing. */
export type CatalogListResult =
  | { ok: true; catalogs: CatalogIndexEntry[]; updated: string }
  | { ok: false; error: string }

export type CatalogInstallResult =
  | { ok: true; manifest: CatalogManifest; updated: boolean }
  | { ok: false; cancelled?: boolean; errors: string[]; remedy?: string; name?: string }

/** Download progress, sent to the interface as data arrives. */
export interface CatalogProgress {
  id: string
  received: number
  total: number
}
