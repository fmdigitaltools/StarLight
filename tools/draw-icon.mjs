/**
 * Builds the vector drawing of the StarLight icon.
 *
 * The arms are not drawn by hand but computed as a logarithmic spiral, the
 * same shape that real galaxies follow: the radius grows exponentially
 * with the angle. Each arm is built as a filled shape that tapers away
 * from the nucleus.
 *
 * Usage:  node tools/draw-icon.mjs
 */

import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIDE = 512
const CENTER = SIDE / 2

/** Disk tilt: compresses the vertical axis to give perspective. */
const FLATTENING = 0.74
/** Overall rotation of the disk, in degrees. */
const TILT = -26

/**
 * Logarithmic spiral: r = initialRadius * e^(pitch * angle).
 * A pitch around 0.23 gives moderately wound arms, as in grand-design
 * galaxies.
 */
function point(angle, startRadius, pitch) {
  const r = startRadius * Math.exp(pitch * angle)
  return { x: r * Math.cos(angle), y: r * Math.sin(angle) * FLATTENING }
}

/**
 * Builds the outline of an arm by following the spiral forward along the
 * outer edge and backward along the inner one.
 */
function arm(startAngle, turns, startRadius, pitch, maxWidth) {
  const steps = 140
  const endAngle = startAngle + turns * 2 * Math.PI
  const outer = []
  const inner = []

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const angle = startAngle + (endAngle - startAngle) * t

    const p = point(angle, startRadius, pitch)

    // The arm starts thin, widens right after the nucleus and then
    // tapers again toward the tip.
    const shape = Math.sin(Math.PI * Math.pow(t, 0.62))
    const width = maxWidth * Math.max(0.06, shape)

    // Normal to the curve, derived from the direction between two nearby points.
    const before = point(angle - 0.01, startRadius, pitch)
    const after = point(angle + 0.01, startRadius, pitch)
    const dx = after.x - before.x
    const dy = after.y - before.y
    const length = Math.hypot(dx, dy) || 1
    const nx = -dy / length
    const ny = dx / length

    outer.push([p.x + nx * width, p.y + ny * width])
    inner.push([p.x - nx * width, p.y - ny * width])
  }

  const num = (v) => v.toFixed(2)
  const forward = outer.map(([x, y], i) => (i === 0 ? 'M' : 'L') + num(x) + ' ' + num(y))
  const back = inner
    .reverse()
    .map(([x, y]) => 'L' + num(x) + ' ' + num(y))

  return forward.join(' ') + ' ' + back.join(' ') + ' Z'
}

/** Background stars placed reproducibly. */
function stars(count) {
  let seed = 97
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }

  const elements = []
  for (let i = 0; i < count; i++) {
    const x = 26 + random() * (SIDE - 52)
    const y = 26 + random() * (SIDE - 52)
    // Stars too close to the nucleus would be covered by the glow.
    const distance = Math.hypot(x - CENTER, y - CENTER)
    if (distance < 150) continue
    const radius = (0.9 + random() * 1.9).toFixed(2)
    const opacity = (0.3 + random() * 0.6).toFixed(2)
    elements.push(
      '    <circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) +
        '" r="' + radius + '" opacity="' + opacity + '"/>'
    )
  }
  return elements.join('\n')
}

const arms = [
  { angle: 0, color: 'url(#armA)' },
  { angle: Math.PI, color: 'url(#armB)' }
]

const mainArms = arms
  .map(
    (b) =>
      '      <path d="' +
      arm(b.angle, 0.70, 40, 0.205, 16.5) +
      '" fill="' + b.color + '"/>'
  )
  .join('\n')

const secondaryArms = arms
  .map(
    (b) =>
      '      <path d="' +
      arm(b.angle + 0.75, 0.46, 58, 0.205, 5.5) +
      '" fill="' + b.color + '" opacity="0.42"/>'
  )
  .join('\n')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIDE} ${SIDE}" width="${SIDE}" height="${SIDE}">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#141d33"/>
      <stop offset="42%" stop-color="#0a1020"/>
      <stop offset="100%" stop-color="#04060d"/>
    </linearGradient>

    <radialGradient id="disc" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#9ae0ff" stop-opacity="0.38"/>
      <stop offset="34%" stop-color="#6b86ff" stop-opacity="0.22"/>
      <stop offset="68%" stop-color="#a84bff" stop-opacity="0.11"/>
      <stop offset="100%" stop-color="#ff3dd0" stop-opacity="0"/>
    </radialGradient>

    <radialGradient id="core" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="22%" stop-color="#fff6da"/>
      <stop offset="52%" stop-color="#ffc247" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#ff7a3d" stop-opacity="0"/>
    </radialGradient>

    <linearGradient id="armA" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0%" stop-color="#8ffbe0"/>
      <stop offset="34%" stop-color="#22e8ff"/>
      <stop offset="72%" stop-color="#7d8dff"/>
      <stop offset="100%" stop-color="#ff3dd0"/>
    </linearGradient>

    <linearGradient id="armB" x1="0.9" y1="1" x2="0.1" y2="0">
      <stop offset="0%" stop-color="#46ffa6"/>
      <stop offset="36%" stop-color="#22e8ff"/>
      <stop offset="74%" stop-color="#9d7bff"/>
      <stop offset="100%" stop-color="#ff5ce0"/>
    </linearGradient>

    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.15"/>
      <stop offset="38%" stop-color="#ffffff" stop-opacity="0.025"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>

    <filter id="soft" x="-55%" y="-55%" width="210%" height="210%">
      <feGaussianBlur stdDeviation="5.5" result="blurred"/>
      <feMerge>
        <feMergeNode in="blurred"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <filter id="halo" x="-90%" y="-90%" width="280%" height="280%">
      <feGaussianBlur stdDeviation="22"/>
    </filter>

    <clipPath id="clip">
      <rect x="0" y="0" width="${SIDE}" height="${SIDE}" rx="114" ry="114"/>
    </clipPath>
  </defs>

  <g clip-path="url(#clip)">
    <rect width="${SIDE}" height="${SIDE}" fill="url(#background)"/>

    <g fill="#ffffff">
${stars(42)}
    </g>

    <g transform="translate(${CENTER} ${CENTER}) rotate(${TILT})">
      <ellipse cx="0" cy="0" rx="196" ry="${(196 * FLATTENING).toFixed(1)}" fill="url(#disc)"/>
      <ellipse cx="0" cy="0" rx="138" ry="${(138 * FLATTENING).toFixed(1)}" fill="url(#disc)" opacity="0.7"/>

      <g filter="url(#soft)">
${mainArms}
${secondaryArms}
      </g>

      <g fill="#ffffff">
        <circle cx="96" cy="-24" r="4.2" opacity="0.92"/>
        <circle cx="-96" cy="24" r="4.0" opacity="0.92"/>
        <circle cx="132" cy="44" r="3.0" opacity="0.8"/>
        <circle cx="-132" cy="-44" r="2.9" opacity="0.8"/>
        <circle cx="54" cy="-52" r="2.6" opacity="0.75"/>
        <circle cx="-54" cy="52" r="2.5" opacity="0.75"/>
      </g>

      <ellipse cx="0" cy="0" rx="78" ry="${(78 * FLATTENING).toFixed(1)}" fill="url(#core)" filter="url(#halo)" opacity="0.6"/>
      <ellipse cx="0" cy="0" rx="44" ry="${(44 * FLATTENING).toFixed(1)}" fill="url(#core)"/>
      <ellipse cx="0" cy="0" rx="15" ry="${(15 * FLATTENING).toFixed(1)}" fill="#ffffff"/>
    </g>

    <rect width="${SIDE}" height="${SIDE}" rx="114" ry="114" fill="url(#gloss)"/>
    <rect x="2" y="2" width="${SIDE - 4}" height="${SIDE - 4}" rx="112" ry="112"
          fill="none" stroke="#6fe9ff" stroke-opacity="0.2" stroke-width="3"/>
  </g>
</svg>
`

writeFileSync(join(root, 'resources', 'icon.svg'), svg, 'utf8')
console.log('Drawing updated: resources/icon.svg (' + svg.length + ' characters)')

/*
 * Brand mark for the top bar.
 *
 * It is built with the same spiral as the icon, so the two drawings cannot
 * diverge: changing the parameters above updates both together. Compared
 * with the icon, the background, the stars and the blurs are missing: at
 * twenty-seven pixels they would not be distinguishable and would only
 * cost drawing time.
 */
const markArms = arms
  .map(
    (b) =>
      '          <path d="' +
      arm(b.angle, 0.72, 38, 0.205, 21) +
      '" fill="' + b.color.replace('arm', 'slArm') + '" />'
  )
  .join('\n')

const component = `import type { JSX } from 'react'

/**
 * StarLight brand mark: the same galaxy as the application icon.
 *
 * This file is generated by tools/draw-icon.mjs and must not be edited by
 * hand: changes would be lost at the next regeneration, and the mark would
 * stop matching the icon.
 */
export function GalaxyLogo({ size = 27 }: { size?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 ${SIDE} ${SIDE}"
      width={size}
      height={size}
      className="sl-brand-mark"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="slBraccioA" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="#8ffbe0" />
          <stop offset="34%" stopColor="#22e8ff" />
          <stop offset="72%" stopColor="#7d8dff" />
          <stop offset="100%" stopColor="#ff3dd0" />
        </linearGradient>
        <linearGradient id="slBraccioB" x1="0.9" y1="1" x2="0.1" y2="0">
          <stop offset="0%" stopColor="#46ffa6" />
          <stop offset="36%" stopColor="#22e8ff" />
          <stop offset="74%" stopColor="#9d7bff" />
          <stop offset="100%" stopColor="#ff5ce0" />
        </linearGradient>
        <radialGradient id="slNucleo">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="24%" stopColor="#fff6da" />
          <stop offset="56%" stopColor="#ffc247" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#ff7a3d" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g transform="translate(${CENTER} ${CENTER}) rotate(${TILT})">
${markArms}
        <ellipse cx="0" cy="0" rx="46" ry="${(46 * FLATTENING).toFixed(1)}" fill="url(#slNucleo)" />
        <ellipse cx="0" cy="0" rx="16" ry="${(16 * FLATTENING).toFixed(1)}" fill="#ffffff" />
      </g>
    </svg>
  )
}
`

writeFileSync(join(root, 'src/renderer/src/components/GalaxyLogo.tsx'), component, 'utf8')
console.log('Brand mark generated: src/renderer/src/components/GalaxyLogo.tsx')
