/**
 * Check: the crop box dragged in the viewer
 * (`dragCrop`, used by the Crop button).
 *
 * - dragged from the inside it moves without changing size and does not
 *   leave the image;
 * - with a free shape each handle moves only its own sides, the opposite
 *   side stays fixed, and the box does not shrink below the minimum side;
 * - with a ratio or a preset format the pixel shape stays the same from
 *   every handle, even when pushing outside the image; the opposite corner
 *   (or the opposite side) stays fixed;
 * - no result leaves the image, over thousands of random trials.
 *
 * No external files needed.
 */
import { dragCrop, type CropGrip, type Crop } from '../src/core/export/crop'

let problems = 0
function check(condition: boolean, description: string): void {
  if (condition) console.log('  ok   ' + description)
  else {
    problems++
    console.log('  NO   ' + description)
  }
}

const W = 3000
const H = 2000
const neighbor = (a: number, b: number, tolerance = 1e-9): boolean => Math.abs(a - b) <= tolerance
const inside = (r: Crop): boolean =>
  r.x >= -1e-12 && r.y >= -1e-12 && r.x + r.width <= 1 + 1e-12 && r.y + r.height <= 1 + 1e-12
const pixelShape = (r: Crop): number => (r.width * W) / (r.height * H)

const base: Crop = { x: 0.2, y: 0.25, width: 0.5, height: 0.4 }

console.log('Moving')
{
  const r = dragCrop(base, 'inside', 0.1, -0.05, null, W, H)
  check(neighbor(r.x, 0.3) && neighbor(r.y, 0.2) && r.width === base.width && r.height === base.height, 'moves by the pointer distance, same size')
  const outside = dragCrop(base, 'inside', 5, 5, null, W, H)
  check(neighbor(outside.x, 0.5) && neighbor(outside.y, 0.6) && outside.width === base.width, 'pushed outside it stops at the edge')
}

console.log('Free shape')
{
  const e = dragCrop(base, 'e', 0.1, 0.3, null, W, H)
  check(neighbor(e.x, 0.2) && neighbor(e.width, 0.6) && e.y === base.y && e.height === base.height, 'right side: only the width changes')
  const o = dragCrop(base, 'w', -0.1, 0, null, W, H)
  check(neighbor(o.x, 0.1) && neighbor(o.x + o.width, 0.7), 'left side: the right one stays fixed')
  const no = dragCrop(base, 'nw', 0.05, 0.1, null, W, H)
  check(neighbor(no.x + no.width, 0.7) && neighbor(no.y + no.height, 0.65) && neighbor(no.x, 0.25) && neighbor(no.y, 0.35), 'top-left corner: the opposite one stays fixed')
  const narrow = dragCrop(base, 'e', -10, 0, null, W, H)
  check(neighbor(narrow.width, 0.05) && neighbor(narrow.x, 0.2), 'does not become narrower than the minimum, nor flip over')
  const wide = dragCrop(base, 'se', 10, 10, null, W, H)
  check(neighbor(wide.x + wide.width, 1) && neighbor(wide.y + wide.height, 1), 'pulled outside it stops at the edge')
}

console.log('Shape to preserve')
{
  const ratio = 16 / 9
  // A box that is already 16:9, as the Export step leaves it.
  const height = 0.4
  const width = (height * H * ratio) / W
  const r0: Crop = { x: 0.3, y: 0.3, width, height }
  const grips: CropGrip[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
  for (const p of grips) {
    for (const [dx, dy] of [[0.1, 0.05], [-0.2, 0.3], [3, 3], [-3, -3], [0.02, -0.4]]) {
      const r = dragCrop(r0, p, dx, dy, ratio, W, H)
      if (!neighbor(pixelShape(r), ratio, 1e-6) || !inside(r)) {
        check(false, 'handle ' + p + ' (' + dx + ', ' + dy + '): shape ' + pixelShape(r).toFixed(4))
      }
    }
  }
  check(problems === 0, 'from every handle the shape stays 16:9 and the box stays inside the image')

  const se = dragCrop(r0, 'se', 0.1, 0, ratio, W, H)
  check(neighbor(se.x, r0.x) && neighbor(se.y, r0.y) && se.width > r0.width, 'bottom-right corner: the top-left one stays fixed, and the box grows')
  const no = dragCrop(r0, 'nw', 0.05, 0.05, ratio, W, H)
  check(neighbor(no.x + no.width, r0.x + r0.width) && neighbor(no.y + no.height, r0.y + r0.height), 'top-left corner: the bottom-right one stays fixed')
  const e = dragCrop(r0, 'e', -0.05, 0, ratio, W, H)
  check(
    neighbor(e.x, r0.x) && neighbor(e.y + e.height / 2, r0.y + r0.height / 2) && e.width < r0.width,
    'right side: the left one stays fixed, vertical center unchanged'
  )
  const large = dragCrop(r0, 'se', 5, 5, ratio, W, H)
  check(neighbor(large.x, r0.x) && neighbor(large.y, r0.y) && (neighbor(large.x + large.width, 1) || neighbor(large.y + large.height, 1)), 'pulled past the edge it stops touching it, keeping its shape')
}

console.log('Random trials')
{
  let seeds = 12345
  const testCase = (): number => {
    seeds = (seeds * 1103515245 + 12345) % 2147483648
    return seeds / 2147483648
  }
  const grips: CropGrip[] = ['inside', 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
  let outside = 0
  let shape = 0
  for (let i = 0; i < 5000; i++) {
    const ratio = testCase() < 0.3 ? null : [1, 4 / 5, 16 / 9, 9 / 16, 3 / 2][Math.floor(testCase() * 5)]
    let r0: Crop
    if (ratio === null) {
      const l = 0.05 + testCase() * 0.95
      const a = 0.05 + testCase() * 0.95
      r0 = { x: testCase() * (1 - l), y: testCase() * (1 - a), width: l, height: a }
    } else {
      // A valid box: with the right shape and neither side below the minimum.
      const k = (ratio * H) / W
      const minimum = Math.max(0.05, 0.05 / k)
      const max = Math.min(1, 1 / k)
      const aa = minimum + testCase() * (max - minimum)
      const l = aa * k
      r0 = { x: testCase() * (1 - l), y: testCase() * (1 - aa), width: l, height: aa }
    }
    const p = grips[Math.floor(testCase() * grips.length)]
    const r = dragCrop(r0, p, (testCase() - 0.5) * 3, (testCase() - 0.5) * 3, ratio, W, H)
    if (!inside(r) || r.width < 0.05 - 1e-9 || r.height < 0.05 - 1e-9) outside++
    if (ratio !== null && !neighbor(pixelShape(r), ratio, 1e-6)) shape++
  }
  check(outside === 0, 'no box outside the image or below the minimum (' + outside + ' of 5000)')
  check(shape === 0, 'the imposed shape always stays the same (' + shape + ' exceptions out of 5000)')
}

if (problems > 0) {
  console.log('\n' + problems + ' problems.')
  process.exit(1)
}
console.log('\nAll good.')
