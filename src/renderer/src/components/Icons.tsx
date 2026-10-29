import type { JSX } from 'react'

/**
 * Icons drawn with a uniform stroke, designed to stay legible even at
 * 18 pixels on a dark background.
 */

interface Props {
  size?: number
  className?: string
}

function wrap(path: JSX.Element, size: number, className?: string): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {path}
    </svg>
  )
}

export function ImportIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M12 3v11" />
      <path d="M8 10l4 4 4-4" />
      <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
    </>,
    size,
    className
  )
}

export function CalibrateIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v16" />
      <path d="M4 12h16" />
      <circle cx="12" cy="12" r="2.5" />
    </>,
    size,
    className
  )
}

export function AlignIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      <circle cx="12" cy="12" r="5" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>,
    size,
    className
  )
}

export function CorrectIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M4 20c4-1 6-4 7-8s3-7 5-8" />
      <path d="M4 20h16" />
      <circle cx="16" cy="4" r="1.6" />
    </>,
    size,
    className
  )
}

export function FiltersIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M4 6h16l-6 7v6l-4-2v-4z" />
    </>,
    size,
    className
  )
}

export function ObjectsIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <circle cx="12" cy="12" r="3" />
      <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-25 12 12)" />
    </>,
    size,
    className
  )
}

export function ExportIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M12 21V10" />
      <path d="M8 14l4-4 4 4" />
      <path d="M4 7V5a2 2 0 012-2h12a2 2 0 012 2v2" />
    </>,
    size,
    className
  )
}

export function HelpIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.2a2.6 2.6 0 015 .9c0 1.7-2.5 2-2.5 3.6" />
      <path d="M12 17.3h.01" />
    </>,
    size,
    className
  )
}

export function InfoIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </>,
    size,
    className
  )
}

export function FolderIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </>,
    size,
    className
  )
}

export function StarIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M12 3l2.2 5.6L20 10l-4.4 3.3L17 19l-5-3-5 3 1.4-5.7L4 10l5.8-1.4z" />
    </>,
    size,
    className
  )
}

export function TrashIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5h6v2" />
      <path d="M6 7l1 13h10l1-13" />
    </>,
    size,
    className
  )
}

export function EyeIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </>,
    size,
    className
  )
}

export function EyeClosedIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M3 4l18 16" />
      <path d="M6.5 7.2C3.9 8.9 2 12 2 12s3.5 6 10 6c2 0 3.7-.6 5.2-1.4" />
      <path d="M21.9 12.4C21.1 10.8 17.9 6 12 6" />
    </>,
    size,
    className
  )
}

export function FitIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5" />
    </>,
    size,
    className
  )
}

/** Two crossed set squares: the crop box. */
export function CropIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M7 3v14h14" />
      <path d="M3 7h14v14" />
    </>,
    size,
    className
  )
}

/** Clipping warning: a histogram hump between the two limits where tones are cut. */
export function ClippingIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M4 18c3 0 4-10 8-10s5 10 8 10" />
      <path d="M4 4v16" />
      <path d="M20 4v16" />
    </>,
    size,
    className
  )
}

export function RestartIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M20 12a8 8 0 11-2.6-5.9" />
      <path d="M20 4v4h-4" />
    </>,
    size,
    className
  )
}

export function CloseIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M6 6l12 12M18 6L6 18" />
    </>,
    size,
    className
  )
}

/** Arrow pointing back: undoes the last edit. */
export function UndoIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 010 11H11" />
    </>,
    size,
    className
  )
}

/** Arrow pointing forward: redoes the undone edit. */
export function RedoIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 000 11H13" />
    </>,
    size,
    className
  )
}

/** Clock with a backward arrow: the edit history. */
export function HistoryIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M3.5 12a8.5 8.5 0 102.5-6" />
      <path d="M3 3.5V8h4.5" />
      <path d="M12 7.5V12l3 2" />
    </>,
    size,
    className
  )
}

export function ForwardIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(<path d="M9 5l7 7-7 7" />, size, className)
}

export function BackIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(<path d="M15 5l-7 7 7 7" />, size, className)
}

/** Stacked layers: data processing, one tool after another. */
export function ProcessIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
      <path d="M3 17.5l9 5 9-5" />
    </>,
    size,
    className
  )
}

export function WandIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M5 19l9-9" />
      <path d="M16 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
      <path d="M6 5l.7 1.4L8 7l-1.3.6L6 9l-.7-1.4L4 7l1.3-.6z" />
    </>,
    size,
    className
  )
}

/** Small downward arrow: opens a menu of choices attached to a button. */
export function ChevronDownIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(<path d="M7 10l5 5 5-5" />, size, className)
}

/** Clockwise circular arrow: rotates the image by a quarter turn. */
export function RotateClockwiseIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v5h-5" />
    </>,
    size,
    className
  )
}

/** Counter-clockwise circular arrow. */
export function RotateCounterclockwiseIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M4 12a8 8 0 1 0 2.34-5.66" />
      <path d="M4 4v5h5" />
    </>,
    size,
    className
  )
}

/** Two mirrored triangles on either side of a dashed vertical axis. */
export function MirrorHorizontalIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M12 3v18" strokeDasharray="2 2.6" />
      <path d="M9 7v10H3z" />
      <path d="M15 7v10h6z" />
    </>,
    size,
    className
  )
}

/** Two mirrored triangles above and below a dashed horizontal axis. */
export function MirrorVerticalIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M3 12h18" strokeDasharray="2 2.6" />
      <path d="M7 9h10V3z" />
      <path d="M7 15h10v6z" />
    </>,
    size,
    className
  )
}

/** Set square with an arc: straightens by rotating to any angle. */
export function StraightenIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M4 20h16" />
      <path d="M4 20 18 8" />
      <path d="M11 20a7 7 0 0 0-1.6-4.5" />
    </>,
    size,
    className
  )
}

/** Four-pointed sparkle with two smaller ones: what's new in a version. */
export function WhatsNewIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M10 3.5l1.6 4.4L16 9.5l-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6z" />
      <path d="M18 14l.7 1.8 1.8.7-1.8.7L18 19l-.7-1.8-1.8-.7 1.8-.7z" />
      <path d="M17.5 3.5v3M16 5h3" />
    </>,
    size,
    className
  )
}

/** Telescope on a tripod: frames taken from the telescope folder. */
export function TelescopeIcon({ size = 20, className }: Props): JSX.Element {
  return wrap(
    <>
      <path d="M3.5 11.5l13-5 1.6 4.2-13 5z" />
      <path d="M18.1 10.7l2.4-.9-1.6-4.2-2.4.9" />
      <path d="M11 13.5l-3.5 7.5M12.5 13l3.5 8M11.7 13.2v7.8" />
    </>,
    size,
    className
  )
}
