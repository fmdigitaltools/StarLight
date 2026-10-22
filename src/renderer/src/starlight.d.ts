import type { StarLightApi } from '../../preload/index'

/**
 * The bridge exposed by the preload. The declaration lives in a separate file
 * because an index.d.ts next to index.ts would be taken as the declaration of
 * that module rather than as a global type.
 */
declare global {
  interface Window {
    starlight: StarLightApi
  }
}

export {}
