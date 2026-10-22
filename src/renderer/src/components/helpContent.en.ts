/**
 * Help center content in English.
 *
 * Same entries, in the same order, as `helpContent.it.ts`; see that file for
 * the placeholders.
 */
import type { HelpContent } from './helpContent.it'

export const HELP_CONTENT_EN: HelpContent = {
  tools: [
    {
      icon: 'process',
      title: 'The menu bar',
      text:
        'The top row contains six menus. File gathers the project commands, including Recent projects, which lists the last five projects for reopening with a single click, as well as frame import, batch processing and image export. Edit contains Undo, Redo and the edit history. View controls the zoom and shows or hides the object markers, the detected stars and the tools panel. Plugins opens the plugin gallery directly. Settings opens the settings window. Help contains the quick tour, this guide, the glossary of technical terms, the update check, the error log, the list of keyboard shortcuts, License and credits, the page for supporting StarLight and the information about the program. With the keyboard, the arrow keys move through the items and from one menu to the next, Enter runs the selected item and Esc closes the menu.'
    },
    {
      icon: 'folder',
      title: 'Projects',
      text:
        'A project keeps the work done on an image so that it can be resumed later. Each project is a folder with the chosen name, containing the project.slight file with the adjustments and the processed image. The original frames are not copied and stay where they are. The File menu contains the New project, Open project, Save, Save as and Close project commands. Closing a project empties the library and returns the program to its initial state.'
    },
    {
      icon: 'import',
      title: 'Import',
      text:
        'The Import frames button loads individual files. StarLight accepts FITS files, the format used in astronomy for images and capture data, XISF files, TIFF and PNG images and camera RAW formats. The Folder button loads every FITS, XISF and RAW file in a folder. StarLight recognizes raw frames, calibration frames and files already stacked by the telescope, that is, already added together. On import only the file header, the part that holds the capture data, is read, so even hundreds of files load in a few moments. In the library, clicking a frame opens it in the viewer, and the eye button excludes it from processing without removing it.'
    },
    {
      icon: 'calibrate',
      title: 'Calibration',
      text:
        'Masters, the reference frames used for the correction, are built from the calibration frames in the library by combining them with the median, the middle value among all those measured for each pixel. Frames taken under different conditions (exposure, gain, temperature, filter, night) are automatically split into groups, with one master per group, and each light frame uses the master that matches its conditions. Some telescopes already record the master dark, which can be imported like any other file. Before stacking, the masters are applied to the light frames, removing the signal produced by sensor heat, defective pixels and the shadows of dust on the optics.'
    },
    {
      icon: 'align',
      title: 'Alignment and stacking',
      text:
        'The stars in each frame are matched against those in the best frame by means of triangles, which keep the same shape even when the image is shifted or rotated. Frames scoring below the minimum quality are excluded. The Robust method averages the values close to the median and removes satellite trails and cosmic rays. The Mean method uses the whole signal; the Median method uses the middle value of each pixel. The computation is spread across the processor cores.'
    },
    {
      icon: 'align',
      title: 'Drizzle',
      text:
        'Between one exposure and the next, the field shifts by fractions of a pixel. Drizzle, in the Stack step, exploits these small shifts and adds the frames onto a grid with twice as many pixels per side, recovering detail actually recorded by the sensor. The Drop size slider sets the portion of each pixel deposited onto the new grid. Drizzle requires alignment to be enabled and works best with at least twenty or so frames. The result has four times as many pixels and requires more memory and more time.'
    },
    {
      icon: 'align',
      title: 'Comets',
      text:
        'During acquisition a comet moves against the stars, and the Comet card in the Stack step determines what stays still in the result. With Still stars, stacking is the usual one and the comet comes out elongated. With Still comet, the frames are aligned on the nucleus: the comet is sharp and the stars become streaks, largely removed by rejection. With Both, the program extracts the comet alone from the stack aligned on the nucleus, removes it from every frame, stacks the frames on the stars and finally puts the comet back on top, giving pinpoint stars and a sharp comet. The nucleus is detected automatically as the extended bright spot moving at constant speed, using the exposure time recorded in the files; alternatively it can be marked with a click on the first and last frame, the most reliable approach for faint or slow comets. Drizzle applies only with Still comet.'
    },
    {
      icon: 'eye',
      title: 'Live session',
      text:
        'The live session, in the Stack step, watches the folder where the acquisition software saves the frames, even when it is a network folder shared by the telescope. Each new frame is analyzed and aligned, then the stack is recomputed and the image in the viewer updates during acquisition. The Include existing frames switch also adds the frames saved before the session started. The suggested folder is set in Settings, on the Telescope tab.'
    },
    {
      icon: 'align',
      title: 'Mosaic',
      text:
        'The mosaic, in the Stack step, joins several framings of adjacent sky areas, called panels, into a wider field. Each panel is placed using its own astrometric solution, read from the file or computed with the Plate solve command in the Objects step. Sky background and brightness are matched in the overlapping areas, and the edges are blended without visible seams. The recommended overlap between panels is 10–20%.'
    },
    {
      icon: 'wand',
      title: 'Abracadabra',
      text:
        'The Abracadabra button, in the top bar, prepares the image automatically. The program measures the image, sets the tools of the Process step, runs the computation and sets the generalized hyperbolic stretch (GHS) and the saturation in the Correct step. It also proposes cropping the noisy edges, which can be viewed and changed with the Crop button, and a final notice summarizes the corrections made. The chosen values remain editable in the Process and Correct steps, and the Reset button restores the original image.'
    },
    {
      icon: 'process',
      title: 'Process',
      text:
        'The Process step gathers the tools that transform the data before the stretch, that is, while the image is still linear. Each card has its own settings. The computation starts with the Apply button at the bottom of each card, or with Apply all at the bottom of the column: in both cases it includes all the tools, takes a few seconds and always starts again from the original image. The “not applied” badge marks a card whose values have changed but have not been computed yet. The tools run in a fixed order set by the program, and the Reset button returns them all to their initial values.'
    },
    {
      icon: 'process',
      title: 'Defects and sky background',
      text:
        'This card corrects defective pixels, isolated points much brighter than their neighbors, replacing them with the median of the surrounding pixels. It then extracts the sky background, the light scattered by light pollution and by the Moon. Simple mode models the background as a smooth surface, suited to gradual variations. Advanced mode uses radial basis functions and also follows halos and irregular variations, with three sliders for the number of samples, smoothness and tolerance.'
    },
    {
      icon: 'process',
      title: 'Satellite trails',
      text:
        'Aircraft and satellites crossing the field during an exposure leave a bright line. The Remove trails switch detects these lines, even when they stop midway across the image or are made of dashes, and rebuilds their pixels from the sky and grain on either side, only along the stretch where the line is present. A line is treated as a trail only if it is straight, very long and as wide as a star along its whole length: an edge-on galaxy is wider and tapers at its ends, and a nebula filament bends and changes brightness. With an astrometric solution, the galaxies and nebulae in the catalog are also excluded. The Sensitivity slider controls the detection of faint trails. On stacked images the tool is usually unnecessary, because stacking already rejects trails.'
    },
    {
      icon: 'process',
      title: 'Color',
      text:
        'The On the stars balance makes the average color of the stars white. The Photometric balance compares the stars in the image with the Gaia catalog, which lists their measured color, and the Compute from Gaia button derives the correction for each channel. It is the most accurate method, but it requires an internet connection and an astrometric solution of the field. The Color noise slider removes color blotches from the sky background and evens out the color of each star, without affecting sharpness.'
    },
    {
      icon: 'process',
      title: 'Deconvolution',
      text:
        'Deconvolution recovers the sharpness lost to atmospheric turbulence and the optics, starting from the measured shape of the stars. The method used is Richardson-Lucy. The Iterations slider sets how many times the computation is repeated; beyond a certain value, halos and grain appear. With the Blur size slider at zero, the size is measured on the stars in the image. Regularization limits noise amplification. The tool does not add detail; it restores detail that has been softened.'
    },
    {
      icon: 'process',
      title: 'Noise reduction',
      text:
        'NL-Bayes compares each small area of the image with similar areas and keeps their common structure, removing grain. Wavelets decompose the image into five scales, from 1 to 16 pixels, and one slider per scale controls the noise reduction at that size. Wavelets are useful on blotchy grain a few pixels wide, which NL-Bayes partly leaves behind.'
    },
    {
      icon: 'process',
      title: 'Detail by scale',
      text:
        'Five sliders, one for each scale from 1 to 16 pixels, strengthen or soften the details of the corresponding size. Small scales correspond to grain and fine filaments, large scales to galaxy arms and clouds. The decomposition is the same as the wavelets used for noise reduction.'
    },
    {
      icon: 'process',
      title: 'Narrowband',
      text:
        'With a dual-band filter, a color sensor collects only two emission lines: hydrogen (H-alpha) in red and oxygen (OIII) in green and blue. This card separates the two lines and recombines them according to the palettes of narrowband photography. HOO assigns hydrogen to red and oxygen to green and blue. Foraxx adds golden transitions where both gases are strong. Synthetic Hubble imitates the gold and blue of the space telescope’s images, but without sulfur, which this filter does not collect. The sliders adjust the balance between the two gases and the strength of the oxygen. The resulting colors are a convention and do not match what the eye sees.'
    },
    {
      icon: 'process',
      title: 'Star reduction',
      text:
        'This tool shrinks the stars and fills the freed space with the surrounding background, to the benefit of nebulae and galaxies. The Size slider controls the shrinking, the Brightness slider the dimming of the star light. The computation does not use neural networks.'
    },
    {
      icon: 'process',
      title: 'Local contrast',
      text:
        'Local contrast brings out the internal structures of galaxies and nebulae by adjusting the contrast tile by tile, using the CLAHE method. The Strength slider controls the effect, the Limit slider sets the maximum contrast of each tile and the Tiles per side slider sets the number of tiles. More tiles follow smaller structures. The effect should be used sparingly, because it also enhances noise.'
    },
    {
      icon: 'process',
      title: 'Plugins',
      text:
        'Plugins are free, open-source add-on tools, meaning their code is public. The gallery, opened from the Plugins menu, contains the plugins bundled with StarLight, which grow in number with new versions of the program: they can be enabled and disabled, and the choice is kept across sessions. The gallery also works offline, and the All and Active tabs show plugins and deep-sky catalogs together. A personal plugin, or one from another developer, is installed locally from a folder or a ZIP archive on the computer: the StarLight server hosts only FM Digital Tools packages. Enabled or installed plugins appear in the Extra tools card of the Process step and are applied after all the other tools, in the order in which they were enabled. Each plugin runs isolated from the rest of the program, with no access to files or the internet.'
    },
    {
      icon: 'correct',
      title: 'Stretch',
      text:
        'The stretch brightens the faint tones of a linear frame and makes the object visible. The black point clips the background noise, the midtones control how much of the faint signal emerges, and the white point sets the level of full white. As an alternative to the midtones, the generalized hyperbolic stretch (GHS) concentrates the contrast on a chosen brightness range, with sliders for strength, local intensity, symmetry point and protection of shadows and highlights. The Auto button computes the black point and midtones from the sky background, with three intensity levels.'
    },
    {
      icon: 'correct',
      title: 'Curves',
      text:
        'The curve maps the tone of a pixel before the correction to its tone after the correction. The diagonal line leaves the image unchanged; a higher line brightens it. A click adds a point, dragging moves it and a right click removes it. Selecting a single color channel makes it possible to correct color casts that the three Gain sliders cannot fix.'
    },
    {
      icon: 'correct',
      title: 'Tones and color',
      text:
        'The Tones and Color cards in the Correct step adjust brightness, contrast, gamma and saturation. Vibrance mainly boosts dull colors and leaves already intense ones almost unchanged, so nebulae gain color without overdoing colored stars. The three Gain sliders correct color casts, for example the greenish background left by light pollution filters.'
    },
    {
      icon: 'correct',
      title: 'Local adjustments and masks',
      text:
        'The Local adjustments card in the Correct step applies an adjustment to only part of the photo, for example to brighten the faint areas of a nebula without blowing out its core, or to boost the red of hydrogen while leaving the stars unchanged. Each adjustment has a mask, which decides where it acts, and its own sliders: brightness, contrast, saturation, vibrance, temperature, tint, sharpness and noise reduction. There are six automatic masks. Light selects a brightness range. Color selects a hue, with presets for the red of hydrogen and the blue of oxygen. Stars follows the stars found in the image, with a larger circle for brighter ones. Object draws an ellipse around the object recognized in the field. Gradient and Circle are drawn by dragging on the photo. Each mask has edge feathering, an intensity and the Invert the mask command, which, with Stars for example, makes the adjustment act on everything except the stars. With the brush and the eraser, the area is painted by hand directly on the photo, on its own or to narrow down an automatic mask; the mouse wheel and right button still zoom and pan the image. The Show the mask in red command highlights the area where the adjustment acts. Up to four adjustments can be used; they are applied after all the other corrections, are included in the exported image and are saved in the project. Each brush stroke is a step in the history, so it can be undone with Ctrl+Z.'
    },
    {
      icon: 'filters',
      title: 'Filters',
      text:
        'Twenty-four photo filters change the color rendering, from sepia to false color, and the Filter intensity slider controls their intensity. Noise reduction averages neighboring pixels only where their brightness is similar and, at higher values, considers a wider area and also smooths blotchy grain. Sharpening enhances fine detail, and the vignette gradually darkens edges and corners. Background removal subtracts a constant level from each color channel, equal to the sky background measured on the image. Variations of the background from one area to another are corrected in the Process step instead.'
    },
    {
      icon: 'objects',
      title: 'Objects',
      text:
        'The framed field is compared with a catalog of {objectCount} deep-sky objects drawn from OpenNGC. StarLight indicates the main object and the other objects within the frame and, with an astrometric solution, marks them on the image with a circle and their name. When the file contains no solution, the Plate solve button computes it by matching the stars in the photo against those in a catalog; this requires the pointing coordinates or the object name in the file header. With the Stars for plate solving package, downloaded from the Deep-sky catalogs tab of the plugin gallery, the computation runs offline in a few seconds. Without the package, or in narrow fields where its stars are too few, StarLight uses the online Gaia catalog, if internet access is allowed. The request can take up to a minute. With internet access turned off, a notice explains why and offers the Turn internet back on button. In the Coordinates on the image card, the coordinate grid, the north and east orientation and the scale bar can be turned on.'
    },
    {
      icon: 'export',
      title: 'Export',
      text:
        'The Export step offers six file formats, twenty-five preset sizes for social media, screens and print, and a crop box to drag for choosing the framing. The same box can also be moved and resized on the large image with the Crop button. TIFF and FITS keep sixteen bits per channel. Two methods are available for upscaling beyond the available pixels. Lanczos is the classic filter, sharp and faithful. Edge-directed follows the direction of edges and avoids jagged steps and halos around stars. Neither adds detail that is not in the data. For PNG, JPEG and WebP, the Include object markers option draws circles and names into the file, and the Include coordinates option adds the grid, orientation and scale bar turned on in the Objects step. The corrections are recomputed on the original full-resolution data.'
    },
    {
      icon: 'crop',
      title: 'Cropping in the viewer',
      text:
        'The Crop button, in the top bar next to Fit, shows in the viewer the part of the image that will be exported: the part cropped away appears dark. The {cropKey} key does the same. When on, the box can be changed directly on the image in any step. Dragging from inside moves it; pulling the corners or sides resizes it. If an aspect ratio or a preset size is selected in the Export step, the box keeps that shape. Outside the box, the mouse pans the image as usual and the wheel zooms it. Each drag is a single step in the history, so Ctrl+Z undoes it. When off, the box is hidden but still applies to the export. While the mask brush or eraser is in use, the box stays visible but cannot be changed.'
    },
    {
      icon: 'straighten',
      title: 'Rotate, mirror, straighten',
      text:
        'In the top bar, next to History, the ⟲ and ⟳ buttons rotate the image by 90°, and the two Mirror buttons flip it left to right or top to bottom. These are pixel moves, with no loss of quality. The Straighten button rotates by any angle: with an immediate preview, by drawing a line to make horizontal or vertical, or by bringing north to the top when an astrometric solution is available. All these operations also apply to the export, can be undone with Undo and are saved in the project; object markers, masks, crop and astrometric solution follow the image.'
    },
    {
      icon: 'export',
      title: 'Batch processing',
      text:
        'From the File menu, Batch processing applies the same recipe to several images and saves one file for each. The recipe includes the Process tools, tones and color, curves, filter, framing and file format. It can be taken from the open image with Use the open image’s settings, saved as a .recipe file and reopened later. With Abracadabra on every file, every image is measured and prepared as with the Abracadabra button: with images that differ from one another, this is usually the best choice. A fixed crop makes sense only for images with the same framing, which is why it is optional. The files go to the exports folder, in a subfolder named with the date. An existing file is never overwritten: a number is added to the new one. During the batch, the progress and the remaining time are shown, and the batch can be stopped. At the end, a summary lists the successful files and the reason for those that failed. The open image, the history and the project are left untouched.'
    },
    {
      icon: 'restart',
      title: 'Undo, Redo and History',
      text:
        'Every change to the image becomes a step in the history: adjustments, curves, processing, Abracadabra, plugins, rotations, mirroring and crop. The arrow buttons in the top bar, the Edit menu and the Ctrl+Z and Ctrl+Y keys go back and forward one step. The History button opens the list of steps: clicking a step returns the image to that point. Dragging a slider produces a single step. Opening another frame or a project starts a new history.'
    },
    {
      icon: 'process',
      title: 'Settings',
      text:
        'The settings window opens from the Settings menu or with Ctrl and comma, and is divided into five tabs. General sets the language, the work folder for projects, exports and live sessions, and whether the last project reopens at startup. Performance opens with a summary of the settings chosen for this computer: on first startup StarLight measures the processors, memory and graphics card and chooses the values itself, and the “Optimize for this computer” button repeats the choice, first showing what will change. Below, the following can be set by hand: the number of threads for frame analysis, the memory reserved for open frames, the graphics card to use (high performance or power saving) and graphics acceleration, which take effect at the next startup and have a “Restart now” button, and low-priority computation, which keeps the computer responsive during a long stacking run at the cost of a few extra seconds. At the bottom, Disk space shows how much space is taken by the data StarLight keeps on its own, with “Clear” where it makes sense. Telescope sets the live session folder. Network and catalogs allows or blocks internet access and sets the limiting magnitude of the Gaia catalog. Updates decides whether to check for new versions at startup. General is also where the language of the program’s text is chosen, from the available languages.'
    },
    {
      icon: 'info',
      title: 'License and credits',
      text:
        'StarLight is distributed under the GNU GPL license, version 3 or later. The license permits using, studying, modifying and redistributing the program, which is provided without warranty. The License and credits window, from the Help menu, shows the license text and the list of works by other authors used by the program, such as the OpenNGC catalog, with their respective licenses.'
    },
    {
      icon: 'star',
      title: 'Support StarLight',
      text:
        'StarLight is free. The Support StarLight item in the Help menu, and the button in the About window, open the Ko-fi page in the browser for a donation to support development.'
    },
    {
      icon: 'star',
      title: 'Graphics card and memory',
      text:
        'The corrections of the Correct and Filters steps are computed by the graphics card, which processes all the pixels at once, which is why the image changes while the sliders move. The heavier tools of the Process step are computed by the processor on all available cores. Frames already opened stay in memory, so reopening them is immediate. The memory in use is shown in the status bar under RAM, and the limit is set in Settings, on the Performance tab.'
    }
  ],
  shortcutsIntro:
    'The most frequently used commands have a shortcut key, also shown to the right of the menu items. Letters and digits on their own do not work while typing in a text field, and the arrow keys remain assigned to the sliders. Holding down the {compareKey} key (the backslash, left of the 1 key on the Italian keyboard) shows the image as it was when opened; releasing it returns to the processed image. The same list, with a search box, opens with {shortcutListKey} or from the Help menu.',
  glossaryIntro:
    'The meaning of technical terms is collected in the Glossary window, which can also be opened from the Help menu: {count} entries, from acquisition to export, each with its definition, the role of the data in StarLight and references to related entries, searchable by name, abbreviation or synonym. Some entries to start with: ',
  initialEntries: ['Light frame', 'Master dark', 'Flat', 'Bias', 'Stacking', 'Linear data', 'Stretch', 'Astrometric solution']
}
