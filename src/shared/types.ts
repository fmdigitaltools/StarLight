/** Types shared by the main process, the preload and the interface. */

import type { InstrumentInfo } from '@core/catalog/instrument'

export type { RuntimeVersions } from './version'

export type { InstrumentInfo }

/** Value of a FITS header card. */
export type FitsValue = string | number | boolean | null

/** Complete FITS header as key/value pairs plus the comments. */
export interface FitsHeader {
  cards: Record<string, FitsValue>
  comments: Record<string, string>
  order: string[]
}

/** Bayer matrix pattern of the sensor, as declared by the file. */
export type BayerPattern = 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG' | 'NONE'

/**
 * Astrometric solution read from the header: the mapping between pixels and
 * sky (gnomonic TAN projection with SIP distortion). The SIP coefficients are
 * maps keyed "i_j" by the power of the two axes.
 */
export interface Wcs {
  crval: [number, number]
  crpix: [number, number]
  cd: [[number, number], [number, number]]
  cdInverse: [[number, number], [number, number]]
  a: Map<string, number>
  b: Map<string, number>
  ap: Map<string, number>
  bp: Map<string, number>
  naxis1: number
  naxis2: number
}

/** Exposure metadata extracted from the header and normalised. */
export interface FrameMetadata {
  /** Object name declared by the telescope (e.g. "M 42"). */
  object: string | null
  /** Right ascension in degrees. */
  ra: number | null
  /** Declination in degrees. */
  dec: number | null
  /** Exposure time in seconds. */
  exposure: number | null
  /** Sensor gain. */
  gain: number | null
  /** Sensor temperature in °C. */
  sensorTemp: number | null
  /** Exposure start date and time (ISO). */
  dateObs: string | null
  /** Declared instrument (INSTRUME keyword or equivalents). */
  instrument: string | null
  /** Declared telescope. */
  telescope: string | null
  /** Filter in use (e.g. "LP", "IRCUT", "DUAL"). */
  filter: string | null
  /** Focal length in mm. */
  focalLength: number | null
  /** Pixel size in µm. */
  pixelSize: number | null
  /** Declared Bayer pattern. */
  bayer: BayerPattern
  /** Pixel scale in arcseconds per pixel, if it can be computed. */
  pixelScale: number | null
  /** Inferred frame type: light, dark, flat, bias or already stacked. */
  frameType: FrameType
  /** Number of frames already integrated (for files stacked by the telescope). */
  stackCount: number | null
  /** Total integrated exposure in seconds, TOTALEXP keyword. */
  totalExposure: number | null
  /** Additional instrument data (model, firmware, focuser, location), if present. */
  instrumentInfo: InstrumentInfo | null
  /** Astrometric solution, if present in the header (telescope-stacked files carry one). */
  wcs: Wcs | null
  /** Data specific to camera RAW files; absent for FITS. */
  raw?: RawInfo
  /**
   * Format of the file read (FITS, compressed FITS, XISF, TIFF, PNG). TIFF
   * and PNG carry neither exposure data nor coordinates, and the panel says
   * so. Absent in hand-built metadata and in RAW files (which have `raw`).
   */
  format?: ImageFormat
}

/** Image formats read by `readFits` (src/core/fits/reader.ts). */
export type ImageFormat = 'fits' | 'fits-compressed' | 'fits-gzip' | 'xisf' | 'tiff' | 'png'

/**
 * Data of a camera RAW file that has no FITS equivalent. The pixels stay
 * raw: the camera white balance is kept only as a hint and is not applied.
 */
export interface RawInfo {
  /** File format: "CR2", "CR3", "NEF", "ARW", "DNG"... */
  format: string
  /** Sensor black level in raw units (the minimum across channels). */
  blackLevel: number
  /** Saturation level in raw units: it becomes 1 in the data. */
  whiteLevel: number
  /**
   * Black level left in the data, on the 0-1 scale. It is not subtracted
   * because clipping the noise below black to zero would bias darks and
   * biases; calibration (dark or bias) removes it, as for astronomy cameras.
   */
  pedestal: number
  /** White balance multipliers chosen by the camera [R, G, B], G = 1. */
  whiteBalance: [number, number, number] | null
  /** Date and time from the camera clock, without time zone. */
  cameraTime: string | null
  /** Sensor colour filter array: Bayer 2x2, X-Trans 6x6, or already in colour. */
  matrix: 'bayer' | 'xtrans' | 'color' | 'mono'
}

export type FrameType = 'light' | 'dark' | 'flat' | 'bias' | 'stacked' | 'unknown'

/** Decoded image: float planes normalised to [0,1]. */
export interface ImageData32 {
  width: number
  height: number
  /** 1 = monochrome or non-debayered Bayer, 3 = RGB. */
  channels: 1 | 3
  /** Planar data: [R..., G..., B...] or [L...]. */
  data: Float32Array
}

/** Frame loaded into the library. */
export interface LoadedFrame {
  id: string
  path: string
  fileName: string
  sizeBytes: number
  width: number
  height: number
  channels: 1 | 3
  bitpix: number
  metadata: FrameMetadata
  header: FitsHeader
  /** Quick statistics computed on load. */
  stats: FrameStats
  /** Quality score 0-100 computed from FWHM, stars and background. */
  quality: number | null
  /** Manually excluded from processing. */
  excluded: boolean
}

export interface FrameStats {
  min: number
  max: number
  mean: number
  median: number
  stdDev: number
  /** Median absolute deviation, robust to noise. */
  mad: number
  /** Percentage of saturated pixels. */
  saturatedPct: number
}

/** Result of reading a FITS file from disk. */
export interface FitsReadResult {
  header: FitsHeader
  metadata: FrameMetadata
  image: ImageData32
  bitpix: number
  sizeBytes: number
}

/** Result of opening a file from the main process. */
export interface FileHandleInfo {
  path: string
  fileName: string
  sizeBytes: number
}

/** Supported export formats. */
export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'tiff' | 'fits' | 'bmp'

export interface ExportRequest {
  format: ExportFormat
  /** Quality 1-100 for lossy formats. */
  quality: number
  /** Requested bit depth. */
  bitDepth: 8 | 16
  /** Output width in pixels (height computed from the aspect ratio). */
  targetWidth: number
  targetHeight: number
  /** Include the exposure metadata in the file. */
  includeMetadata: boolean
  suggestedName: string
}

/** Celestial object of the bundled catalog. */
export interface CelestialObject {
  /** Main identifier, e.g. "M 42". */
  id: string
  /** Common name. */
  name: string
  /** Alternative designations. */
  aliases: string[]
  /** Object type. */
  type: ObjectType
  /** Right ascension in degrees. */
  ra: number
  /** Declination in degrees. */
  dec: number
  /** Apparent visual magnitude. */
  magnitude: number | null
  /** Apparent major axis size in arcminutes. */
  sizeArcmin: number | null
  /**
   * Apparent minor axis size in arcminutes, for elongated objects (edge-on
   * galaxies). Absent or null if unknown: the marker stays a circle.
   */
  minorArcmin?: number | null
  /**
   * Position angle of the major axis in degrees, measured on the sky from
   * north through east. Absent or null if unknown.
   */
  positionAngle?: number | null
  /** Constellation. */
  constellation: string
  /** Short description. */
  description: string
}

export type ObjectType =
  | 'galaxy'
  | 'star'
  | 'planet'
  | 'moon'
  | 'sun'
  | 'nebula'
  | 'planetary-nebula'
  | 'supernova-remnant'
  | 'open-cluster'
  | 'globular-cluster'
  | 'dark-nebula'
  | 'double-star'
  | 'galaxy-group'
  | 'other'

/** Object recognised in the imaged field. */
export interface RecognizedObject {
  object: CelestialObject
  /** Recognition confidence, 0-1. */
  confidence: number
  /** How it was recognised. */
  method: 'header-name' | 'coordinates' | 'solved-field' | 'wcs'
  /** Distance from the field centre in arcminutes. */
  offsetArcmin: number | null
  /** Estimated position in the frame, in normalised 0-1 coordinates. */
  position: { x: number; y: number } | null
}
