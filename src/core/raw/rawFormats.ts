/**
 * Detection of camera RAW files (DSLR and mirrorless).
 *
 * This module does not load LibRaw: it is also used by the main process
 * (file-picker filters, watched folder), which must know which files are
 * RAW without decoding them.
 */

/**
 * Extensions of the RAW files StarLight opens, lowercase and without the
 * dot. The first ones are the most common among people who photograph the
 * sky with a camera; the others are less common makers that LibRaw reads
 * all the same.
 */
export const RAW_EXTENSIONS: readonly string[] = [
  'cr2', // Canon (DSLR up to 2018)
  'cr3', // Canon (mirrorless, recent DSLR)
  'crw', // Canon (very old models)
  'nef', // Nikon
  'nrw', // Nikon compact cameras
  'arw', // Sony
  'srf',
  'sr2',
  'raf', // Fujifilm
  'orf', // Olympus / OM System
  'rw2', // Panasonic
  'rwl', // Leica (made by Panasonic)
  'pef', // Pentax
  'dng', // Adobe's open format (Pentax, Leica, Ricoh, phones)
  'srw', // Samsung
  '3fr', // Hasselblad
  'iiq' // Phase One
]

/** Lowercase extension of the name, without the dot ("" if missing). */
function extension(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? ''
  const point = base.lastIndexOf('.')
  return point > 0 ? base.slice(point + 1).toLowerCase() : ''
}

/** True if the file name has a RAW extension. */
export function hasRawExtension(fileName: string): boolean {
  return RAW_EXTENSIONS.includes(extension(fileName))
}

function text(b: Uint8Array, from: number, count: number): string {
  let s = ''
  for (let i = 0; i < count && from + i < b.length; i++) s += String.fromCharCode(b[from + i])
  return s
}

/**
 * Recognizes a RAW from its content and returns the format name ("CR2",
 * "CR3", "NEF"...), or null if the file is not a RAW.
 *
 * The first 16 bytes are enough. Some formats have a signature of their own
 * (CR2, CR3, RAF, ORF, RW2); many others (NEF, ARW, PEF, DNG...) are
 * ordinary TIFF files holding the sensor data: to avoid mistaking them for
 * a real TIFF, which is an already developed image, the file name
 * extension counts for them too.
 */
export function detectRaw(byte: Uint8Array, fileName = ''): string | null {
  if (byte.length < 16) return null
  const start4 = text(byte, 0, 4)

  if (text(byte, 4, 8) === 'ftypcrx ') return 'CR3'
  if (text(byte, 0, 15) === 'FUJIFILMCCD-RAW') return 'RAF'
  if (start4 === 'IIRO' || start4 === 'IIRS' || start4 === 'MMOR') return 'ORF'
  if (start4 === 'IIU\0') return 'RW2'
  if (start4 === 'FOVb') return 'X3F'
  if (start4 === '\0MRM') return 'MRW'
  if (text(byte, 0, 2) === 'II' && text(byte, 6, 8) === 'HEAPCCDR') return 'CRW'

  const tiff = start4 === 'II*\0' || start4 === 'MM\0*'
  if (tiff && text(byte, 8, 2) === 'CR') return 'CR2'
  if (tiff && hasRawExtension(fileName)) return extension(fileName).toUpperCase()
  return null
}
