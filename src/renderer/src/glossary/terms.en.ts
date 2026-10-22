/**
 * English glossary entries. Same order and structure as `terms.it.ts`;
 * see `terms.ts` for the types and the editing rules. Cross-references
 * in `see` use the English term names of this file.
 */

import type { GlossaryEntry } from './terms'

export const TERMS_EN: GlossaryEntry[] = [
  // ---------------------------------------------------------------- Capture and sensor
  {
    term: 'Light frame',
    alternatives: ['light', 'frame', 'shot', 'sub-frame', 'subframe', 'sub', 'single exposure'],
    category: 'capture',
    definition:
      'A single exposure of the sky, that is, of the object being imaged. In astrophotography a session usually consists of tens or hundreds of light frames of a few seconds or minutes each, which are then calibrated, aligned and combined. Besides the signal from the object, every frame contains the noise and defects of the sensor.',
    inStarLight:
      'Light frames are loaded in the Import step, one by one or by folder, and appear in the library. StarLight recognizes them from the IMAGETYP header keyword and from the file name. In the Stack step they are measured, calibrated with the masters if requested, aligned and combined into a single image.',
    see: ['Calibration frames', 'Stacking', 'IMAGETYP', 'Frame library']
  },
  {
    term: 'Exposure',
    alternatives: ['exposure time', 'integration time', 'sub length', 'EXPTIME', 'EXPOSURE'],
    category: 'capture',
    definition:
      'The duration of the exposure of a single frame, in seconds. A longer exposure collects more light per frame, but also accumulates more thermal signal, increases the risk of trailed stars and saturates bright stars sooner.',
    inStarLight:
      'The exposure is read from the file header and shown in the Import step under Exposure. The calibration library uses it to choose the matching master dark, which must have the same exposure as the light frames.',
    see: ['Total integration', 'Dark', 'Calibration library']
  },
  {
    term: 'Total integration',
    alternatives: ['integration time', 'integration', 'total exposure'],
    category: 'capture',
    definition:
      'The sum of the exposures of all the frames that make up a stacked image. It is the main indicator of the depth of an image: other conditions being equal, doubling the integration improves the signal-to-noise ratio by about 41%.',
    inStarLight:
      'For pre-stacked files the Import step shows the number of integrated frames and the total integration, when the header reports them.',
    see: ['Exposure', 'Signal-to-noise ratio', 'Pre-stacked image']
  },
  {
    term: 'Sensor',
    alternatives: ['CMOS', 'CCD', 'camera', 'chip'],
    category: 'capture',
    definition:
      'The electronic component that converts light into a measurable signal. It consists of a grid of pixels, each of which accumulates a charge proportional to the photons received during the exposure. Modern astronomy cameras and photographic cameras almost always use CMOS sensors; CCDs are common in older instruments.',
    inStarLight:
      'The sensor characteristics declared in the header (dimensions, pixel size, Bayer matrix, gain, temperature) are used to reconstruct color, compute the image scale and choose compatible calibration masters.',
    see: ['Pixel', 'Bayer matrix', 'Gain', 'Sensor temperature']
  },
  {
    term: 'Pixel',
    alternatives: ['pixel size', 'XPIXSZ', 'micron', 'µm'],
    category: 'capture',
    definition:
      'The light-sensitive element of the sensor and, in the image, the smallest point that carries a value. The physical size of the pixel, in micrometers (µm), together with the focal length determines how much sky each pixel covers.',
    inStarLight:
      'The pixel size is read from the header (keywords such as XPIXSZ or PIXSIZE) and is used to compute the image scale. The Import step shows the width and height in pixels of each frame.',
    see: ['Image scale', 'Focal length', 'Binning']
  },
  {
    term: 'Binning',
    alternatives: ['XBINNING', 'bin 2x2'],
    category: 'capture',
    definition:
      'The grouping of several adjacent sensor pixels, for example 2 × 2, which are read out as a single larger pixel. It reduces resolution and increases the signal per pixel.',
    inStarLight:
      'The binning factor declared in the header is multiplied by the pixel size when computing the image scale.',
    see: ['Pixel', 'Image scale']
  },
  {
    term: 'Focal length',
    alternatives: ['focal', 'FOCALLEN'],
    category: 'capture',
    definition:
      'The distance, in millimeters, between the lens or primary mirror and the plane where the image is formed. With the same sensor, a longer focal length gives higher magnification and a narrower field.',
    inStarLight:
      'The focal length is read from the header and, together with the pixel size, is used to compute the image scale, which plate solving also uses as a starting hint.',
    see: ['Image scale', 'Pixel', 'Field of view']
  },
  {
    term: 'Gain',
    alternatives: ['GAIN', 'ISO', 'sensitivity'],
    category: 'capture',
    definition:
      'The amplification applied by the sensor to the signal before it is converted into numbers. In photographic cameras it corresponds to the ISO setting. A higher gain brightens faint signal and reduces the weight of read noise, but narrows the dynamic range. Darks and bias frames are valid only for the gain at which they were taken.',
    inStarLight:
      'The gain is read from the header and shown in the Import step. The calibration library reuses a master dark or master bias only if its gain matches that of the light frames. Not to be confused with the Red gain, Green gain and Blue gain sliders of the Correct step, which set the color balance.',
    see: ['Dark', 'Bias', 'Channel gains', 'Calibration library']
  },
  {
    term: 'Sensor temperature',
    alternatives: ['CCD-TEMP', 'SET-TEMP', 'cooling', 'temperature'],
    category: 'capture',
    definition:
      'The temperature of the sensor during capture, in degrees Celsius. Thermal signal roughly doubles every 5-6 °C, so a dark is valid only for light frames taken at a very similar temperature. Cooled cameras keep the sensor at a fixed temperature for precisely this reason.',
    inStarLight:
      'The temperature is read from the header and shown in the Import step. The calibration library reuses a master dark only if its temperature is within 3 °C of that of the light frames and, among several suitable darks, chooses the one closest in temperature.',
    see: ['Thermal signal', 'Dark', 'Calibration library']
  },
  {
    term: 'Noise',
    alternatives: ['grain', 'graininess'],
    category: 'capture',
    definition:
      'Random variation of pixel values superimposed on the true signal. It has several sources: the discrete nature of light (photon noise), the readout electronics (read noise) and the heat of the sensor (thermal noise). Because it is random, it changes from one frame to the next and decreases when many frames are combined.',
    inStarLight:
      'The Import step reports a noise estimate for each frame, computed with robust statistics that are barely affected by stars. Noise is reduced by stacking and, on the image, by the NL-Bayes and Wavelets tools of the Process step, by the noise reduction of the Filters step and by local adjustments.',
    see: ['Signal-to-noise ratio', 'Read noise', 'Noise reduction', 'Stacking']
  },
  {
    term: 'Read noise',
    alternatives: ['readout noise', 'electronic noise'],
    category: 'capture',
    definition:
      'The noise component introduced by the sensor electronics at every readout, regardless of exposure length. It matters most in short exposures and with very faint signal.',
    inStarLight:
      'It is not corrected directly, because it is random: it decreases with stacking. The fixed readout level, which is constant, is measured by the bias or is already included in the dark.',
    see: ['Noise', 'Bias', 'Stacking']
  },
  {
    term: 'Thermal signal',
    alternatives: ['dark current', 'thermal noise', 'dark signal'],
    category: 'capture',
    definition:
      'Signal produced by the heat of the sensor even in the absence of light. It grows with exposure length and temperature and is not uniform: some pixels produce much more of it than others. The constant part is subtracted with the dark; the random part decreases with stacking.',
    inStarLight:
      'Thermal signal is subtracted from the light frames with the master dark during stacking, when calibration is enabled.',
    see: ['Dark', 'Master dark', 'Hot pixels', 'Sensor temperature']
  },
  {
    term: 'Signal-to-noise ratio',
    alternatives: ['SNR', 'S/N', 'signal to noise'],
    category: 'capture',
    definition:
      'The ratio between the strength of the useful signal and the amplitude of the noise. It is the main measure of the quality of an astronomical image: a high ratio allows faint tones to be stretched without bringing out the grain. Combining N frames improves the ratio in proportion to the square root of N: four times as many frames halve the relative noise.',
    inStarLight:
      'At the end of stacking the Stack step reports the measured noise reduction, comparing the noise of the reference frame with that of the result, and the reduction expected from the number of integrated frames.',
    see: ['Noise', 'Stacking', 'Total integration']
  },
  {
    term: 'Saturated pixels',
    alternatives: ['sensor saturation', 'clipping', 'clipped pixels', 'blown-out stars', 'saturated'],
    category: 'capture',
    definition:
      'Pixels that have reached the maximum measurable value. Beyond this limit the sensor no longer records differences in brightness, so the information is lost: the cores of bright stars and bright nuclei appear as uniform areas. The phenomenon is not to be confused with color saturation.',
    inStarLight:
      'The Import step reports the percentage of pixels at the top of the scale. Saturated stars are excluded from photometric color calibration. The HDR plugin recovers detail in bright areas only if it is present in the data.',
    see: ['Dynamic range', 'HDR, recovery of the bright areas', 'Saturation']
  },
  {
    term: 'Dynamic range',
    alternatives: ['DR'],
    category: 'capture',
    definition:
      'The range between the faintest signal distinguishable from noise and the strongest signal that can be recorded before saturation. Astronomical objects require a very wide one: the core of a galaxy or nebula can be thousands of times brighter than its outer regions.',
    inStarLight:
      'StarLight processes data in 32-bit floating point, which preserves the full dynamic range of the files. The stretch, GHS and the HDR plugin compress the dynamic range so that both faint tones and bright areas remain readable on screen.',
    see: ['Bit depth', 'Stretch', 'HDR, recovery of the bright areas']
  },
  {
    term: 'Bayer matrix',
    alternatives: ['Bayer', 'CFA', 'color filter array', 'Bayer pattern', 'RGGB', 'GRBG', 'BGGR', 'GBRG', 'BAYERPAT'],
    category: 'capture',
    definition:
      'A grid of red, green and blue filters placed in front of the pixels of a color sensor, repeated in cells of 2 × 2 pixels with two green, one red and one blue. Each pixel measures only one color; the other two are reconstructed from neighboring pixels. The order of the filters in the cell (for example RGGB or GRBG) varies from sensor to sensor.',
    inStarLight:
      'The pattern is read from the file header (the BAYERPAT keyword or equivalents) and shown in the Import step. StarLight uses it to reconstruct the color of raw frames and for Bayer drizzle.',
    see: ['Debayering', 'Bayer drizzle', 'X-Trans', 'Color sensor']
  },
  {
    term: 'X-Trans',
    alternatives: ['X-Trans pattern'],
    category: 'capture',
    definition:
      'An arrangement of color filters used by some cameras as an alternative to the Bayer matrix: the pattern repeats in cells of 6 × 6 pixels instead of 2 × 2.',
    inStarLight:
      'RAW files from X-Trans sensors are read and their color is reconstructed with a procedure specific to this pattern.',
    see: ['Bayer matrix', 'RAW', 'Debayering']
  },
  {
    term: 'Debayering',
    alternatives: ['debayer', 'demosaicing', 'demosaicking', 'color reconstruction', 'Bayer interpolation'],
    category: 'capture',
    definition:
      'The computation that, starting from the raw data of a color sensor, estimates for each pixel the two colors it did not measure using neighboring pixels, producing an image with three complete channels. The interpolation tends to soften stars slightly and can leave thin colored fringes along edges.',
    inStarLight:
      'Raw frames from color sensors are reconstructed with bilinear interpolation, which keeps in each pixel the value actually measured. Alternatively, in the Stack step, Bayer drizzle avoids interpolation and uses only the measured colors.',
    see: ['Bayer matrix', 'Bayer drizzle', 'Color sensor']
  },
  {
    term: 'Color sensor',
    alternatives: ['OSC', 'one shot color', 'monochrome sensor', 'mono', 'color camera'],
    category: 'capture',
    definition:
      'A sensor fitted with a color filter array, which produces a color image in a single shot. A monochrome sensor, with no filters on the pixels, records only brightness and obtains color by imaging the same field through different filters, placed in front of the sensor one at a time.',
    inStarLight:
      'StarLight processes both frames from color sensors, reconstructing their color from the Bayer or X-Trans matrix, and monochrome frames, which remain single-channel.',
    see: ['Bayer matrix', 'Debayering', 'Color channel']
  },
  {
    term: 'Vignetting',
    alternatives: ['light falloff', 'edge darkening'],
    category: 'capture',
    definition:
      'A gradual decrease in brightness from the center toward the edges and corners of the image, caused by the optics and by mechanical elements in the light path. In artistic photography the same term also refers to an effect applied deliberately to darken the edges and draw attention to the subject.',
    inStarLight:
      'Optical vignetting is corrected with the master flat during calibration. The Filters step instead contains an artistic vignette, which gradually darkens edges and corners while leaving the center untouched; when a crop is set, it is centered on the exported area.',
    see: ['Flat', 'Master flat', 'Photo filter']
  },
  {
    term: 'Seeing',
    alternatives: ['atmospheric turbulence', 'turbulence'],
    category: 'capture',
    definition:
      'The degradation of the image caused by atmospheric turbulence, which makes stars twinkle and swell. It is usually measured as the FWHM of stars in arcseconds and varies from night to night and during the same night.',
    inStarLight:
      'The effects of seeing show in the HFR of the frames, displayed in the Stack step: frames with wider stars receive a lower quality score. Deconvolution partly recovers the lost sharpness.',
    see: ['HFR', 'FWHM', 'Frame quality', 'Deconvolution']
  },
  {
    term: 'Chromatic aberration',
    alternatives: ['color fringing', 'colored fringes', 'purple halo', 'blue halo', 'CA'],
    category: 'capture',
    definition:
      'A lens defect in which not all colors come to the same focus. In longitudinal aberration, blue and violet are spread over a wider disk than green and form a purple or blue halo around stars, typical of two-element refractors and photographic lenses. In lateral aberration the colors shift relative to one another toward the edges of the field, and stars show a red fringe on one side and a green or blue fringe on the other.',
    inStarLight:
      'The Purple and blue fringe removal plugin measures the color of each star in its inner part and subtracts the excess colored light from the edge; with the “All hues” option it also corrects lateral aberration fringes.',
    see: ['Purple and blue fringe removal', 'Star halos']
  },
  {
    term: 'Star halos',
    alternatives: ['halo', 'halos', 'internal reflections', 'glow around stars', 'star glow'],
    category: 'capture',
    definition:
      'Diffuse light around a star, much wider than its disk. Around bright stars, a wide, faint halo arises from haze or thin clouds, from reflections between the surfaces of lenses and filters and from scattering in the optics; a narrower colored halo is instead usually an effect of chromatic aberration.',
    inStarLight:
      'The Bright star halo reduction plugin attenuates the wide halo of the brightest stars; the Purple and blue fringe removal plugin removes the colored fringe caused by chromatic aberration.',
    see: ['Bright star halo reduction', 'Chromatic aberration', 'Gradient']
  },
  {
    term: 'Light pollution',
    alternatives: ['urban sky', 'skyglow'],
    category: 'capture',
    definition:
      'Artificial light scattered by the atmosphere, which brightens the night sky and adds a bright background to the image, often colored and uneven. It reduces the contrast of faint objects and increases noise.',
    inStarLight:
      'The effects of light pollution are corrected with background extraction in the Process step, with background removal in the Filters step and with the channel gains of the Correct step.',
    see: ['Sky background', 'Gradient', 'Background extraction', 'Light pollution filter']
  },
  {
    term: 'Filter',
    alternatives: ['optical filter', 'astronomical filter', 'FILTER', 'filter wheel'],
    category: 'capture',
    definition:
      'An optical element in the light path that transmits only certain wavelengths. Astrophotography uses filters that block infrared, filters that reduce light pollution and narrowband filters that isolate the emission lines of certain gases.',
    inStarLight:
      'The filter declared in the header (FILTER keyword) is shown in the Import step. StarLight uses it to recognize images taken with a dual-band filter and to match master flats, which the library reuses only with the same filter. Not to be confused with the photo filters of the Filters step.',
    see: ['IR-cut filter', 'Light pollution filter', 'Dual-band filter', 'Narrowband', 'Photo filter']
  },
  {
    term: 'IR-cut filter',
    alternatives: ['IRCUT', 'UV/IR cut', 'infrared-blocking filter', 'broadband'],
    category: 'capture',
    definition:
      'A filter that blocks infrared and ultraviolet and transmits all visible light. It prevents stars from appearing bloated or oddly colored because of wavelengths the optics cannot bring to focus. An image taken with this filter is called broadband.',
    inStarLight:
      'A file with an IRCUT filter, or with no filter information, is treated as a broadband image: photometric color calibration and natural palettes apply normally.',
    see: ['Filter', 'Photometric color calibration']
  },
  {
    term: 'Light pollution filter',
    alternatives: ['LP', 'LP filter', 'light pollution reduction filter', 'CLS'],
    category: 'capture',
    definition:
      'A filter that attenuates the wavelengths typical of artificial lighting and transmits those emitted by nebulae. Some models are moderately broadband, others are true dual-band filters. It tends to leave a color cast on the background, often greenish or reddish.',
    inStarLight:
      'In the header, the values LP, DUO or DUAL of the FILTER keyword are interpreted as a dual-band filter: the Process step then suggests the HOO palette. Any remaining cast is corrected with the channel gains of the Correct step.',
    see: ['Dual-band filter', 'Color cast', 'Light pollution']
  },
  {
    term: 'Dual-band filter',
    alternatives: ['dual band', 'duo band', 'DUAL', 'DUO', 'dual narrowband'],
    category: 'capture',
    definition:
      'A narrowband filter for color sensors that transmits only two emission lines, usually hydrogen (H-alpha) and oxygen (OIII). With a color sensor, H-alpha falls in the red channel and OIII in the green and blue channels.',
    inStarLight:
      'When the header indicates this filter, the Narrowband card of the Process step reports it and recommends the HOO palette. The card separates the two lines from the sensor channels and recombines them according to the chosen palette. Photometric color calibration is not meaningful for these images.',
    see: ['Narrowband', 'H-alpha', 'OIII', 'HOO', 'Palette']
  },
  {
    term: 'Narrowband',
    alternatives: ['narrow band', 'narrowband filters'],
    category: 'capture',
    definition:
      'An imaging technique using filters that transmit only very narrow wavelength ranges, corresponding to the emission lines of certain gases such as hydrogen (H-alpha), oxygen (OIII) and sulfur (SII). It greatly reduces the effect of light pollution and moonlight and is well suited to emission nebulae. The final colors are assigned by convention.',
    inStarLight:
      'The Narrowband card of the Process step handles images taken with a dual-band filter: it separates hydrogen and oxygen and recombines them with the HOO, Foraxx and synthetic Hubble palettes, with sliders for the balance between the two gases and the strength of the oxygen.',
    see: ['Dual-band filter', 'H-alpha', 'OIII', 'SII', 'Palette']
  },
  {
    term: 'H-alpha',
    alternatives: ['Hα', 'Ha', 'hydrogen alpha', 'hydrogen'],
    category: 'capture',
    definition:
      'The emission line of hydrogen at 656.3 nanometers, in the red. It is the dominant light of most emission nebulae and gives them their typical red color.',
    inStarLight:
      'In images taken with a dual-band filter, H-alpha is extracted from the red channel. Local adjustments offer a ready-made color mask for the red of hydrogen.',
    see: ['Narrowband', 'OIII', 'Emission nebula', 'Mask']
  },
  {
    term: 'OIII',
    alternatives: ['O III', 'O3', 'oxygen', 'ionized oxygen', 'doubly ionized oxygen'],
    category: 'capture',
    definition:
      'The emission lines of doubly ionized oxygen, at 495.9 and 500.7 nanometers, on the border between green and blue. They are strong in planetary nebulae and supernova remnants, and weaker than H-alpha in most nebulae.',
    inStarLight:
      'In images taken with a dual-band filter, OIII is derived from the green and blue channels. The OIII intensity slider of the Narrowband card boosts or reduces it; local adjustments offer a color mask for the cyan of oxygen.',
    see: ['Narrowband', 'H-alpha', 'HOO']
  },
  {
    term: 'SII',
    alternatives: ['S II', 'S2', 'sulfur', 'ionized sulfur'],
    category: 'capture',
    definition:
      'The emission line of ionized sulfur at 671.6 nanometers, in the deep red. It is captured with a dedicated filter, usually with monochrome sensors, and is one of the three components of the SHO palette.',
    inStarLight:
      'Dual-band filters do not collect sulfur: for this reason the StarLight Hubble palette is synthetic and reuses hydrogen in place of sulfur.',
    see: ['Narrowband', 'Hubble palette']
  },
  {
    term: 'Field rotation',
    alternatives: ['alt-az mount', 'altazimuth mount', 'image rotation'],
    category: 'capture',
    definition:
      'The progressive rotation of the sky image around the center of the field, typical of altazimuth mounts, which track the sky by moving in altitude and azimuth rather than around an axis parallel to that of the Earth. In long exposures it distorts the stars at the edges; between frames it rotates the framing.',
    inStarLight:
      'Alignment also measures the rotation of each frame and compensates for it. The edges of the result are left with areas covered by few frames, which are noisier: the Crop edges covered by few frames option of the Stack step suggests a crop that excludes them.',
    see: ['Alignment', 'Low-coverage edges', 'Mount']
  },
  {
    term: 'Mount',
    alternatives: ['equatorial mount', 'altazimuth mount', 'tracking'],
    category: 'capture',
    definition:
      'The motorized support that points the telescope and compensates for the Earth’s rotation during capture. An equatorial mount rotates around an axis parallel to the Earth’s and keeps the orientation of the field fixed; an altazimuth mount moves in altitude and azimuth and produces field rotation.',
    inStarLight:
      'StarLight does not control the mount. It corrects its effects on the frames: shifts and rotations are compensated by alignment, and trailed frames receive a low quality score.',
    see: ['Field rotation', 'Alignment', 'Frame quality']
  },
  {
    term: 'Focuser',
    alternatives: ['FOCPOS', 'focusing', 'focus position'],
    category: 'capture',
    definition:
      'The mechanism that moves the sensor or an optical element to bring the image into focus. Motorized focusers record their position in motor steps.',
    inStarLight:
      'The focuser position, if present in the header, is shown in the Import step and helps restore focus in later sessions. Imperfect focus shows up as a higher HFR.',
    see: ['HFR', 'Frame quality']
  },

  // ---------------------------------------------------------------- Calibration
  {
    term: 'Calibration',
    alternatives: ['frame calibration', 'pre-processing', 'preprocessing'],
    category: 'calibration',
    definition:
      'The correction of light frames using calibration frames, which measure the defects of the sensor and optics. The usual formula subtracts the dark (or, if missing, the bias) and divides the result by the normalized flat. Calibration is performed before alignment and combination.',
    inStarLight:
      'The Calibrate step automatically splits the darks, flats and bias frames in the library into groups with the same capture conditions (darks by exposure, gain and temperature within 3 °C; bias frames by gain; flats by filter and night) and builds a master for each group; a frame left alone in a group is excluded, with an explanation. With the Apply calibration during stacking switch on, in the Stack step each light frame uses the master matching its conditions, or the one from the calibration library: dark subtraction, division by the normalized flat, bias subtraction when no suitable dark is available, and replacement of defective pixels. A dark with a different exposure, gain or temperature is never used; the stacking summary lists, for each group of light frames, the masters used and the reason.',
    see: ['Calibration frames', 'Master', 'Dark', 'Flat', 'Bias', 'Calibration library']
  },
  {
    term: 'Calibration frames',
    alternatives: ['calibration frame', 'correction frames'],
    category: 'calibration',
    definition:
      'Frames that do not image the sky but measure the defects of the imaging system: the dark records thermal signal and hot pixels, the flat records vignetting and dust shadows, the bias records the starting level of the readout. They must be taken with the same sensor and with settings consistent with those of the light frames.',
    inStarLight:
      'StarLight recognizes the type of each frame from the IMAGETYP keyword and from the file name, groups them in the Calibrate step and combines them into the corresponding masters.',
    see: ['Dark', 'Flat', 'Bias', 'Master', 'IMAGETYP']
  },
  {
    term: 'Dark',
    alternatives: ['dark frame', 'darks'],
    category: 'calibration',
    definition:
      'A frame taken with the telescope covered, with the same exposure, gain and temperature as the light frames. It records the thermal signal of the sensor, the readout level and the hot pixels: defects that are identical in every shot and that combining frames alone does not remove.',
    inStarLight:
      'The darks in the library are combined into the master dark in the Calibrate step. A single file recognized as a dark is considered a master already and is used as it is.',
    see: ['Master dark', 'Thermal signal', 'Hot pixels', 'Flat darks']
  },
  {
    term: 'Master',
    alternatives: ['master frame', 'calibration master'],
    category: 'calibration',
    definition:
      'A reference frame obtained by combining many calibration frames of the same type. Combining them reduces the random noise of the individual shots and leaves only the systematic defect to be corrected: a master built from many frames adds less noise to the light frames.',
    inStarLight:
      'In the Calibrate step the frames of each type are combined with the median, which also removes disturbances present in a single shot, such as cosmic rays. The masters built are stored in the calibration library for later sessions.',
    see: ['Master dark', 'Master flat', 'Master bias', 'Median', 'Calibration library']
  },
  {
    term: 'Master dark',
    alternatives: ['dark master', 'masterdark'],
    category: 'calibration',
    definition:
      'The combination of many darks into a single frame that represents the thermal signal and readout level of the sensor for a given exposure, gain and temperature. It is subtracted from every light frame. Some telescopes and capture programs produce the master dark directly.',
    inStarLight:
      'StarLight builds the master dark from the median of the darks, counts the defective pixels (those that record much more light than average in the dark) and subtracts it from every light frame during stacking. The same defective pixels are then replaced with the median of the neighboring pixels. A master dark already produced by the telescope is imported like any other file and is recognized automatically.',
    see: ['Dark', 'Hot pixels', 'Median', 'Calibration library']
  },
  {
    term: 'Bias',
    alternatives: ['bias frame', 'offset', 'offset frame', 'zero'],
    category: 'calibration',
    definition:
      'A frame taken in the dark with the shortest possible exposure. It records the starting level of the readout, that is, the value the sensor reports even in the absence of light and thermal signal. The dark already contains this level, so the bias is needed when darks are missing or to correct the flats.',
    inStarLight:
      'Bias frames are combined into the master bias. StarLight subtracts it from the light frames only when no master dark is available, and uses it to correct the master flat when there is no dark with the same exposure as the flats.',
    see: ['Master bias', 'Dark', 'Master flat', 'Read noise']
  },
  {
    term: 'Master bias',
    alternatives: ['bias master', 'masterbias'],
    category: 'calibration',
    definition:
      'The combination of many bias frames into a single frame that represents the readout level of the sensor for a given gain.',
    inStarLight:
      'It is built with the median in the Calibrate step and stored in the calibration library, which reuses it with the same sensor and the same gain.',
    see: ['Bias', 'Master', 'Calibration library']
  },
  {
    term: 'Flat',
    alternatives: ['flat field', 'flat frame', 'flats'],
    category: 'calibration',
    definition:
      'A frame taken by pointing the instrument at an evenly illuminated surface, without changing focus, camera orientation or filter relative to the light frames. It measures the different response of the various areas of the sensor: vignetting, dust shadows and sensitivity differences between pixels.',
    inStarLight:
      'Flats are combined into the master flat in the Calibrate step. During stacking each light frame is divided by the normalized master flat, so that less illuminated areas are brought back to the correct brightness.',
    see: ['Master flat', 'Vignetting', 'Dust shadows', 'Flat darks']
  },
  {
    term: 'Master flat',
    alternatives: ['flat master', 'masterflat'],
    category: 'calibration',
    definition:
      'The combination of many flats into a single frame, corrected for the readout level and normalized, that is, divided by its own mean value, so that the division corrects unevenness without changing the overall brightness of the image.',
    inStarLight:
      'StarLight builds the master flat with the median and, before storing it, subtracts a dark with the same exposure as the flats taken from the library or, failing that, the master bias. Normalization by the mean takes place at calibration time.',
    see: ['Flat', 'Flat darks', 'Bias', 'Calibration library']
  },
  {
    term: 'Flat darks',
    alternatives: ['flat dark', 'dark flat', 'darkflat', 'dark flats'],
    category: 'calibration',
    definition:
      'Darks taken with the same exposure and gain as the flats. They remove the readout level and thermal signal from the master flat before normalization; when they are missing, the bias is usually used instead.',
    inStarLight:
      'When building a master flat, StarLight looks in the calibration library for a master dark that matches the conditions of the flats and subtracts it; if none is found it uses the master bias. The library records which of the two corrections was applied.',
    see: ['Master flat', 'Dark', 'Bias', 'Calibration library']
  },
  {
    term: 'Hot pixels',
    alternatives: ['hot pixel', 'defective pixels', 'cold pixels', 'dead pixels', 'cold pixel', 'cosmetic defects'],
    category: 'calibration',
    definition:
      'Pixels that record an anomalous value, much higher (hot) or much lower (cold or dead) than the surrounding ones, regardless of the light received. They stay in the same position in every shot, so stacking alone does not remove them, and in the final image they form isolated dots or short colored streaks.',
    inStarLight:
      'During calibration hot pixels are identified in the master dark and replaced with the median of the eight neighboring pixels. Independently of the darks, the Correct defective pixels option of the Defects and sky background card in the Process step replaces isolated anomalous points with the median of their neighbors, without touching the stars.',
    see: ['Master dark', 'Median', 'Thermal signal']
  },
  {
    term: 'Dust shadows',
    alternatives: ['dust', 'dust donuts', 'dust rings', 'dust motes'],
    category: 'calibration',
    definition:
      'Circular or ring-shaped shadows produced by dust particles on the filters or on the sensor window. They are out of focus, so they appear as soft disks, and they move when the dust shifts or the camera rotates.',
    inStarLight:
      'They are corrected with the master flat. The calibration library reuses a flat only if it was taken no more than 30 days earlier, because a changed optical setup would introduce shadows that are no longer present.',
    see: ['Flat', 'Master flat', 'Calibration library']
  },
  {
    term: 'Calibration library',
    alternatives: ['master library', 'master archive', 'master reuse'],
    category: 'calibration',
    definition:
      'An archive of masters kept from one session to the next, which makes it possible to calibrate new images without taking darks, flats and bias frames every time, provided that the capture conditions match.',
    inStarLight:
      'The masters built in the Calibrate step remain on the computer, one for each group of conditions, and are reused automatically during stacking: a dark with the same sensor, the same exposure, the same gain and a temperature within 3 °C; a bias with the same gain; a flat with the same filter, taken no more than 30 days earlier. Among several suitable darks the one closest in temperature is chosen and, if tied, the most recent; among several suitable flats the one taken on the date closest to that of the frame, so that each night uses its own flats. The same rules apply to the masters built in the session, which take precedence: the library serves the frames that find no master with their conditions in the session. The Calibration library card allows reuse to be turned off and individual masters to be deleted.',
    see: ['Master', 'Master dark', 'Master flat', 'Master bias', 'Sensor temperature']
  },

  // ---------------------------------------------------------------- Stacking
  {
    term: 'Stacking',
    alternatives: ['stack', 'integration', 'frame combination', 'combination'],
    category: 'stacking',
    definition:
      'The combination of many aligned frames into a single image. The signal from the object is the same in every frame, while the noise is random: combining N frames reduces the relative noise by a factor equal to the square root of N. With a hundred frames the noise becomes ten times lower.',
    inStarLight:
      'The Stack step measures the frames included in the library, calibrates them if requested, aligns them, discards those below the minimum quality and combines them with the chosen method: Robust, Mean or Median. The computation is spread across the processor cores.',
    see: ['Alignment', 'Sigma clipping', 'Mean', 'Median', 'Signal-to-noise ratio', 'Multi-night stacking']
  },
  {
    term: 'Multi-night stacking',
    alternatives: ['multiple sessions', 'multiple nights', 'night weight', 'night weights', 'frame normalization'],
    category: 'stacking',
    definition:
      'The combination into a single image of frames taken on different nights. Nights differ in sky transparency, background brightness, turbulence and temperature: before combining them, the frames must be brought to the same background and brightness level, and each night must be weighted according to the quality of its data. Classic weighting gives each night a weight inversely proportional to the noise variance, so that cleaner nights count more.',
    inStarLight:
      'StarLight recognizes nights from the capture date written in the file header (a night runs from noon to noon; without a date, the source folder is used). The quality of each frame is assessed relative to the frames of the same night, so a hazy night is not discarded as a whole. After alignment each night receives a weight, computed from the background noise and the sharpness of the stars and explained in words, and its frames are normalized to those of the reference night. In the Stack step, when there is more than one night, each night can be excluded or weighted manually. The Median method does not use the weights; normalization applies to all methods.',
    see: ['Stacking', 'Frame quality', 'Noise', 'Sky background', 'Calibration library']
  },
  {
    term: 'HDR merge of different exposures',
    alternatives: ['HDR', 'short exposures', 'long exposures', 'saturated core', 'multiple exposures', 'exposure blending'],
    category: 'stacking',
    definition:
      'The combination of two or more series of frames taken with different exposure times. Long exposures collect the faint parts of the object but saturate the brightest areas, where the recorded data is lost; short exposures record those areas without saturating them. Each series is stacked separately; the short series, scaled to the long one, replace it only where it approaches saturation, with a gradual transition.',
    inStarLight:
      'When the light frames have exposures that differ by at least a factor of one and a half, with at least two frames per series, the Stack step shows the HDR merge card, enabled by default. The brightness ratio between the series and the background level of each are measured on pixels well exposed in both, not derived from the declared times: this way different gains and a sky that changed between one series and the other are also handled. The result remains linear and is scaled between 0 and 1. The merge is not available with comet stacking.',
    see: ['Stacking', 'Saturation', 'Dynamic range', 'HDR, recovery of the bright areas']
  },
  {
    term: 'Alignment',
    alternatives: ['registration', 'align on stars', 'star alignment'],
    category: 'stacking',
    definition:
      'The computation of the geometric transformation that overlays each frame on a reference frame, compensating for the shifts, rotations and small changes of scale that occurred during capture. Without alignment the combination would produce trailed stars.',
    inStarLight:
      'With the Align on the stars option, StarLight detects the stars of each frame and compares them with those of the best frame by means of triangles, whose shape does not change with shift or rotation. The transformation includes translation, rotation and scale. The Stack step reports the measured shift for each frame.',
    see: ['Reference frame', 'Stacking', 'Field rotation']
  },
  {
    term: 'Reference frame',
    alternatives: ['reference', 'best frame'],
    category: 'stacking',
    definition:
      'The frame to which all the others are aligned. Its geometry becomes that of the stacked image, so it should be sharp and rich in stars.',
    inStarLight:
      'StarLight uses as reference the frame with the highest quality score in the session.',
    see: ['Alignment', 'Frame quality']
  },
  {
    term: 'Frame quality',
    alternatives: ['score', 'minimum quality', 'frame rejection', 'rejected frames', 'frame grading'],
    category: 'stacking',
    definition:
      'An assessment of a frame based on the number of visible stars and their sharpness. Clouds and haze reduce the stars detected; trailing, poor focus and seeing make them wider. Excluding the worst frames improves the result more than the loss of signal degrades it.',
    inStarLight:
      'Each frame receives a percentage score relative to the best frames of the same session, computed as the product of two ratios: the stars detected relative to those of the best frames, and the HFR of the best frames relative to its own. Frames below the value of the Minimum quality slider are excluded. In a live session, scores are recalculated as better frames arrive.',
    see: ['HFR', 'Seeing', 'Stacking', 'Live session']
  },
  {
    term: 'HFR',
    alternatives: ['Half Flux Radius', 'half-flux radius'],
    category: 'stacking',
    definition:
      'Abbreviation of Half Flux Radius: the radius, in pixels, of the circle that contains half of the light of a star. It measures star sharpness in a way that is not very sensitive to noise: a lower value indicates smaller stars and a sharper image.',
    inStarLight:
      'The median HFR of each frame appears in the frame details of the Stack step and contributes to the quality score. The Show detected stars command of the View menu marks each star with a circle proportional to its HFR. Deconvolution derives the blur size from the HFR when the corresponding slider is at zero.',
    see: ['FWHM', 'Frame quality', 'PSF', 'Deconvolution']
  },
  {
    term: 'FWHM',
    alternatives: ['Full Width at Half Maximum', 'full width at half maximum'],
    category: 'stacking',
    definition:
      'Abbreviation of Full Width at Half Maximum: the diameter of the profile of a star measured at half of its peak intensity. It is the most common measure of seeing and sharpness, expressed in pixels or arcseconds; for a Gaussian profile it is about twice the HFR.',
    inStarLight:
      'StarLight shows the sharpness of the frames with the HFR. An estimate of star width is used internally, for example by trail removal, which considers a line a trail only if it is as wide as a star and much longer.',
    see: ['HFR', 'Seeing', 'PSF']
  },
  {
    term: 'Mean',
    alternatives: ['average', 'arithmetic mean'],
    category: 'stacking',
    definition:
      'The sum of the values divided by their number. As a stacking method it uses all the signal and gives the lowest noise, but a disturbance present in a single frame, such as a satellite trail, carries over, attenuated, into the result.',
    inStarLight:
      'The Mean method of the Stack step combines all the values of each pixel. It is recommended only when no frame contains disturbances.',
    see: ['Median', 'Sigma clipping', 'Stacking']
  },
  {
    term: 'Median',
    alternatives: ['middle value'],
    category: 'stacking',
    definition:
      'The middle value of a set of measurements sorted from lowest to highest. Unlike the mean, it is not affected by isolated values very different from the others, such as a satellite trail present in a single shot, but it uses less of the information and leaves somewhat higher noise.',
    inStarLight:
      'The median is used to build the calibration masters, to replace defective pixels, as the Median stacking method and as the reference center of the Robust method. In the Import step the median of the pixels indicates the sky background level.',
    see: ['Mean', 'Sigma clipping', 'Master', 'MAD']
  },
  {
    term: 'Standard deviation',
    alternatives: ['sigma', 'σ', 'std dev', 'root mean square deviation'],
    category: 'stacking',
    definition:
      'A measure of the spread of a set of values around their mean: it indicates the typical size of the variations. Applied to sky background pixels, it expresses the noise level.',
    inStarLight:
      'The rejection threshold of the Robust method is expressed in standard deviations. StarLight estimates the spread with robust methods, which are not skewed by bright stars.',
    see: ['MAD', 'Sigma clipping', 'Rejection threshold']
  },
  {
    term: 'MAD',
    alternatives: ['median absolute deviation', 'robust statistics'],
    category: 'stacking',
    definition:
      'Abbreviation of Median Absolute Deviation: the median of the distances of the values from their median. It is a robust measure of spread, little affected by extreme values; multiplied by 1.4826 it becomes comparable to the standard deviation.',
    inStarLight:
      'Median and MAD are the statistics StarLight uses to measure the sky background and the noise of images, because bright stars do not skew them.',
    see: ['Median', 'Standard deviation', 'Noise']
  },
  {
    term: 'Sigma clipping',
    alternatives: ['kappa-sigma', 'rejection', 'outlier rejection', 'Robust', 'Robust method', 'clipping'],
    category: 'stacking',
    definition:
      'A stacking method that, for each pixel, excludes values too far from the central value before computing the mean. It removes satellite and aircraft trails, cosmic rays and other disturbances present in few frames, while keeping almost all the signal.',
    inStarLight:
      'It is the Robust method of the Stack step, the default one. For each pixel StarLight computes the median of the frame values and their spread, discards the values that deviate from it by more than the rejection threshold (3 standard deviations initially) and averages the rest. At the end the Stack step reports the number of rejected values.',
    see: ['Rejection threshold', 'Median', 'Cosmic rays', 'Satellite trails']
  },
  {
    term: 'Rejection threshold',
    alternatives: ['clipping threshold', 'kappa', 'sigma threshold'],
    category: 'stacking',
    definition:
      'The maximum distance from the central value, expressed in standard deviations, beyond which a value is excluded by sigma clipping. A low threshold removes more disturbances but also discards part of the signal and of the normal noise; a high threshold keeps more signal but lets faint disturbances through.',
    inStarLight:
      'It is set with the Rejection threshold slider of the Combination card in the Stack step. Drizzle uses the same threshold to reject disturbances.',
    see: ['Sigma clipping', 'Standard deviation']
  },
  {
    term: 'Cosmic rays',
    alternatives: ['cosmic ray hits', 'cosmics'],
    category: 'stacking',
    definition:
      'High-energy particles that strike the sensor and leave bright dots or short streaks in a single frame. They appear in random positions, so they are not corrected with the dark but with combination methods that reject anomalous values.',
    inStarLight:
      'They are removed by the Robust and Median methods during stacking and, in the calibration masters, by combination with the median.',
    see: ['Sigma clipping', 'Median']
  },
  {
    term: 'Drizzle',
    alternatives: ['drizzling', 'drizzle 2×', 'variable-pixel linear reconstruction', 'super-resolution'],
    category: 'stacking',
    definition:
      'A stacking method that projects each pixel of the frames, shrunk to a “drop” smaller than the pixel itself, onto a finer output grid. It exploits the sub-pixel shifts between frames to recover detail that the sampling of the sensor had coarsened. It requires many frames and a slight shift between exposures.',
    inStarLight:
      'In the Stack step, 2× drizzle doubles the width and height of the result; it requires alignment to be enabled and works best with at least twenty frames or so. The result has four times as many pixels and requires more memory and more time: if memory is insufficient, stacking proceeds without drizzle and a notice appears. Pixels of the fine grid not reached by any drop are filled with regular stacking.',
    see: ['Drop size', 'Bayer drizzle', 'Alignment']
  },
  {
    term: 'Drop size',
    alternatives: ['pixfrac', 'drop shrink', 'drop'],
    category: 'stacking',
    definition:
      'The fraction of the original pixel size used as the drop in drizzle. A small drop produces sharper stars but, with few frames, leaves noise and small gaps; a drop equal to 1 gives a softer, more even result.',
    inStarLight:
      'It is set with the Drop size slider in the Drizzle card of the Stack step. A value between 0.7 and 0.8 is a good compromise.',
    see: ['Drizzle', 'Bayer drizzle']
  },
  {
    term: 'Bayer drizzle',
    alternatives: ['CFA drizzle', 'drizzle from raw data'],
    category: 'stacking',
    definition:
      'A variant of drizzle for color sensors: instead of reconstructing the color of each frame by interpolation, it deposits on the output grid only the values actually measured by each pixel in its color. The shifts between frames fill in the missing colors. It produces sharper stars and cleaner colors, at the cost of slightly higher fine noise.',
    inStarLight:
      'The Bayer drizzle option of the Stack step is available with raw frames from a color sensor that have the Bayer pattern in the header. It improves sharpness and color already at 1×, and at 2× it adds resolution. It does not apply to pre-stacked files or files already reconstructed in color, which no longer contain the color measured pixel by pixel.',
    see: ['Drizzle', 'Bayer matrix', 'Debayering']
  },
  {
    term: 'Low-coverage edges',
    alternatives: ['coverage', 'noisy edges', 'edge cropping', 'noisy border'],
    category: 'stacking',
    definition:
      'Areas at the margins of a stacked image where few frames overlap, because the field shifted or rotated during capture. They contain more noise and often a color cast, and form a border of lower quality than the rest of the image.',
    inStarLight:
      'With the Crop edges covered by few frames option of the Stack step, after stacking a crop is suggested that keeps only the part covered by at least 70% of the frames. The crop can be changed or removed in the Export step, and the image data remains intact.',
    see: ['Crop', 'Field rotation', 'Alignment']
  },
  {
    term: 'Pre-stacked image',
    alternatives: ['Stacked', 'telescope stack', 'STACKCNT', 'NCOMBINE', 'stacked file'],
    category: 'stacking',
    definition:
      'A file that already contains the combination of several frames, produced by the telescope or by a capture program. It has a better signal-to-noise ratio than a single frame but does not keep the original raw data.',
    inStarLight:
      'StarLight recognizes pre-stacked files from the number of frames declared in the header and shows the number of integrated frames and the total integration. These files are processed directly from the Process step onward and can be combined into a mosaic; they are not suitable for Bayer drizzle.',
    see: ['Total integration', 'Mosaic', 'Bayer drizzle']
  },
  {
    term: 'Live session',
    alternatives: ['live stacking', 'watched folder', 'live'],
    category: 'stacking',
    definition:
      'A way of working in which each new frame is aligned and added to the stacked image during capture itself, so that the result improves as the session goes on.',
    inStarLight:
      'The live session of the Stack step watches the folder where the capture program saves the frames, even if it is a network folder. It accepts FITS (including compressed), XISF and RAW files; it waits until each file is complete, analyzes it, aligns it and recomputes the stack. The Include existing frames option also adds the frames saved before the start. The suggested folder is set in Settings, on the Telescope tab.',
    see: ['Stacking', 'Frame quality', 'Low-coverage edges']
  },
  {
    term: 'Mosaic',
    alternatives: ['panels', 'panel', 'tiles'],
    category: 'stacking',
    definition:
      'An image made of several framings of adjacent areas of the sky, called panels, joined into a field wider than that of the instrument. The panels must partly overlap, because the common areas are used to match their position, background and brightness.',
    inStarLight:
      'The mosaic of the Stack step places each panel using its own astrometric solution, read from the file or computed with the Plate solve command. Sky background and brightness are matched in the overlapping areas, channel by channel and ignoring the stars, and the edges are blended without visible seams. The resolution is that of the most detailed panel. The recommended overlap is 10-20%.',
    see: ['Astrometric solution', 'Plate solving', 'Sky background']
  },
  {
    term: 'Comet nucleus alignment',
    alternatives: ['comet', 'comet fixed', 'comet stacking', 'comet alignment'],
    category: 'stacking',
    definition:
      'A stacking technique for comets, which move relative to the stars during capture. Aligning the frames on the stars makes the comet appear elongated; aligning them on the comet’s nucleus makes the comet sharp and turns the stars into streaks.',
    inStarLight:
      'The Comet card of the Stack step offers three choices: Still stars (regular stacking), Still comet (alignment on the nucleus) and Both, which extracts the comet alone from the stack aligned on the nucleus, removes it from the frames, stacks the frames on the stars and finally puts the comet back on top. The nucleus is found automatically as an extended bright spot moving at constant speed, using the capture time of the files, or it can be indicated with a click on the first and last frame. Drizzle applies only with Still comet.',
    see: ['Nucleus, coma and tail', 'Alignment', 'Sigma clipping']
  },
  {
    term: 'Nucleus, coma and tail',
    alternatives: ['nucleus', 'coma', 'tail', 'comet coma'],
    category: 'stacking',
    definition:
      'The parts of a comet. The nucleus is the solid body, which in images corresponds to the brightest point; the coma is the diffuse cloud of gas and dust that surrounds it; the tail is the stream of gas and dust pushed in the direction away from the Sun.',
    inStarLight:
      'Comet nucleus alignment uses the nucleus as reference; its position, measured or derived from its regular motion, is reported for each frame in the Comet card.',
    see: ['Comet nucleus alignment']
  },

  // ---------------------------------------------------------------- Processing
  {
    term: 'Linear data',
    alternatives: ['linear frame', 'linear image', 'linear'],
    category: 'processing',
    definition:
      'An image in which each value is proportional to the light collected by the pixel, as it comes out of the sensor and of stacking. Deep-sky signal occupies a tiny fraction of the scale, so on screen the image looks almost black. Many operations, such as calibration, background extraction, color balance and deconvolution, are correct only on linear data.',
    inStarLight:
      'The Process step gathers the tools that work on data that is still linear; the stretch, in the Correct step, is applied afterward. The viewer nevertheless shows the stretched image, so that it is readable.',
    see: ['Stretch', 'Histogram']
  },
  {
    term: 'Stretch',
    alternatives: ['stretching', 'histogram stretch', 'non-linear transformation'],
    category: 'processing',
    definition:
      'A non-linear transformation that brightens the faint tones of a linear image and compresses the bright ones, making nebulae and galaxies visible without clipping the stars to white. After the stretch the data is no longer proportional to the light collected.',
    inStarLight:
      'The Stretch card of the Correct step offers two curves: Midtones, with black point, midtones and white point, and the generalized hyperbolic stretch (GHS). The Auto button computes black point and midtones from the sky background with three strength levels: Gentle, Balanced and Strong. The Preserve color option applies the stretch to the luminance without changing the ratio between channels.',
    see: ['Black point', 'Midtones', 'White point', 'GHS', 'Linear data']
  },
  {
    term: 'Black point',
    alternatives: ['black level', 'shadows'],
    category: 'processing',
    definition:
      'The level below which all values become pure black. Raising it darkens the sky background and hides background noise, but the faintest signal is lost as well.',
    inStarLight:
      'It is set with the Black point slider of the Stretch card in the Correct step; the Auto button places it just below the measured sky background.',
    see: ['Stretch', 'White point', 'Histogram']
  },
  {
    term: 'White point',
    alternatives: ['white level', 'highlights'],
    category: 'processing',
    definition:
      'The level above which all values become pure white. Lowering it increases contrast, but stars and the brightest areas lose detail.',
    inStarLight:
      'It is set with the White point slider of the Stretch card in the Correct step. Abracadabra keeps it at the top of the scale, so that white remains reserved for bright stars.',
    see: ['Stretch', 'Black point', 'Saturated pixels']
  },
  {
    term: 'Midtones',
    alternatives: ['MTF', 'midtones transfer function', 'midtone transfer function', 'midtone'],
    category: 'processing',
    definition:
      'The stretch parameter that sets where the average brightness of the image falls. The curve used, called the midtones transfer function (MTF), leaves the image unchanged at a value of 0.5 and brightens faint tones more and more as the value decreases.',
    inStarLight:
      'It is the Midtones slider of the Stretch card in the Correct step: low values bring out faint nebulae. The Auto button computes it from the sky background.',
    see: ['Stretch', 'Black point', 'GHS']
  },
  {
    term: 'GHS',
    alternatives: ['generalized hyperbolic stretch', 'Generalized Hyperbolic Stretch', 'hyperbolic', 'symmetry point'],
    category: 'processing',
    definition:
      'Abbreviation of Generalized Hyperbolic Stretch. It is a family of stretch curves that concentrates the contrast increase around a chosen brightness level, called the symmetry point, and optionally protects shadows and highlights. It makes it possible, for example, to bring out the faint arms of a galaxy without clipping its core to white.',
    inStarLight:
      'It is selected with the Hyperbolic (GHS) option of the Stretch card in the Correct step, with the Strength, Local intensity, Symmetry point, Shadow protection and Highlight protection sliders. Abracadabra uses GHS for the automatic stretch.',
    see: ['Stretch', 'Midtones', 'Abracadabra']
  },
  {
    term: 'Histogram',
    alternatives: ['levels'],
    category: 'processing',
    definition:
      'A chart showing how many pixels have each brightness value, from black on the left to white on the right. In a linear astronomical image almost all pixels are crowded at the far left; after a good stretch the sky background peak moves toward the first quarter of the scale.',
    inStarLight:
      'The viewer shows a compact histogram of the image as it appears, after all adjustments and the photo filter. The curves editor shows in the background the histogram of the levels the curve receives. It helps check that faint signal is not being clipped and that stars are not being pushed to white.',
    see: ['Stretch', 'Curves', 'Black point']
  },
  {
    term: 'Curves',
    alternatives: ['tone curve', 'RGB curves', 'S-curve'],
    category: 'processing',
    definition:
      'A chart that maps each input brightness level to an output level. The diagonal leaves the image unchanged; a higher curve brightens, a lower one darkens; an S-shaped curve increases contrast by darkening the shadows and brightening the highlights. Applied to a single channel it corrects color casts.',
    inStarLight:
      'The Curves card of the Correct step acts on luminance or on the individual R, G and B channels. A click adds a point, dragging moves it and a right-click removes it. With the Preserve color option enabled, the individual channel curves have no effect.',
    see: ['Histogram', 'Gamma', 'Color cast']
  },
  {
    term: 'Gamma',
    alternatives: ['gamma correction'],
    category: 'processing',
    definition:
      'The parameter of a power curve that brightens or darkens the midtones while leaving black and white unchanged.',
    inStarLight:
      'It is set with the Gamma slider of the Tones card in the Correct step; below 1 it darkens the midtones, above 1 it brightens them.',
    see: ['Curves', 'Midtones']
  },
  {
    term: 'Sky background',
    alternatives: ['background', 'sky level', 'background level'],
    category: 'processing',
    definition:
      'Diffuse light present throughout the image, independent of the objects imaged, caused by light pollution, the Moon, the natural airglow and zodiacal light. It often varies from one side of the field to the other and adds a color cast.',
    inStarLight:
      'The Import step indicates the background level with the median of the pixels. Background variations are corrected with background extraction in the Process step; the mean level and its color with background removal in the Filters step. The Auto button of the stretch is based on the measured background.',
    see: ['Gradient', 'Background extraction', 'Background removal', 'Light pollution']
  },
  {
    term: 'Gradient',
    alternatives: ['brightness gradient', 'background variation', 'uneven background'],
    category: 'processing',
    definition:
      'A gradual change in the brightness of the sky background from one area of the image to another, typically brighter on the side facing a city or the Moon. It makes it difficult to stretch the image evenly.',
    inStarLight:
      'Gradients are corrected with background extraction in the Defects and sky background card of the Process step. A local adjustment with a Gradient mask can compensate for a side that remains brighter.',
    see: ['Sky background', 'Background extraction', 'Local adjustments']
  },
  {
    term: 'Background extraction',
    alternatives: ['gradient removal', 'background model', 'radial basis functions', 'RBF', 'background subtraction'],
    category: 'processing',
    definition:
      'A procedure that estimates the shape of the sky background from samples taken in areas free of objects and subtracts it from the image, making the background even and neutral in color. It must be performed on linear data, before the stretch.',
    inStarLight:
      'In the Defects and sky background card of the Process step, Simple mode describes the background with a smooth surface, suited to regular gradients; Advanced mode uses radial basis functions, which also follow halos and irregular variations, with the Samples per side, Smoothness and Tolerance sliders. Samples too different from the model are considered part of the object and discarded.',
    see: ['Sky background', 'Gradient', 'Background removal', 'Linear data']
  },
  {
    term: 'Noise reduction',
    alternatives: ['denoise', 'denoising', 'NR'],
    category: 'processing',
    definition:
      'A set of techniques that reduce the graininess of the image while trying to preserve details and edges. Excessive use produces an artificial look and erases faint stars and fine structures.',
    inStarLight:
      'The Process step offers NL-Bayes and wavelets, by scale; the Color noise slider acts only on chrominance noise. The Filters step contains a noise reduction that averages neighboring pixels only where they have similar brightness; at high strength the area considered grows and also dissolves blotchy noise. Local adjustments apply noise reduction to a single area.',
    see: ['NL-Bayes', 'Wavelets', 'Color noise', 'Noise']
  },
  {
    term: 'NL-Bayes',
    alternatives: ['Non-Local Bayes', 'non-local'],
    category: 'processing',
    definition:
      'A noise reduction method that, for each small area of the image, looks for similar areas in the surroundings and statistically estimates their noise-free content. It preserves edges and details better than a simple blur.',
    inStarLight:
      'It is the NL-Bayes slider of the Noise reduction card in the Process step. It partly leaves blotchy noise a few pixels wide, which is handled with the wavelets.',
    see: ['Noise reduction', 'Wavelets']
  },
  {
    term: 'Wavelets',
    alternatives: ['wavelet', 'wavelet transform', 'multiscale decomposition', 'scales'],
    category: 'processing',
    definition:
      'A method that decomposes the image into layers of different sizes, from single-pixel details to structures tens of pixels across, so that each can be treated separately: noise can be reduced at one scale and details enhanced at another.',
    inStarLight:
      'StarLight decomposes the image into five scales, from 1 to 16 pixels. In the Noise reduction card one slider per scale reduces the noise of that size; in the Detail by scale card one slider per scale enhances or softens the corresponding details.',
    see: ['Detail by scale', 'NL-Bayes', 'Noise reduction']
  },
  {
    term: 'Detail by scale',
    alternatives: ['multiscale sharpening', 'multiscale enhancement', 'multiscale'],
    category: 'processing',
    definition:
      'An adjustment that enhances or softens details of a given size. Small scales correspond to noise and thin filaments, large ones to galaxy arms and clouds.',
    inStarLight:
      'The Detail by scale card of the Process step has five sliders, from 1 to 16 pixels, and uses the same decomposition as the wavelets.',
    see: ['Wavelets', 'Sharpening']
  },
  {
    term: 'Sharpening',
    alternatives: ['sharpness', 'unsharp mask', 'USM'],
    category: 'processing',
    definition:
      'The enhancement of fine details, usually obtained by subtracting a blurred version of the image from the image itself. Excessive use produces dark halos around stars and amplifies noise.',
    inStarLight:
      'The Filters step contains a Sharpening slider based on this principle. Local adjustments apply sharpening to a single area. To recover sharpness lost to turbulence and optics, deconvolution is more appropriate.',
    see: ['Deconvolution', 'Detail by scale', 'Local contrast']
  },
  {
    term: 'PSF',
    alternatives: ['Point Spread Function', 'point spread function', 'star profile'],
    category: 'processing',
    definition:
      'Abbreviation of Point Spread Function. It describes the shape in which a point source, such as a star, appears in the image after passing through the atmosphere and the optics. It is measured on stars and sums up their sharpness.',
    inStarLight:
      'Deconvolution uses a PSF estimated from the shape of the stars in the image, starting from their HFR, when the blur size is not set manually.',
    see: ['Deconvolution', 'HFR', 'FWHM']
  },
  {
    term: 'Deconvolution',
    alternatives: ['Richardson-Lucy', 'deblur'],
    category: 'processing',
    definition:
      'A computation that partly reverses the blur produced by the atmosphere and the optics, based on the PSF. It does not add details, but restores those that were softened. Excessive use produces dark halos around stars and graininess.',
    inStarLight:
      'The Deconvolution card of the Process step uses the Richardson-Lucy method. The Iterations slider sets how many times the computation is repeated; with Blur size at zero the size is measured on the stars; Regularization limits noise amplification.',
    see: ['PSF', 'Sharpening', 'Seeing']
  },
  {
    term: 'Local contrast',
    alternatives: ['CLAHE', 'adaptive equalization', 'local contrast enhancement'],
    category: 'processing',
    definition:
      'A contrast increase computed tile by tile rather than over the whole image, which brings out the internal structures of galaxies and nebulae. The CLAHE method (contrast limited adaptive histogram equalization) divides the image into tiles and limits the maximum contrast of each so as not to amplify noise too much.',
    inStarLight:
      'The Local contrast card of the Process step has the Strength, Limit and Tiles per side sliders; a larger number of tiles follows smaller structures. The HDR plugin offers a local contrast boost limited to bright areas.',
    see: ['Histogram', 'HDR, recovery of the bright areas', 'Sharpening']
  },
  {
    term: 'Star reduction',
    alternatives: ['smaller stars', 'star shrinking', 'star size reduction'],
    category: 'processing',
    definition:
      'Processing that shrinks stars and dims their light, to give prominence back to nebulae and galaxies in very star-rich fields.',
    inStarLight:
      'The Star reduction card of the Process step has the Size and Brightness sliders. The method warps the image around each star, like a shrinking lens, and fills the freed ring with the surrounding background while preserving its grain; it does not use neural networks. The Star and nebula separation plugin offers an alternative based on layer separation.',
    see: ['Star and nebula separation', 'Mask']
  },
  {
    term: 'Satellite trails',
    alternatives: ['trails', 'satellites', 'aircraft', 'streaks', 'plane trails'],
    category: 'processing',
    definition:
      'Bright lines left in the image by satellites and aircraft crossing the field during the exposure. Satellite trails are straight and may break off when the satellite enters the Earth’s shadow; aircraft trails often form rows of dashes because of flashing lights.',
    inStarLight:
      'During stacking, trails are removed by sigma clipping. On a single image, the Remove trails switch of the Process step detects straight lines that are very long and as wide as a star, even if broken, and rebuilds their pixels with the sky and grain of both sides. With an astrometric solution, the galaxies and nebulae of the catalog are left out. The Sensitivity slider controls the detection of faint trails.',
    see: ['Sigma clipping', 'Stacking']
  },
  {
    term: 'Abracadabra',
    alternatives: ['automatic processing', 'magic wand', 'automatic', 'auto'],
    category: 'processing',
    definition:
      'The StarLight command that prepares the image automatically, measuring it and choosing the adjustments with conservative criteria. The result is a starting point, not a final edit.',
    inStarLight:
      'The Abracadabra button, in the top bar, sets the tools of the Process step, runs the computation, sets in the Correct step the hyperbolic stretch (GHS), saturation and color preservation, and suggests cropping the noisy edges. A notice summarizes the corrections made; all values remain editable and the Reset button returns the image to the original. Batch processing can apply the same procedure to each file.',
    see: ['GHS', 'Batch processing', 'History']
  },
  {
    term: 'Local adjustments',
    alternatives: ['local adjustment', 'local corrections', 'selective adjustments'],
    category: 'processing',
    definition:
      'Corrections applied only to part of the image, delimited by a mask, rather than to the whole image. They make it possible, for example, to brighten the faint areas of a nebula without blowing out its core.',
    inStarLight:
      'The Local adjustments card of the Correct step manages up to four adjustments, each with its own mask and the brightness, contrast, saturation, vibrance, temperature, tint, sharpness and noise reduction sliders. They are applied after all other corrections, are included in the exported image and are saved in the project.',
    see: ['Mask']
  },
  {
    term: 'Mask',
    alternatives: ['luminance mask', 'color mask', 'star mask', 'brush', 'eraser'],
    category: 'processing',
    definition:
      'An auxiliary image that determines, pixel by pixel, how strongly a correction acts: fully where the mask is white, not at all where it is black, partially in the intermediate areas. The most common masks select a brightness range, a color or the stars.',
    inStarLight:
      'Local adjustments offer six automatic masks (Light, Color, Stars, Object, Gradient and Circle), with edge feathering, intensity and the Invert the mask command, as well as a brush and an eraser to paint the area by hand. The Show the mask in red command highlights where the adjustment acts.',
    see: ['Local adjustments']
  },
  {
    term: 'Crop',
    alternatives: ['cropping', 'framing', 'trim'],
    category: 'processing',
    definition:
      'The removal of the outer parts of the image, to eliminate defective edges or improve the composition.',
    inStarLight:
      'The crop box is set in the Export step or directly on the viewer with the Crop button of the top bar. The crop applies to the export and does not change the image data; it can keep the aspect ratio of a preset. Abracadabra and stacking suggest one that excludes the noisy edges.',
    see: ['Low-coverage edges', 'Abracadabra', 'Straightening']
  },
  {
    term: 'Straightening',
    alternatives: ['straighten', 'free rotation', 'rotate', 'north up', 'orientation'],
    category: 'processing',
    definition:
      'The rotation of the image by any angle, to correct a crooked framing or to orient it in a conventional way, for example with celestial north at the top. A rotation that is not a multiple of 90° requires every pixel to be recomputed by interpolation and leaves the corners of the canvas uncovered.',
    inStarLight:
      'The ⟲ and ⟳ buttons above the viewer rotate by 90° without recomputing the pixels. The Straighten button opens a panel with the free angle (instant preview, computation with Apply), the Draw a line command, which derives the angle from a line drawn along a horizontal or vertical feature, and the North up command, available with an astrometric solution. The rotation is always computed from the unrotated image, with bicubic interpolation, so adjusting it again does not degrade the data; the Crop empty edges option sets the crop to the largest rectangle without uncovered corners. Markers, masks, crop and astrometric solution follow the rotation, which can be undone with Undo and is saved in the project.',
    see: ['Crop', 'Astrometric solution', 'Mirroring']
  },
  {
    term: 'Mirroring',
    alternatives: ['mirror', 'flip', 'mirrored image', 'rotate and flip'],
    category: 'processing',
    definition:
      'Flipping the image left to right or top to bottom, without loss of quality. Some optical systems, for example those with a mirror diagonal, and some capture programs produce images that are mirrored relative to the sky: mirroring restores them as they appear in the sky, with east on the left when north is at the top.',
    inStarLight:
      'The two Mirror buttons of the top bar, next to ⟲ and ⟳, flip the image left to right or top to bottom by moving the pixels without recomputing them. The mirroring also applies to the export, can be undone with Undo and is saved in the project. Markers, local adjustment masks, crop and astrometric solution follow it: in the solution, mirroring reverses the direction of east relative to north. Mirroring and rotations are always applied in the same order, mirroring first, then quarter turns, and finally the Straighten angle, but the buttons always act on the image as it appears on screen.',
    see: ['Straightening', 'Astrometric solution']
  },

  // ---------------------------------------------------------------- Color
  {
    term: 'Color channel',
    alternatives: ['channels', 'RGB', 'R', 'G', 'B', 'red green blue'],
    category: 'color',
    definition:
      'Each of the three components, red, green and blue, of a color image. Each channel is a monochrome image that records the light in a range of wavelengths.',
    inStarLight:
      'Many tools act on the channels separately: the R, G and B curves, the channel gains, background removal and the Black and white by channel plugin.',
    see: ['Channel gains', 'Curves', 'Black and white by channel']
  },
  {
    term: 'White balance',
    alternatives: ['star-based balance', 'color balance'],
    category: 'color',
    definition:
      'The correction of the ratios between color channels so that a reference considered neutral appears white or gray. In astrophotography the reference can be the average color of the stars or the measured color of known stars.',
    inStarLight:
      'In the Color card of the Process step, the On the stars balance makes the average color of the stars in the field white; the Photometric balance uses the colors measured by the Gaia catalog and is the most accurate method.',
    see: ['Photometric color calibration', 'Color cast', 'Channel gains']
  },
  {
    term: 'Photometric color calibration',
    alternatives: ['photometric balance', 'photometric', 'color calibration', 'color from Gaia', 'PCC', 'SPCC'],
    category: 'color',
    definition:
      'A color balance based on the real colors of stars, measured by a photometric catalog. The expected color of many stars in the field is compared with the color measured in the image, and the gains of the three channels that make the two sets as consistent as possible are derived. The neutral reference is a Sun-like star (spectral type G2V).',
    inStarLight:
      'It is obtained with the Photometric balance of the Color card and the Compute from Gaia button. The stars of the Gaia catalog are projected onto the image with the astrometric solution and matched to the detected ones; the light of unsaturated stars is measured with aperture photometry and the gains are computed with a robust fit and applied around the sky background, which stays neutral. It requires an internet connection and an astrometric solution; it is not meaningful on narrowband images.',
    see: ['Gaia catalog', 'Photometry', 'Color index', 'Astrometric solution']
  },
  {
    term: 'Photometry',
    alternatives: ['aperture photometry'],
    category: 'color',
    definition:
      'The measurement of the amount of light received from a star or an object. In aperture photometry the light within a circle around the star is summed and the local background, measured in a surrounding ring, is subtracted.',
    inStarLight:
      'Aperture photometry is used by photometric color calibration, separately in the three channels, on unsaturated stars.',
    see: ['Photometric color calibration', 'Magnitude']
  },
  {
    term: 'Color index',
    alternatives: ['BP-RP', 'star color', 'spectral type', 'G2V'],
    category: 'color',
    definition:
      'The difference between the magnitudes of a star measured in two color bands. It indicates the temperature of the star: hot stars are bluish and have a low index, cool stars are orange and have a high index. The Gaia catalog provides the BP-RP index, between the blue and the red band of the satellite.',
    inStarLight:
      'Photometric color calibration uses the BP-RP index of the Gaia stars to establish how red or blue each one should appear.',
    see: ['Photometric color calibration', 'Gaia catalog', 'Magnitude']
  },
  {
    term: 'Color cast',
    alternatives: ['cast', 'greenish background', 'reddish background', 'tint'],
    category: 'color',
    definition:
      'An unwanted uniform coloring that affects the whole image or only the sky background, caused for example by light pollution, the response of the sensor or light pollution filters.',
    inStarLight:
      'It is corrected with the white balance of the Process step, with background removal in the Filters step, and with the channel gains and individual channel curves of the Correct step. The Green removal plugin specifically treats a green cast.',
    see: ['White balance', 'Background removal', 'Channel gains', 'Green removal']
  },
  {
    term: 'Background removal',
    alternatives: ['background neutralization', 'color neutralization', 'neutral background'],
    category: 'color',
    definition:
      'A correction that brings the sky background to a neutral color by subtracting from each channel its own background level. Unlike background extraction, it acts uniformly across the whole image and does not correct variations from one area to another.',
    inStarLight:
      'The Background removal slider of the Filters step subtracts from each channel a constant level equal to the measured sky background; the black point is lowered by the same average amount, so overall brightness stays unchanged and only the balance between the background colors changes.',
    see: ['Sky background', 'Background extraction', 'Color cast']
  },
  {
    term: 'Channel gains',
    alternatives: ['red gain', 'green gain', 'blue gain', 'channel multipliers'],
    category: 'color',
    definition:
      'Multiplicative factors applied separately to the red, green and blue channels to change their balance.',
    inStarLight:
      'The Red gain, Green gain and Blue gain sliders of the Color card in the Correct step correct color casts, for example the greenish background left by light pollution filters. Photometric calibration computes similar gains automatically.',
    see: ['Color cast', 'Gain', 'Photometric color calibration']
  },
  {
    term: 'Color noise',
    alternatives: ['chroma noise', 'chrominance noise', 'color blotches'],
    category: 'color',
    definition:
      'The noise component that shows up as random color blotches, especially in the sky background, rather than as variations in brightness.',
    inStarLight:
      'The Color noise slider of the Color card in the Process step removes color blotches from the background and evens out the color of each star, without changing sharpness. With narrowband it only sets how far the background turns neutral gray.',
    see: ['Noise', 'Noise reduction']
  },
  {
    term: 'Saturation',
    alternatives: ['color saturation'],
    category: 'color',
    definition:
      'The intensity of colors, that is, their distance from the gray of the same brightness. Increasing it makes colors more vivid; reducing it to the minimum produces a black and white image. The term is not to be confused with saturated sensor pixels.',
    inStarLight:
      'It is set with the Saturation slider of the Color card in the Correct step; at −1 the image becomes black and white. Abracadabra doses it according to the measured color noise. Local adjustments and the Star and nebula separation plugin adjust it on individual parts of the image.',
    see: ['Vibrance', 'Saturated pixels']
  },
  {
    term: 'Vibrance',
    alternatives: ['vividness'],
    category: 'color',
    definition:
      'A selective increase in saturation that acts mainly on muted colors and leaves already strong ones almost unchanged, avoiding excessive color in areas that are already saturated.',
    inStarLight:
      'It is set with the Vibrance slider of the Color card in the Correct step, which adds color to nebulae without oversaturating colored stars. The value adds to the vibrance built into the chosen photo filter.',
    see: ['Saturation', 'Photo filter']
  },
  {
    term: 'Color preservation',
    alternatives: ['preserve color', 'luminance stretch', 'color preserving stretch'],
    category: 'color',
    definition:
      'A way of applying the stretch to luminance only, keeping the ratio between red, green and blue of each pixel constant. It prevents bright stars and nebulae from losing color and turning white.',
    inStarLight:
      'It is the Preserve color option of the Stretch card in the Correct step, enabled automatically by Abracadabra. With this option the individual channel curves have no effect.',
    see: ['Stretch', 'Curves', 'Abracadabra']
  },
  {
    term: 'Palette',
    alternatives: ['color palette', 'color mapping'],
    category: 'color',
    definition:
      'In narrowband imaging, the convention by which the emission lines of the different gases are assigned to the red, green and blue channels. The resulting colors do not match what the eye would see, but they make the distribution of the gases readable.',
    inStarLight:
      'The Narrowband card of the Process step offers the HOO, Foraxx and synthetic Hubble palettes, with previews; the Natural palette leaves the colors unchanged. The Stars in their own color option keeps the original color of the stars.',
    see: ['HOO', 'Foraxx', 'Hubble palette', 'Narrowband']
  },
  {
    term: 'HOO',
    alternatives: ['bicolor', 'Ha-OIII-OIII'],
    category: 'color',
    definition:
      'A narrowband palette that assigns hydrogen (H) to red and oxygen (O) to green and blue. The name indicates the gas of each of the three channels. Hydrogen-rich areas appear red, oxygen-rich areas cyan.',
    inStarLight:
      'It is the palette recommended by the Narrowband card when the header indicates a dual-band filter.',
    see: ['Palette', 'H-alpha', 'OIII', 'Dual-band filter']
  },
  {
    term: 'Foraxx',
    alternatives: ['Foraxx palette'],
    category: 'color',
    definition:
      'A narrowband palette derived from HOO: where hydrogen and oxygen are both strong, green follows hydrogen, and golden transitions appear between red and cyan.',
    inStarLight:
      'It is available in the Narrowband card of the Process step.',
    see: ['Palette', 'HOO']
  },
  {
    term: 'Hubble palette',
    alternatives: ['SHO', 'synthetic Hubble', 'SHO palette'],
    category: 'color',
    definition:
      'A palette made famous by the images of the Hubble Space Telescope, which assigns sulfur (S) to red, hydrogen (H) to green and oxygen (O) to blue, with the typical contrast between gold and blue. It requires images taken with three filters, including one for sulfur.',
    inStarLight:
      'The synthetic Hubble palette of the Narrowband card imitates its look using only the lines collected by the dual-band filter: in place of sulfur it reuses hydrogen, so it does not show where sulfur is located.',
    see: ['Palette', 'SII', 'HOO']
  },
  {
    term: 'Photo filter',
    alternatives: ['photo filters', 'look', 'preset', 'style', 'sepia', 'false color'],
    category: 'color',
    definition:
      'An aesthetic transformation of the colors and tones of an already processed image, which does not correct defects but changes its rendering, from sepia to false color.',
    inStarLight:
      'The Filters step offers twenty-four photo filters, with the Filter intensity slider. Filters are applied after the stretch, do not change the file data and can be changed or removed at any time. Some include their own vibrance and vignette.',
    see: ['Vignetting', 'Vibrance', 'Filter']
  },

  // ---------------------------------------------------------------- Astrometry and catalogs
  {
    term: 'Astrometric solution',
    alternatives: ['astrometry', 'astrometric calibration', 'WCS solution'],
    category: 'astrometry',
    definition:
      'The exact correspondence between the pixels of the image and sky coordinates: for each pixel it gives right ascension and declination. It includes the position of the center, the scale, the orientation and, sometimes, the distortion of the optics. It is written to the file header according to the WCS standard.',
    inStarLight:
      'With an astrometric solution StarLight marks catalog objects on the image, computes photometric color calibration, places the panels of a mosaic and excludes galaxies and nebulae from trail removal. It is read from the header or computed with the Plate solve command; rotations and mirroring done with the buttons of the top bar update it.',
    see: ['WCS', 'Plate solving', 'Object markers']
  },
  {
    term: 'WCS',
    alternatives: ['World Coordinate System', 'CRVAL', 'CRPIX', 'CD', 'SIP', 'SIP distortion'],
    category: 'astrometry',
    definition:
      'Abbreviation of World Coordinate System: a set of standard keywords (CRVAL, CRPIX, CD and others) with which the astrometric solution is written to the header of a FITS file. The SIP convention adds the coefficients that describe the distortion of the optics.',
    inStarLight:
      'StarLight reads the WCS of the files that contain it and computes the solution, including a small SIP distortion correction, for those that lack it.',
    see: ['Astrometric solution', 'Header', 'FITS']
  },
  {
    term: 'Plate solving',
    alternatives: ['plate solve', 'Plate solve', 'solving', 'astrometric solving', 'field solving'],
    category: 'astrometry',
    definition:
      'The computation of the astrometric solution by comparing the stars in the image with those of a catalog. Star patterns with the same shape are searched for in the image and in the catalog; when a match makes many stars coincide, the solution is refined with least squares.',
    inStarLight:
      'The Plate solve button of the Objects step compares star triangles in the image with the stars of a catalog around the declared position; the file header must contain the pointing coordinates or the name of the object. If the Stars for plate solving package is installed and enabled, StarLight uses those stars first, without internet and in a few seconds. If they are not enough, usually because the field is narrow and contains few stars down to magnitude 12, it moves on to the online Gaia catalog, only if internet access is allowed; the request can take up to a minute. With internet turned off, a notice explains why the local stars were not enough and offers the Turn internet back on button, which enables the setting and tries again. The progress message indicates the source in use: local stars or the online Gaia catalog.',
    see: ['Astrometric solution', 'Local stars', 'Gaia catalog', 'Image scale']
  },
  {
    term: 'Gaia catalog',
    alternatives: ['Gaia', 'Gaia DR3', 'ESA Gaia'],
    category: 'astrometry',
    definition:
      'The catalog produced by the Gaia space mission of the European Space Agency, with the position, brightness and color of more than a billion stars. It is the most accurate reference available today for stellar astrometry and photometry.',
    inStarLight:
      'StarLight queries the Gaia DR3 catalog over the internet for photometric color calibration and for plate solving, in the latter case when the local stars are not installed or are not enough, only if internet access is allowed in Settings (Network and catalogs tab), where the limiting magnitude of the requested stars is also set. Sky areas already downloaded stay in memory until the program is closed.',
    see: ['Plate solving', 'Photometric color calibration', 'Magnitude', 'Color index']
  },
  {
    term: 'Local stars',
    alternatives: ['UCAC4', 'UCAC4 catalog', 'Stars for plate solving', 'offline plate solving', 'plate solving without internet'],
    category: 'astrometry',
    definition:
      'A star catalog stored on the computer, used as a reference for plate solving without connecting to the internet. UCAC4 is the fourth astrometric catalog of the U.S. Naval Observatory (Zacharias et al., 2013): positions and proper motions of about 113 million stars, measured in a band between green and red.',
    inStarLight:
      'The Stars for plate solving package, in the Deep-sky catalogs tab of the plugin gallery, contains the UCAC4 stars down to magnitude 12 with positions updated to 2025 based on proper motion, that is, the slow apparent movement of each star. It is not part of the installation: it is downloaded once and can be enabled, disabled and uninstalled like the other catalogs. When it is enabled, Plate solve uses it first; for narrow fields, where stars down to magnitude 12 are few, the online Gaia catalog is needed.',
    see: ['Plate solving', 'Gaia catalog', 'Additional deep-sky catalogs', 'Magnitude']
  },
  {
    term: 'Image scale',
    alternatives: ['pixel scale', 'plate scale', 'arcseconds per pixel', 'angular resolution', '″/px'],
    category: 'astrometry',
    definition:
      'The portion of sky covered by a single pixel, in arcseconds. It is computed as 206.265 × pixel size in micrometers ÷ focal length in millimeters: with a focal length of 250 mm and 2.9 µm pixels it is about 2.4″ per pixel.',
    inStarLight:
      'StarLight derives it from the astrometric solution, when present, or from the focal length and pixel size declared in the file; it is shown in the Import step and serves as a hint for plate solving.',
    see: ['Focal length', 'Pixel', 'Arcsecond', 'Field of view']
  },
  {
    term: 'Field of view',
    alternatives: ['FOV', 'framed field', 'framing'],
    category: 'astrometry',
    definition:
      'The portion of sky captured in the image, usually expressed in arcminutes per side. It depends on the focal length and on the dimensions of the sensor.',
    inStarLight:
      'The Objects step reports its dimensions and, under Other objects in the field, lists the catalog objects whose coordinates fall within the framing.',
    see: ['Image scale', 'Arcminute', 'Focal length']
  },
  {
    term: 'Right ascension',
    alternatives: ['RA', 'AR', 'α'],
    category: 'astrometry',
    definition:
      'The celestial coordinate equivalent to longitude, measured eastward along the celestial equator from the vernal point. It is expressed in hours, minutes and seconds (from 0 to 24 hours) or in degrees.',
    inStarLight:
      'The pointing right ascension is read from the header and shown in the Import step; it is used to identify the object and as the starting point for plate solving.',
    see: ['Declination', 'J2000', 'Astrometric solution']
  },
  {
    term: 'Declination',
    alternatives: ['Dec', 'DEC', 'δ'],
    category: 'astrometry',
    definition:
      'The celestial coordinate equivalent to latitude: the angular distance of a point from the celestial equator, from +90° at the north celestial pole to −90° at the south pole.',
    inStarLight:
      'The pointing declination is read from the header and shown in the Import step, together with the right ascension.',
    see: ['Right ascension', 'J2000']
  },
  {
    term: 'J2000',
    alternatives: ['J2000 epoch', 'J2000 equinox', 'precession', 'J2000.0'],
    category: 'astrometry',
    definition:
      'The reference system for celestial coordinates fixed at 1 January 2000. Coordinates change slowly over time because of the precession of the Earth’s axis, so catalogs and astrometric solutions state the epoch they refer to.',
    inStarLight:
      'The object catalog and plate solving use J2000 coordinates; pointing coordinates referred to the date of capture are converted to J2000 before the comparison.',
    see: ['Right ascension', 'Declination']
  },
  {
    term: 'Arcminute',
    alternatives: ['arcmin', 'minute of arc', '′'],
    category: 'astrometry',
    definition:
      'A unit of angle equal to one sixtieth of a degree. The full Moon measures about thirty arcminutes.',
    inStarLight:
      'The apparent sizes of objects and of the field of view, in the Objects step, are expressed in arcminutes.',
    see: ['Arcsecond', 'Field of view']
  },
  {
    term: 'Arcsecond',
    alternatives: ['arcsec', 'second of arc', '″'],
    category: 'astrometry',
    definition:
      'A unit of angle equal to one sixtieth of an arcminute, that is, 1/3600 of a degree. It is used for the image scale and for the size of stars.',
    inStarLight:
      'The image scale is expressed in arcseconds per pixel.',
    see: ['Arcminute', 'Image scale']
  },
  {
    term: 'Magnitude',
    alternatives: ['mag', 'apparent magnitude', 'limiting magnitude', 'apparent brightness'],
    category: 'astrometry',
    definition:
      'A logarithmic measure of the apparent brightness of an object: the lower the number, the brighter the object, and every 5 magnitudes the brightness changes by a factor of 100. With the naked eye, under a dark sky, stars down to about the sixth magnitude are visible. The limiting magnitude is that of the faintest objects considered.',
    inStarLight:
      'The Objects step reports the magnitude of the main object. In Settings, on the Network and catalogs tab, the limiting magnitude of the Gaia catalog sets how faint the stars requested for photometric calibration can be.',
    see: ['Gaia catalog', 'Photometry', 'Color index']
  },
  {
    term: 'Constellation',
    alternatives: ['constellations'],
    category: 'astrometry',
    definition:
      'Each of the 88 regions into which the International Astronomical Union divides the celestial sphere. It indicates in which area of the sky an object lies.',
    inStarLight:
      'The Objects step indicates the constellation of the main object.',
    see: ['Deep-sky object']
  },
  {
    term: 'Deep-sky object',
    alternatives: ['deep sky', 'DSO'],
    category: 'astrometry',
    definition:
      'An astronomical object outside the Solar System other than individual stars: galaxies, nebulae, star clusters. They are generally faint and extended and require long integrations.',
    inStarLight:
      'The Objects step identifies the imaged object from the name in the header, from the coordinates or from the content of the framing, and shows its apparent size, magnitude, constellation and a short description.',
    see: ['OpenNGC', 'Galaxy', 'Emission nebula', 'Open cluster']
  },
  {
    term: 'Galaxy',
    alternatives: ['galaxies'],
    category: 'astrometry',
    definition:
      'A gravitationally bound system of billions of stars, gas and dust outside the Milky Way. In images it shows a bright core and faint outer structures, such as spiral arms, which require a careful stretch.',
    inStarLight:
      'With an astrometric solution the galaxies of the catalog are marked on the image with an outline matching their apparent size. The optional “Galaxies (SGA)” package adds many more, down to magnitude 14.',
    see: ['Arp', 'Hickson', 'GHS']
  },
  {
    term: 'Emission nebula',
    alternatives: ['nebula', 'HII region', 'emission nebulae'],
    category: 'astrometry',
    definition:
      'A cloud of gas ionized by the radiation of nearby hot stars, which emits light in characteristic lines, above all the red H-alpha of hydrogen. It is the ideal subject for narrowband imaging.',
    inStarLight:
      'The Sharpless, LBN, RCW and Gum catalogs, available as optional packages, include many emission nebulae not listed in the NGC/IC catalog.',
    see: ['H-alpha', 'Narrowband', 'Sharpless', 'LBN']
  },
  {
    term: 'Reflection nebula',
    alternatives: ['reflection nebulae'],
    category: 'astrometry',
    definition:
      'A cloud of dust that emits no light of its own but scatters that of nearby stars, usually appearing blue. It does not benefit from narrowband filters.',
    inStarLight:
      'The vdB and Cederblad catalogs, as optional packages, add many of them to the bundled catalog.',
    see: ['vdB', 'Emission nebula']
  },
  {
    term: 'Dark nebula',
    alternatives: ['dark nebulae', 'dark cloud'],
    category: 'astrometry',
    definition:
      'A dense cloud of dust that blocks the light of the stars and nebulae behind it and appears as a dark silhouette against the background.',
    inStarLight:
      'The Barnard and LDN catalogs are available as optional packages.',
    see: ['Barnard', 'LDN']
  },
  {
    term: 'Planetary nebula',
    alternatives: ['planetary nebulae', 'PN'],
    category: 'astrometry',
    definition:
      'A shell of gas expelled by a Sun-like star in the final stages of its life and illuminated by the remaining stellar core. The name is historical and has nothing to do with planets. They are often small and rich in OIII.',
    inStarLight:
      'The optional “Planetary nebulae” package adds those without an NGC or IC designation, including the planetaries of the Abell catalog, with their measured diameter.',
    see: ['OIII', 'Abell', 'PN G']
  },
  {
    term: 'Supernova remnant',
    alternatives: ['supernova remnants', 'SNR'],
    category: 'astrometry',
    definition:
      'An expanding cloud of gas produced by the explosion of a star as a supernova, often made of thin filaments that emit in H-alpha and OIII.',
    inStarLight:
      'The optional “Supernova remnants” package collects those of the Milky Way that are also visible in optical light, with size and structure.',
    see: ['SNR G', 'Narrowband']
  },
  {
    term: 'Open cluster',
    alternatives: ['open clusters', 'star cluster'],
    category: 'astrometry',
    definition:
      'A group of young stars born from the same cloud, loosely bound by gravity and spread over a more or less wide area of sky.',
    inStarLight:
      'The optional “Star clusters from Gaia DR3” package adds about seven thousand clusters, with the names from the historical Collinder, Melotte, Trumpler and other catalogs.',
    see: ['Globular cluster', 'Gaia catalog']
  },
  {
    term: 'Globular cluster',
    alternatives: ['globular clusters', 'globular'],
    category: 'astrometry',
    definition:
      'A spherical, compact grouping of hundreds of thousands of very old stars, orbiting the center of a galaxy.',
    inStarLight:
      'The optional “Milky Way globular clusters” package collects them with their sizes.',
    see: ['Open cluster']
  },
  {
    term: 'Object markers',
    alternatives: ['markers', 'object labels', 'annotations', 'overlay'],
    category: 'astrometry',
    definition:
      'Circles or ellipses with a name, drawn on the image at the position of the catalog objects within the framing.',
    inStarLight:
      'With an astrometric solution the viewer marks the identified objects; they are shown or hidden from the View menu or from the Objects step. In the Export step the Include object markers option draws them into PNG, JPEG and WebP files.',
    see: ['Astrometric solution', 'Deep-sky object']
  },
  {
    term: 'Coordinate grid',
    alternatives: ['grid', 'equatorial grid', 'orientation', 'scale bar', 'north and east'],
    category: 'astrometry',
    definition:
      'Lines of right ascension and declination drawn on the image, with the values along the edges. It is often accompanied by the orientation, that is, the directions of north and east in the imaged sky, and by a scale bar showing an angular measure.',
    inStarLight:
      'Grid, orientation and scale bar are computed from the astrometric solution and are turned on separately in the Objects step, in the Coordinates on the image card; the choices are saved. Orientation and scale are placed in the corner away from the caption. In the Export step the Include coordinates option draws them into PNG, JPEG and WebP files.',
    see: ['Astrometric solution', 'Right ascension', 'Declination', 'Object markers']
  },
  {
    term: 'OpenNGC',
    alternatives: ['bundled catalog', 'object catalog'],
    category: 'astrometry',
    definition:
      'A free database of the objects of the NGC and IC catalogs, with positions, sizes, magnitudes and cross-identifications with other catalogs, distributed under the CC-BY-SA-4.0 license.',
    inStarLight:
      'The catalog bundled with StarLight derives from OpenNGC, with about thirteen thousand NGC and IC objects, the Messier and Caldwell numbers, and names and descriptions, supplemented by a selection of objects described in greater detail.',
    see: ['NGC', 'IC', 'Messier', 'Caldwell']
  },
  {
    term: 'Messier',
    alternatives: ['M', 'Messier catalog'],
    category: 'astrometry',
    definition:
      'A catalog of 110 bright objects compiled in the eighteenth century by Charles Messier. The designations run from M 1 to M 110 and include many of the best-known subjects, such as M 31 (the Andromeda Galaxy) and M 42 (the Orion Nebula).',
    inStarLight:
      'Messier numbers are part of the bundled catalog and are recognized in object names.',
    see: ['OpenNGC', 'NGC', 'Caldwell']
  },
  {
    term: 'NGC',
    alternatives: ['New General Catalogue'],
    category: 'astrometry',
    definition:
      'The New General Catalogue, compiled by J. L. E. Dreyer in 1888, with about 7800 deep-sky objects of all types.',
    inStarLight:
      'It is included in the bundled catalog, through OpenNGC.',
    see: ['IC', 'OpenNGC']
  },
  {
    term: 'IC',
    alternatives: ['Index Catalogue'],
    category: 'astrometry',
    definition:
      'The Index Catalogue, a supplement to the NGC catalog published by Dreyer between 1895 and 1908, with more than 5300 additional objects.',
    inStarLight:
      'It is included in the bundled catalog, through OpenNGC.',
    see: ['NGC', 'OpenNGC']
  },
  {
    term: 'Caldwell',
    alternatives: ['C', 'Caldwell catalog'],
    category: 'astrometry',
    definition:
      'A list of 109 bright objects compiled by Patrick Moore in 1995 as a complement to the Messier catalog, with designations from C 1 to C 109 and many objects of the southern hemisphere.',
    inStarLight:
      'Caldwell numbers are part of the bundled catalog.',
    see: ['Messier', 'OpenNGC']
  },
  {
    term: 'Additional deep-sky catalogs',
    alternatives: ['catalog packages', 'optional catalogs', 'deep-sky catalogs'],
    category: 'astrometry',
    definition:
      'Collections of objects from other astronomical catalogs, distributed as data-only packages under an open license.',
    inStarLight:
      'The plugin gallery, under Deep-sky catalogs, makes it possible to download from the StarLight server, or to install from a ZIP archive, catalogs such as Sharpless, LBN, LDN, Barnard, vdB, Arp, Hickson, planetary nebulae, supernova remnants and clusters. Each package is verified before installation; the installed objects are identified in the field, marked on the image and found by designation. An installed catalog can be disabled (it stays on disk but is not used) and enabled again, or uninstalled. In the Objects step, the marker density (Essential, Normal, Rich) and the object types shown keep crowded fields from filling up with names. In the same gallery, the Stars for plate solving group offers the stars for plate solving without internet.',
    see: ['Sharpless', 'LBN', 'LDN', 'Barnard', 'vdB', 'Arp', 'Hickson', 'Local stars', 'Plugin gallery']
  },
  {
    term: 'Sharpless',
    alternatives: ['Sh2', 'Sh 2', 'SH2', 'Sharpless catalog'],
    category: 'astrometry',
    definition:
      'A catalog of 313 emission nebulae (HII regions) of the northern hemisphere, published by Stewart Sharpless in 1959. Designations take the form Sh2-155.',
    inStarLight:
      'It is available as an optional package in the Deep-sky catalogs tab of the plugin gallery.',
    see: ['Emission nebula', 'Additional deep-sky catalogs']
  },
  {
    term: 'LBN',
    alternatives: ['Lynds Bright Nebulae', 'Lynds bright nebulae'],
    category: 'astrometry',
    definition:
      'The catalog of bright nebulae compiled by Beverly Lynds in 1965 from the photographic plates of the Palomar Sky Survey.',
    inStarLight:
      'It is available as an optional package in the Deep-sky catalogs tab of the plugin gallery.',
    see: ['LDN', 'Emission nebula', 'Additional deep-sky catalogs']
  },
  {
    term: 'LDN',
    alternatives: ['Lynds Dark Nebulae', 'Lynds dark nebulae'],
    category: 'astrometry',
    definition:
      'The catalog of dark nebulae compiled by Beverly Lynds in 1962.',
    inStarLight:
      'It is available as an optional package in the Deep-sky catalogs tab of the plugin gallery.',
    see: ['LBN', 'Dark nebula', 'Barnard']
  },
  {
    term: 'Barnard',
    alternatives: ['B', 'Barnard catalog'],
    category: 'astrometry',
    definition:
      'A catalog of dark nebulae compiled by Edward Emerson Barnard in the early twentieth century; it includes, for example, the Horsehead Nebula (Barnard 33).',
    inStarLight:
      'It is available as an optional package in the Deep-sky catalogs tab of the plugin gallery.',
    see: ['Dark nebula', 'LDN']
  },
  {
    term: 'vdB',
    alternatives: ['van den Bergh', 'van den Bergh catalog'],
    category: 'astrometry',
    definition:
      'A catalog of 158 reflection nebulae published by Sidney van den Bergh in 1966.',
    inStarLight:
      'It is available as an optional package in the Deep-sky catalogs tab of the plugin gallery; the positions do not include sizes.',
    see: ['Reflection nebula', 'Additional deep-sky catalogs']
  },
  {
    term: 'RCW, Gum and Cederblad',
    alternatives: ['RCW', 'Gum', 'Cederblad', 'Ced'],
    category: 'astrometry',
    definition:
      'Historical catalogs of nebulae: RCW (Rodgers, Campbell and Whiteoak, 1960) and Gum (1955) list the emission nebulae of the southern sky; Cederblad (1946) lists diffuse nebulae, mostly reflection nebulae.',
    inStarLight:
      'They are available as optional packages in the Deep-sky catalogs tab of the plugin gallery.',
    see: ['Emission nebula', 'Reflection nebula']
  },
  {
    term: 'Abell',
    alternatives: ['Abell catalog', 'Abell PN'],
    category: 'astrometry',
    definition:
      'The name of two catalogs compiled by George Abell: one of 86 faint, extended planetary nebulae, the other of thousands of galaxy clusters. A designation such as Abell 39 must be interpreted according to the type of object.',
    inStarLight:
      'The Abell planetaries are included in the “Planetary nebulae” package; the Abell designations of clusters appear in the “Nearby galaxy clusters” package.',
    see: ['Planetary nebula', 'Hickson']
  },
  {
    term: 'Arp',
    alternatives: ['Atlas of Peculiar Galaxies', 'peculiar galaxies'],
    category: 'astrometry',
    definition:
      'An atlas of 338 peculiar galaxies, often interacting or distorted, published by Halton Arp in 1966.',
    inStarLight:
      'It is available as an optional package in the Deep-sky catalogs tab of the plugin gallery.',
    see: ['Galaxy', 'Hickson']
  },
  {
    term: 'Hickson',
    alternatives: ['HCG', 'Hickson Compact Groups', 'compact groups'],
    category: 'astrometry',
    definition:
      'A catalog of 100 compact groups of galaxies, made up of four or more galaxies very close to one another, compiled by Paul Hickson in 1982. Designations take the form HCG 92.',
    inStarLight:
      'It is available as an optional package in the Deep-sky catalogs tab of the plugin gallery.',
    see: ['Galaxy', 'Arp']
  },
  {
    term: 'PN G',
    alternatives: ['galactic designation', 'PK'],
    category: 'astrometry',
    definition:
      'A designation of planetary nebulae based on galactic coordinates, for example PN G054.1-12.1: the digits give the galactic longitude and latitude of the object.',
    inStarLight:
      'PN G designations may appear among the alternative names of the objects in the “Planetary nebulae” package.',
    see: ['Planetary nebula', 'SNR G']
  },
  {
    term: 'SNR G',
    alternatives: ['SNR', 'supernova remnant designation'],
    category: 'astrometry',
    definition:
      'A designation of supernova remnants based on galactic coordinates, for example SNR G180.0-01.7. The same abbreviation SNR is also used for signal-to-noise ratio, with which it has no relation.',
    inStarLight:
      'SNR G designations may appear among the alternative names of the objects in the “Supernova remnants” package.',
    see: ['Supernova remnant', 'PN G', 'Signal-to-noise ratio']
  },

  // ---------------------------------------------------------------- Plugins
  {
    term: 'Plugin',
    alternatives: ['plugins', 'extensions', 'add-on', 'add-ons'],
    category: 'plugins',
    definition:
      'An additional tool installed separately, which extends the functions of the program without modifying it.',
    inStarLight:
      'Bundled plugins enabled from the gallery and installed personal plugins appear in the Extra tools card of the Process step and are applied after all other tools, in the order in which they were turned on. Each plugin runs isolated from the rest of the program, with no access to files or the internet. StarLight does not download plugins from the internet: personal plugins are installed from a folder or a .zip archive.',
    see: ['Plugin gallery']
  },
  {
    term: 'Plugin gallery',
    alternatives: ['gallery', 'Plugins menu'],
    category: 'plugins',
    definition:
      'The window that collects the available plugins, with a description and previews of the result.',
    inStarLight:
      'It opens from the Plugins menu and also works without internet. It contains the plugins bundled with StarLight, which can be enabled and disabled (the choice is kept the next time the program is opened), and the Deep-sky catalogs tab with the optional catalogs; the All and Active tabs show plugins and catalogs together. The StarLight server hosts only FM Digital Tools packages: personal plugins and those from other developers are installed from a folder or a ZIP archive.',
    see: ['Plugin', 'Additional deep-sky catalogs']
  },
  {
    term: 'Orton effect',
    alternatives: ['Orton', 'glow', 'soft glow'],
    category: 'plugins',
    definition:
      'A photographic technique that blends a sharp image with a brightened and blurred copy of itself, producing a diffuse glow around bright areas and a softer look. It is named after the photographer Michael Orton, who achieved it by superimposing two slides.',
    inStarLight:
      'The Orton effect plugin sets the strength of the glow, its width in pixels and the brightening of the blurred copy. On nebulae it produces a softer look while keeping the outlines readable.',
    see: ['Plugin']
  },
  {
    term: 'Green removal',
    alternatives: ['SCNR', 'Subtractive Chromatic Noise Reduction', 'subtractive chromatic noise reduction', 'excess green'],
    category: 'plugins',
    definition:
      'The correction of the green cast typical of color astrophotographs: almost no object in the sky is actually green, so excess green is usually an artifact. The SCNR method (subtractive chromatic noise reduction) limits the green of each pixel to a reference value computed from red and blue.',
    inStarLight:
      'The Green removal plugin offers the Neutral average method (green limited to the mean of red and blue, recommended) and the Neutral maximum method (limited to the larger of the two, for slight casts), the Amount slider and the Preserve the brightness option, which compensates for the slight darkening caused by the correction.',
    see: ['Color cast', 'Plugin']
  },
  {
    term: 'Negative',
    alternatives: ['inversion', 'inverted image', 'invert'],
    category: 'plugins',
    definition:
      'The inversion of brightness values, so that the sky background becomes light and the stars dark dots. It makes it easier to spot the faintest extensions of nebulae and galaxies, because the eye distinguishes dark shades on a light background better.',
    inStarLight:
      'The Negative plugin inverts luminance and colors (each color becomes its complement) or luminance only, keeping the hues. It is computed on the stretch set in the Correct step.',
    see: ['Plugin']
  },
  {
    term: 'Black and white by channel',
    alternatives: ['black and white', 'monochrome', 'black and white conversion', 'grayscale'],
    category: 'plugins',
    definition:
      'A black and white conversion in which each color channel contributes with an adjustable weight, much like the colored filters used with film. A greater weight on red emphasizes emission nebulae, a greater weight on blue emphasizes reflection nebulae and young stars.',
    inStarLight:
      'The Black and white by channel plugin has one slider for each channel and the Keep the brightness option, which brings the sum of the weights back to 100%.',
    see: ['Color channel', 'Plugin']
  },
  {
    term: 'HDR, recovery of the bright areas',
    alternatives: ['HDR', 'high dynamic range', 'dynamic range compression', 'highlight recovery'],
    category: 'plugins',
    definition:
      'Dynamic range compression limited to the brightest areas, which restores their detail without darkening the faint parts. It is useful when the stretch needed to show faint structures clips bright cores and regions to white.',
    inStarLight:
      'The HDR plugin acts above an adjustable brightness threshold, on structures of the given size, and can boost local contrast in the compressed areas; colors keep their proportions. It recovers only the detail present in the data: an area saturated in every shot remains uniform.',
    see: ['Dynamic range', 'Saturated pixels', 'Local contrast']
  },
  {
    term: 'Star and nebula separation',
    alternatives: ['starless', 'starless image', 'star removal', 'star layer'],
    category: 'plugins',
    definition:
      'The division of the image into two layers, one with the nebula only and one with the stars only, which can be adjusted separately and then recombined. It makes it possible, for example, to increase the brightness and saturation of the nebula without enlarging the stars.',
    inStarLight:
      'The Star and nebula separation plugin uses a classic method based on mathematical morphology and interpolation, without artificial intelligence. It returns the recombined image, the nebula only or the stars only, with sliders for maximum star radius, sensitivity and margin, and for the brightness, saturation and reduction of each layer.',
    see: ['Star reduction', 'Plugin']
  },
  {
    term: 'Purple and blue fringe removal',
    alternatives: ['purple halos', 'blue halos', 'color fringes', 'chromatic aberration correction'],
    category: 'plugins',
    definition:
      'The correction of the purple or blue halo that chromatic aberration forms around stars. In optics free of aberration the light of a star has the same color from center to edge; where the edge has more blue or more red than the color of the star would predict, the excess is fringing.',
    inStarLight:
      'The plugin detects the stars, measures the color of the inner part of each one and subtracts from the edge only the excess colored light, without adding any: the center keeps its color and the nebula is left unchanged. It has the Strength and Halo size sliders and a choice of the hue to correct, purple and blue only or all hues.',
    see: ['Chromatic aberration', 'Plugin']
  },
  {
    term: 'Bright star halo reduction',
    alternatives: ['halo reduction', 'star halos', 'halo removal'],
    category: 'plugins',
    definition:
      'The attenuation of the wide halo surrounding the brightest stars. The halo is circularly symmetric and varies slowly with distance from the star: it is measured with the radial profile and subtracted, restoring the background and nebula it covered.',
    inStarLight:
      'The plugin treats only the stars brighter than the chosen threshold, measures for each one the median of concentric rings out to the given width and subtracts the halo starting from the edge of the star: the star disk remains identical. Unlike star reduction, it does not change the size of the stars.',
    see: ['Star halos', 'Star reduction', 'Plugin']
  },
  {
    term: 'Star color',
    alternatives: ['white stars', 'star saturation', 'stellar color'],
    category: 'plugins',
    definition:
      'The restoration of color in the center of stars that the stretch has pushed to white. The color remains recorded in the outer ring of the star, where the channels do not reach white, and can be brought back into the central part.',
    inStarLight:
      'The plugin measures the color of each star in its outer ring, on the linear data and net of the background, and applies it to the central part by lowering the weaker channels. It acts only inside the stars; the sliders set the strength, the minimum size of the stars treated and the protection of saturated pixels, which can stay white.',
    see: ['Saturation', 'Saturated pixels', 'Stretch', 'Plugin']
  },
  {
    term: 'Diffraction spikes',
    alternatives: ['spikes', 'star spikes', 'spider vanes', 'star rays'],
    category: 'plugins',
    definition:
      'Bright radial spikes around bright stars, produced by the diffraction of light on the vanes that support the secondary mirror of reflecting telescopes. Each straight vane produces two spikes perpendicular to itself: a four-vane spider gives four spikes, three vanes give six. Unobstructed instruments, such as refractors, do not produce them.',
    inStarLight:
      'The Diffraction spikes plugin adds them as an aesthetic effect to the brightest stars above a threshold, up to a maximum number: 4, 6 or 8 spikes, with adjustable angle, length, thickness and strength. Spikes are longer on brighter stars, fade toward the tip, can take on the color of the star and, with color dispersion, shift slightly toward red at the tip. They are not derived from the captured data.',
    see: ['Plugin']
  },
  {
    term: 'Colorizing a monochrome image',
    alternatives: ['colorize', 'colorization', 'tint', 'tinted monochrome'],
    category: 'plugins',
    definition:
      'The application of a uniform hue to a black and white image, for example one taken with a narrowband filter, so that each pixel keeps its brightness. It is customary to give each image the color of the emission line it collected.',
    inStarLight:
      'The Colorize monochrome images plugin offers the hues of the H-alpha, H-beta and OIII lines, computed from the wavelength of the line, or a free hue, with a saturation slider. The brightness as it appears on screen remains identical; in the lightest areas the hue fades toward white.',
    see: ['Narrowband', 'H-alpha', 'OIII', 'Plugin']
  },
  {
    term: 'Toning',
    alternatives: ['split toning', 'shadow and highlight toning', 'split tones'],
    category: 'plugins',
    definition:
      'A photographic printing technique that gives the image a tint; in split toning, the dark and light parts receive different tints, often cool for the former and warm for the latter. It changes the mood of the image without changing its brightness.',
    inStarLight:
      'The Split toning of shadows and highlights plugin has a hue and a strength for the shadows and for the highlights, and a balance that moves the transition between the two. The brightness of each pixel remains unchanged, saturated stars stay white and, with the Protect the sky background option, background pixels remain identical.',
    see: ['Sky background', 'Plugin']
  },
  {
    term: 'False color',
    alternatives: ['false colors', 'color map', 'colormap', 'viridis', 'magma', 'inferno', 'plasma', 'perceptually uniform palette'],
    category: 'plugins',
    definition:
      'A representation in which the color of each pixel indicates its brightness according to a predefined scale, rather than its real color. Perceptually uniform palettes, such as viridis, magma, inferno and plasma, are designed so that perceived lightness increases steadily along the scale: equal differences in brightness appear as equal differences in color, and the order can be read even with reduced color vision. They are used for analysis, to see faint structures and background gradients.',
    inStarLight:
      'The False color by brightness plugin offers the viridis, magma, inferno and plasma palettes (public domain, CC0) and three scales: as displayed on screen, linear and logarithmic. The last two are computed on linear data, from the sky background to the brightest areas; the logarithmic scale devotes most of the colors to the faint parts. The Stars in black and white option leaves the stars in gray.',
    see: ['Stretch', 'Sky background', 'Plugin']
  },

  // ---------------------------------------------------------------- Export and formats
  {
    term: 'FITS',
    alternatives: ['.fit', '.fits', '.fts', '.fz', 'compressed FITS', 'Flexible Image Transport System'],
    category: 'export',
    definition:
      'Abbreviation of Flexible Image Transport System, the standard astronomy format for images and scientific data. A FITS file contains a text header with the capture data and the image data, as 8, 16 or 32-bit integers or floating point. Compressed variants exist (.fz and .gz).',
    inStarLight:
      'StarLight imports FITS files, including compressed ones: .fits.gz and .fz with all the methods provided by the standard (Rice, gzip, HCOMPRESS, including lossy, and PLIO). It exports 16-bit FITS; the Keep capture data option copies the keywords of the source FITS into the new file.',
    see: ['Header', 'XISF', 'Bit depth']
  },
  {
    term: 'XISF',
    alternatives: ['.xisf', 'Extensible Image Serialization Format'],
    category: 'export',
    definition:
      'Abbreviation of Extensible Image Serialization Format: an open format for astronomical images with an XML header, which can also contain FITS keywords.',
    inStarLight:
      'StarLight imports XISF files, including those compressed with zlib, LZ4 or Zstandard, also from the live session folder, and reads their capture data.',
    see: ['FITS', 'Header']
  },
  {
    term: 'RAW',
    alternatives: ['raw file', 'CR2', 'CR3', 'NEF', 'ARW', 'RAF', 'ORF', 'RW2', 'PEF', 'DNG'],
    category: 'export',
    definition:
      'A file that contains the sensor data of a camera as it was read out, before any color reconstruction or compression. Each manufacturer has its own format (CR2 and CR3, NEF, ARW, RAF, ORF, RW2, PEF, DNG and others).',
    inStarLight:
      'StarLight imports the RAW files of the main DSLR and mirrorless cameras, reads their capture data and reconstructs color from the Bayer or X-Trans matrix. RAW files are also accepted by the live session.',
    see: ['Bayer matrix', 'X-Trans', 'FITS']
  },
  {
    term: 'TIFF',
    alternatives: ['.tif', '.tiff', 'Tagged Image File Format'],
    category: 'export',
    definition:
      'A lossless image format, suitable for exchange between photo editing programs, which stores up to sixteen bits per channel.',
    inStarLight:
      'StarLight imports TIFF images and exports TIFF at sixteen bits per channel.',
    see: ['Bit depth', 'PNG']
  },
  {
    term: 'PNG',
    alternatives: ['.png', 'Portable Network Graphics'],
    category: 'export',
    definition:
      'An image format with lossless compression, widely used on the web.',
    inStarLight:
      'StarLight imports and exports PNG images; on export it can include the object markers.',
    see: ['Compression', 'TIFF']
  },
  {
    term: 'JPEG',
    alternatives: ['.jpg', '.jpeg', 'JPG'],
    category: 'export',
    definition:
      'An image format with lossy compression, which produces small files at eight bits per channel, suitable for sharing but not for further processing.',
    inStarLight:
      'It is available for export only, with the Quality slider; above 90% the loss is hardly noticeable. It can include the object markers.',
    see: ['Compression', 'WebP']
  },
  {
    term: 'WebP',
    alternatives: ['.webp'],
    category: 'export',
    definition:
      'An image format for the web with efficient compression, which at the same quality produces smaller files than JPEG.',
    inStarLight:
      'It is available for export, with the Quality slider and the object markers option.',
    see: ['JPEG', 'Compression']
  },
  {
    term: 'BMP',
    alternatives: ['.bmp', 'bitmap'],
    category: 'export',
    definition:
      'An uncompressed image format, simple and compatible with almost all programs, at eight bits per channel.',
    inStarLight:
      'It is available for export.',
    see: ['PNG']
  },
  {
    term: 'Compression',
    alternatives: ['lossless', 'lossy'],
    category: 'export',
    definition:
      'The reduction of the size of a file. Lossless compression (PNG, TIFF) preserves every pixel exactly; lossy compression (JPEG, WebP) removes barely visible details and can introduce artifacts, the more so the stronger it is.',
    inStarLight:
      'For lossy formats the Export step offers the Quality slider.',
    see: ['PNG', 'JPEG', 'WebP', 'TIFF']
  },
  {
    term: 'Bit depth',
    alternatives: ['BITPIX', '8 bit', '16 bit', '32 bit', 'floating point'],
    category: 'export',
    definition:
      'The number of bits used to record the value of each pixel per channel: 8 bits allow 256 levels, 16 bits 65,536 levels. Astronomical images require many levels, because the stretch strongly amplifies small differences between faint tones; with few levels, banding and steps appear.',
    inStarLight:
      'The Import step shows the bit depth of each file. StarLight processes internally in 32-bit floating point; exported TIFF and FITS files keep sixteen bits per channel.',
    see: ['Dynamic range', 'FITS', 'TIFF']
  },
  {
    term: 'Header',
    alternatives: ['keywords', 'keyword', 'capture data', 'metadata', 'FITS header'],
    category: 'export',
    definition:
      'The part of a FITS or XISF file that contains the capture data as keyword-value pairs: date and time, exposure, gain, temperature, filter, focal length, pointing coordinates, object name, Bayer pattern and any astrometric solution.',
    inStarLight:
      'On import StarLight reads only the header of the files, so even hundreds of files load in a few moments; the main data is shown in the Import step. The header determines the recognition of the frame type, color reconstruction, the choice of masters, object identification and the image scale.',
    see: ['IMAGETYP', 'FITS', 'WCS']
  },
  {
    term: 'IMAGETYP',
    alternatives: ['frame type', 'FRAME', 'OBSTYPE', 'image type'],
    category: 'export',
    definition:
      'The FITS header keyword that declares the frame type: light, dark, flat or bias. Not all devices fill it in consistently.',
    inStarLight:
      'StarLight uses IMAGETYP as the main source for classifying frames and the file name as confirmation: a name containing “dark”, “flat” or “bias” is recognized even without the keyword. A file that declares several combined frames is recognized as pre-stacked.',
    see: ['Header', 'Light frame', 'Calibration frames']
  },
  {
    term: 'Resampling',
    alternatives: ['enlargement', 'resizing', 'upscaling', 'Lanczos', 'Edge-directed', 'interpolation'],
    category: 'export',
    definition:
      'The computation of an image with a different number of pixels from the original. For enlargement, the Lanczos filter is the classic method, sharp and faithful, but on diagonal edges it can leave small steps and dark halos around bright stars; methods that follow the direction of edges avoid them. No method adds details that are not in the data.',
    inStarLight:
      'In the Export step, on the Resolution card, the choice is between Lanczos and Edge-directed, which interpolates along the direction of edges, keeping star profiles and nebula outlines smooth. Corrections are recomputed on the original full-resolution data.',
    see: ['Crop', 'Drizzle']
  },

  // ---------------------------------------------------------------- Using the program
  {
    term: 'Project',
    alternatives: ['.slight', 'project.slight', 'save', 'saving'],
    category: 'usage',
    definition:
      'The whole of the work done on an image, saved so that it can be resumed later.',
    inStarLight:
      'Each project is a folder with the chosen name, which contains the project.slight file with the adjustments and the processed image. The original frames are not copied and stay where they are. The commands are in the File menu; the Recent projects item lists the last five.',
    see: ['Frame library', 'History']
  },
  {
    term: 'Frame library',
    alternatives: ['library', 'frame list', 'imported frames'],
    category: 'usage',
    definition:
      'The list of files imported in a work session, with the type and capture data of each one.',
    inStarLight:
      'In the Import step, a click on a frame opens it in the viewer; the eye button excludes it from processing without removing it. The calibration frames of the library feed the Calibrate step, the light frames feed the Stack step.',
    see: ['Light frame', 'Calibration frames', 'Project']
  },
  {
    term: 'History',
    alternatives: ['undo', 'redo', 'edit history'],
    category: 'usage',
    definition:
      'An ordered record of the changes made to the image, which makes it possible to return to a previous state.',
    inStarLight:
      'Every change becomes a history step: adjustments, curves, processing, Abracadabra, plugins and crop. Ctrl+Z and Ctrl+Y undo and redo; the History button opens the list of steps. Opening another frame or a project restarts the history.',
    see: ['Project', 'Abracadabra']
  },
  {
    term: 'Batch processing',
    alternatives: ['batch', 'series'],
    category: 'usage',
    definition:
      'The application of the same sequence of corrections to several images, with one output file for each.',
    inStarLight:
      'From the File menu, Batch processing applies a recipe to several FITS, XISF, TIFF, PNG or RAW files, one at a time, or prepares each one with Abracadabra. The files go into the exports folder, in a subfolder named with the date, without ever overwriting existing files. The open image and the project are not touched.',
    see: ['Recipe', 'Abracadabra']
  },
  {
    term: 'Recipe',
    alternatives: ['.recipe', 'preset', 'processing preset'],
    category: 'usage',
    definition:
      'A saved set of adjustments to be applied to other images.',
    inStarLight:
      'The batch processing recipe includes the Process tools, tones and color, curves, filter, framing and file format. It is taken from the open image and saved to a .recipe file to be reopened later.',
    see: ['Batch processing']
  }
]
