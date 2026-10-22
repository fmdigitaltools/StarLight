/**
 * Test of the processing engine on a sample frame.
 * Usage: node tools/run-test.mjs
 */
import { readFileSync } from 'node:fs'
import { readFits } from '../src/core/fits/reader'
import { debayer } from '../src/core/image/debayer'
import { computeImageStats } from '../src/core/image/stats'
import { autoStretch, applyStretch } from '../src/core/image/stretch'
import { testFile } from './test-files.mjs'

const path = process.argv[2] ?? testFile('synthetic-frame')
const buf = new Uint8Array(readFileSync(path))

console.log('--- FITS READ ---')
const t0 = performance.now()
const res = readFits(buf)
console.log('read time: ' + (performance.now() - t0).toFixed(0) + ' ms')
console.log('dimensions: ' + res.image.width + ' x ' + res.image.height + ', channels: ' + res.image.channels)
console.log('bitpix: ' + res.bitpix + ', header cards: ' + Object.keys(res.header.cards).length)

console.log('--- METADATA ---')
const m = res.metadata
console.log('object: ' + m.object + ' | instrument: ' + m.instrument)
console.log('RA: ' + m.ra + ' degrees | DEC: ' + m.dec + ' degrees')
console.log('exposure: ' + m.exposure + ' s | gain: ' + m.gain + ' | temp: ' + m.sensorTemp)
console.log('bayer: ' + m.bayer + ' | type: ' + m.frameType + ' | filter: ' + m.filter)
console.log('field scale: ' + (m.pixelScale ? m.pixelScale.toFixed(3) + ' arcsec/px' : 'n/a'))
console.log('date: ' + m.dateObs)

console.log('--- DEMOSAICING ---')
const t1 = performance.now()
const rgb = debayer(res.image, m.bayer)
console.log('time: ' + (performance.now() - t1).toFixed(0) + ' ms, channels: ' + rgb.channels)

console.log('--- STATISTICS ---')
const st = computeImageStats(rgb)
console.log('min ' + st.min.toFixed(5) + ' max ' + st.max.toFixed(5))
console.log('median ' + st.median.toFixed(5) + ' MAD ' + st.mad.toFixed(6))
console.log('mean ' + st.mean.toFixed(5) + ' saturated ' + st.saturatedPct.toFixed(3) + '%')

console.log('--- AUTOSTRETCH ---')
const t2 = performance.now()
const p = autoStretch(rgb)
console.log('computation: ' + (performance.now() - t2).toFixed(0) + ' ms')
console.log('shadows ' + p.shadows.toFixed(5) + ' midtones ' + p.midtones.toFixed(5))
const t3 = performance.now()
const out = applyStretch(rgb, p)
console.log('application: ' + (performance.now() - t3).toFixed(0) + ' ms')
const st2 = computeImageStats(out)
console.log('median after stretch: ' + st2.median.toFixed(4) + ' (about 0.15 expected, the reference sky background)')
console.log('mean after stretch: ' + st2.mean.toFixed(4))

console.log('--- INSTRUMENT ---')
const info = m.instrumentInfo
if (info) {
  console.log('model: ' + info.model + ' | declared name: ' + info.reportedName)
  console.log('unit: ' + info.deviceId + ' | firmware: ' + info.firmware)
  console.log('wide-angle camera: ' + (info.wideCamera ? 'yes' : 'no'))
  console.log('total exposure: ' + info.totalExposure + ' s')
  console.log('focuser: ' + info.focusPosition + ' | bias: ' + info.bias)
  console.log('site: lat ' + info.siteLatitude + ', lon ' + info.siteLongitude)
} else {
  console.log('no additional instrument data')
}
console.log('stacked frames: ' + m.stackCount + ' | total exposure: ' + m.totalExposure)
