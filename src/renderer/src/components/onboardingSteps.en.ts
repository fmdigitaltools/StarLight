/**
 * Quick tour steps in English.
 *
 * Same steps, in the same order and with the same targets, as
 * `onboardingSteps.it.ts`; see that file for the placeholders.
 */
import type { GuideStep } from './onboardingSteps.it'

export const ONBOARDING_STEPS_EN: GuideStep[] = [
  {
    target: null,
    title: 'Welcome to StarLight',
    text:
      'This is version {version}, codename {codename}. StarLight is a program for processing astronomical images, designed first and foremost for stacked images and also able to help you improve single images. It accepts FITS and XISF files, TIFF and PNG images and camera RAW formats. This tour shows you where the main commands are. You can close it at any time and view it again from the Guide, which opens with the F1 key, using the Replay the quick tour button.'
  },
  {
    target: 'import-actions',
    title: 'Importing frames',
    text:
      'With Import frames you load individual shots saved by your telescope or camera; with Folder, all the frames of a session. Telescope opens the frame picker directly in the telescope folder, even over the network, if you have set it in Settings. At this stage StarLight reads only the file headers, that is, the capture data, so even hundreds of files load in a few moments.'
  },
  {
    target: 'viewer',
    title: 'The viewer',
    text:
      'Here you see the image you are working on. Drag with the mouse to move it and use the wheel to zoom: the 0 key fits it to the window, the 1 key shows the actual pixels. The adjustments in the Correct and Filters steps are computed by the graphics card, so the image changes as you move the sliders.'
  },
  {
    target: 'history-actions',
    title: 'The tools at the top',
    text:
      'Undo and Redo take back and repeat your changes, Reset returns the image to how it was when you opened it, and History shows every step you have taken. Next come the 90° rotation and the mirror, Straighten to rotate by any angle or put north at the top, zoom with Fit, and Crop, which shows in the viewer the part of the image you will export.'
  },
  {
    target: 'workflow',
    title: 'The workflow',
    text:
      'The eight steps follow one another from top to bottom: Import, Calibrate, Stack, Process, Correct, Filters, Objects and Export. Calibrate and Stack work on the frames, the others on the open image. A step stays disabled until you import a frame or, for the steps that work on the image, until you open one in the viewer.'
  },
  {
    target: 'step-align',
    title: 'Stacking',
    text:
      'This is the step with the greatest effect on the final result. StarLight detects the stars in each shot, measures the shift and rotation of the field, discards blurred frames and stacks the rest. Noise drops with the square root of the number of frames: with a hundred shots it becomes ten times lower. In the same step you will find drizzle, HDR blending, the live session during acquisition and the mosaic.'
  },
  {
    target: 'step-process',
    title: 'Process',
    text:
      'Process contains the tools that work on the data before the stretch, the transformation that makes faint tones visible. Each card handles a specific problem: sky background, color, sharpness, noise, stars, contrast. At the bottom you will find the add-on tools, that is, the plugins. Apply runs the computation, always starting from the original image.'
  },
  {
    target: 'image-actions',
    title: 'Abracadabra',
    text:
      'Abracadabra measures the image, sets the Process tools and the stretch on its own, and runs the whole processing. The result is a starting point: the chosen values remain editable in the Process and Correct steps, and Reset restores the original image.'
  },
  {
    target: 'panel',
    title: 'The step’s tools',
    text:
      'Only the commands of the selected step appear here. If you rest the mouse pointer on a slider, an explanation appears describing what it does and when it is worth using.',
    workflowStep: 'correct'
  },
  {
    target: 'tab-stretch',
    title: 'The stretch',
    text:
      'A raw frame looks black because the signal takes up a tiny fraction of the sensor’s range. The stretch, in the Correct step, brightens the faint tones and makes the object visible. Auto computes the right stretch for the image, and the sliders below let you fine-tune it. As an alternative to the midtones, the generalized hyperbolic stretch (GHS) concentrates the contrast on a brightness range you choose.',
    workflowStep: 'correct'
  },
  {
    target: 'step-filters',
    title: 'Filters',
    text:
      'Filters gathers the finishing touches, computed in real time by the graphics card: photo filters, noise reduction, detail sharpening, vignette and background removal. Every adjustment shows up immediately in the viewer and can be reset to its starting value.',
    workflowStep: 'filters'
  },
  {
    target: 'step-objects',
    title: 'Objects in the frame',
    text:
      'StarLight compares the object name and the coordinates written in the file with the catalogs, and tells you what you captured, with its apparent size, constellation and a short description. With an astrometric solution, the exact position of the field in the sky, it marks the objects on the image: you choose how many names to show (Essential, Normal or Rich) and which types to hide. If the file has no solution, Plate solve computes it using the local stars, if you have installed them, or the online Gaia catalog. In the Coordinates on the image card you can add the coordinate grid, the orientation and the scale bar.',
    workflowStep: 'objects'
  },
  {
    target: 'step-export',
    title: 'Export',
    text:
      'You save the finished image as PNG, JPEG, WebP, 16-bit TIFF, BMP or FITS. The adjustments are reapplied to the full-resolution data, not to the preview. You can crop, choose a preset, upscale with the Edge-directed method, which follows the direction of edges, add a caption with the capture data and include the object markers and coordinates.',
    workflowStep: 'export'
  },
  {
    target: 'menu-help',
    title: 'The Help menu',
    text:
      'From the Help menu you open the Guide, with an explanation of every tool and the keyboard shortcuts; it also opens with the F1 key. In the same menu you will find the Glossary of astrophotography terms, this quick tour, the update check, the error log, the license, the page for supporting StarLight and the information about the program.'
  }
]
