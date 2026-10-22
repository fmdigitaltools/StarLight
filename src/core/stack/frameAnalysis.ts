import type { BayerPattern, FitsReadResult, FrameMetadata, FrameStats, ImageData32 } from '@shared/types'
import { sharedFloat32, sharedImage } from '@shared/sharedMemory'
import { readFits } from '../fits/reader'
import { debayer, toLuminance } from '../image/debayer'
import { computeStats, MAD_TO_SIGMA } from '../image/stats'
import { detectStars, evaluateQuality, type Star } from '../stars/detection'
import { computeThumbnail, type Thumbnail } from '../image/thumbnail'
import { compact, expand, type CompactImage } from './compactFrame'

/**
 * Analysis of a frame to be stacked: reading, colour reconstruction,
 * statistics, stars, quality and thumbnail. This is the work of each
 * analysis worker, kept free of anything thread-specific so that the
 * measurement tools run the same code as the application.
 *
 * The frame kept until the sum is produced is returned in compact form when
 * the file allows it (see `compactFrame.ts`): the integer codes read from
 * the file, in shared memory. The reconstructed frame needed for the
 * measurements then stays local and is released at the end of the analysis.
 * Otherwise the full frame is returned, already in shared memory.
 */

export interface FrameAnalysis {
  /** The frame to keep, if it could not be reduced to integer codes. */
  image: ImageData32 | null
  /** The frame to keep, reduced to the integer codes of the file. */
  compact: CompactImage | null
  width: number
  height: number
  channels: 1 | 3
  bitpix: number
  metadata: FrameMetadata
  header: Record<string, string | number | boolean | null>
  stats: FrameStats
  stars: Star[]
  quality: number
  hfr: number
  /** Bayer pattern, if the file was a raw frame from a colour sensor. */
  bayerPattern?: BayerPattern
  thumbnail?: Thumbnail
}

/**
 * Scales to try when reducing pixels to integer codes: the saturation level
 * of RAW files, then the full-scale values of 8-bit and 16-bit formats.
 * Floating-point files are never reduced.
 */
function integerScales(readResult: FitsReadResult): number[] {
  if (readResult.bitpix !== 8 && readResult.bitpix !== 16) return []
  const scale: number[] = []
  const white = readResult.header.cards['WHTLEVEL']
  if (typeof white === 'number') scale.push(white)
  scale.push(readResult.bitpix === 8 ? 255 : 65535, readResult.bitpix === 8 ? 65535 : 255)
  return scale
}

/**
 * Analyses the content of a file. `source.buffer` is released as soon as it
 * has been read, so that its memory is freed during the rest of the
 * analysis.
 *
 * @param compactIfPossible true if the caller can keep the frame in compact
 * form (stacking); false to always get the full frame
 */
export function analyzeContent(
  source: { buffer: ArrayBuffer | null },
  fileName: string,
  withStars: boolean,
  compactIfPossible: boolean
): FrameAnalysis {
  // Pixels are created in shared memory (by the FITS reader and by the
  // colour reconstruction): if the frame stays full-size, stacking can read
  // them from several workers at once without copying.
  const readResult = readFits(new Uint8Array(source.buffer as ArrayBuffer), fileName, sharedFloat32)
  source.buffer = null
  const { metadata, bitpix } = readResult
  const cards = readResult.header.cards
  const rawBayerValue = readResult.image.channels === 1 && metadata.bayer !== 'NONE'

  const reduced = compactIfPossible ? compact(readResult.image, metadata.bayer, integerScales(readResult)) : null
  let image: ImageData32
  // A single luminance plane for statistics, stars and noise.
  let luminance: Float32Array
  if (reduced && reduced.bayer !== 'NONE') {
    // Colour is reconstructed from the codes; the plane that was read, now
    // free, hosts the luminance instead of taking memory alongside it.
    const plane = readResult.image.data
    ;(readResult as { image: unknown }).image = null
    image = expand(reduced)
    luminance = toLuminance(image, plane)
  } else if (reduced) {
    // Mono or already colour: the values read are the frame's values.
    image = readResult.image
    ;(readResult as { image: unknown }).image = null
    luminance = toLuminance(image)
  } else {
    // sharedImage copies only what is not already shared (for example a
    // RAW or a colour TIFF). The plane that was read is not needed after
    // the colour reconstruction.
    image = sharedImage(debayer(readResult.image, metadata.bayer, sharedFloat32))
    ;(readResult as { image: unknown }).image = null
    luminance = toLuminance(image)
  }
  const stats = computeStats(luminance)

  let stars: Star[] = []
  let quality = 0
  let hfr = 0
  if (withStars) {
    stars = detectStars(image, {}, luminance)
    const measurements = evaluateQuality(stars, stats.mad * MAD_TO_SIGMA)
    quality = measurements.score
    hfr = measurements.medianHfr
  }

  let thumbnail: Thumbnail | undefined
  try {
    thumbnail = computeThumbnail(image, 'NONE', metadata.frameType !== 'stacked')
  } catch {
    // The thumbnail is optional: if it fails, the analysis is still valid.
  }

  return {
    image: reduced ? null : image,
    compact: reduced,
    width: image.width,
    height: image.height,
    channels: image.channels,
    bitpix,
    metadata,
    header: cards,
    stats,
    stars,
    quality,
    hfr,
    bayerPattern: rawBayerValue ? metadata.bayer : undefined,
    thumbnail
  }
}
