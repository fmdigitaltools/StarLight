/**
 * Helpers for testing plugins outside the application, in Node.
 *
 * In the app every plugin runs in a Web Worker created from a blob. Here
 * the same source (isolation prelude plus plugin code) runs in a Node
 * thread, with a small preamble that imitates the two browser worker
 * functions used by the prelude (`postMessage` and `addEventListener`).
 * The sandbox, the time limit and the checks on the result are exactly
 * those of the app (core/plugin/isolation.ts).
 *
 * Difference to keep in mind: Node has no page security policy, so only
 * the prelude counts here. This makes it the strictest test.
 */
import { Worker } from 'node:worker_threads'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { composeSource, type IsolatedWorker, type PluginResponse } from '../src/core/plugin/isolation'

const NODE_PREAMBLE = `import { parentPort as __port } from 'node:worker_threads';
globalThis.postMessage = (m, t) => __port.postMessage(m, t);
globalThis.addEventListener = (type, f) => { if (type === 'message') __port.on('message', (data) => f({ data })); };
`

/** Creates the isolated worker for a plugin, in a Node thread. */
export function nodeWorker(code: string): IsolatedWorker {
  const folder = mkdtempSync(join(tmpdir(), 'starlight-plugin-'))
  const file = join(folder, 'isolated-plugin.mjs')
  writeFileSync(file, composeSource(code, NODE_PREAMBLE))
  const thread = new Worker(pathToFileURL(file))
  const clean = (): void => {
    try {
      rmSync(folder, { recursive: true, force: true })
    } catch {
      // Temporary file: leaving it behind does no harm.
    }
  }
  return {
    send: (m, transferables) => thread.postMessage(m, transferables),
    onResponse: (f) => thread.on('message', (r: PluginResponse) => f(r)),
    onError: (f) => thread.on('error', (e: Error) => f(e.message)),
    terminate: () => {
      void thread.terminate().finally(clean)
    }
  }
}

/* ---- Minimal PNG, to write icons and previews ---- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function block(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head.subarray(0, 4), body, tail])
}

/** Encodes 8-bit RGBA pixels (rows from the top) into a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    block('IHDR', ihdr),
    block('IDAT', deflateSync(rows, { level: 9 })),
    block('IEND', new Uint8Array(0))
  ])
}
