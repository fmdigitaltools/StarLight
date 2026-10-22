"""Generates the test files of the rare compressions (tools/test-rare-formats.ts)
with tools independent of StarLight: astropy (cfitsio) for the HCOMPRESS_1
and PLIO_1 FITS files, the Python package "xisf" for the XISF files, the
"zstandard" library for the Zstandard streams and for the XISF files built by
hand following the XISF 1.0 specification. The images are synthetic (sky with
stars and noise).

Usage (in a virtual environment outside the project):
    pip install astropy xisf zstandard numpy
    python generate-rare-samples.py <test data folder>/<rare formats folder>
    python generate-rare-samples.py <folder> <a real FITS>   extended test:
        adds a large image and crops of a real shot
        (not to be copied into the project if the shot is not redistributable)

The description of the files is written to expected.json. Entries added by
hand (the real third-party XISF file) are kept.

Note: astropy 8 hangs (corrupted memory) when compressing with PLIO_1 values
above about one million; this is why the 32-bit mask stays below that limit.
"""
import sys, os, json, struct, hashlib
import numpy as np
import zstandard
from astropy.io import fits
import xisf as xisfpkg

# Object name written in the FITS samples and in those built by hand.
OBJECT = 'TEST'

out = sys.argv[1]
real = sys.argv[2] if len(sys.argv) > 2 else None
os.makedirs(out, exist_ok=True)
expected = {}


def write_reference(b):
    """Equal references (same image with different encodings) are written only once."""
    name = 'ref-' + hashlib.sha1(b).hexdigest()[:10] + '.bin'
    if not os.path.exists(os.path.join(out, name)):
        open(os.path.join(out, name), 'wb').write(b)
    return name
rng = np.random.default_rng(7)


def sky(h, w, background=800.0, noise=12.0, stars=60, seed=1):
    r = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w]
    img = background + 0.3 * x + 0.2 * y + r.normal(0, noise, (h, w))
    for _ in range(stars):
        cx, cy = r.uniform(0, w), r.uniform(0, h)
        a, s = r.uniform(200, 20000), r.uniform(0.8, 2.5)
        img += a * np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s))
    img += 900 * np.exp(-((x - w * 0.4) ** 2 / (w * 0.15) ** 2 + (y - h * 0.6) ** 2 / (h * 0.2) ** 2))
    return img


def save_fits(name, data, description, **kw):
    hdu = fits.CompImageHDU(data, **kw)
    hdu.header['OBJECT'] = OBJECT
    p = os.path.join(out, name)
    fits.HDUList([fits.PrimaryHDU(), hdu]).writeto(p, overwrite=True)
    with fits.open(p) as f:
        read = np.asarray(f[1].data).astype('<f8')
    reference = write_reference(read.astype('<f4').tobytes())
    orig = np.asarray(data).astype('<f8')
    err = np.abs(read - orig)
    expected[name] = {'type': 'fits', 'description': description, 'reference': reference,
                      'width': int(data.shape[1]), 'height': int(data.shape[0]),
                      'maxErrorFromOriginal': float(err.max()), 'rmsErrorFromOriginal': float(np.sqrt((err ** 2).mean())),
                      'bytes': os.path.getsize(p), 'object': OBJECT}


def save_xisf_reference(name, arr_planar, dtype, channels, description, hh, ww):
    reference = write_reference(np.ascontiguousarray(arr_planar).astype('<' + dtype[:2]).tobytes())
    expected[name] = {'type': 'xisf', 'description': description, 'reference': reference, 'dtype': dtype,
                      'channels': channels, 'width': int(ww), 'height': int(hh),
                      'bytes': os.path.getsize(os.path.join(out, name))}


def write_xisf(name, block, attributes, description, reference, dtype, channels, hh, ww):
    """Signature, XML length, 4 reserved bytes, XML, then the attached block (aligned to 4096)."""
    def xml_for(pos):
        attr = ' '.join(f'{k}="{v}"' for k, v in attributes.items())
        return ('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<xisf version="1.0" xmlns="http://www.pixinsight.com/xisf" '
                'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
                f'<Image {attr} location="attachment:{pos}:{len(block)}">\n'
                f'<FITSKeyword name="OBJECT" value="&apos;{OBJECT}&apos;" comment="object name"/>\n'
                '<Property id="Instrument:ExposureTime" type="Float32" value="30"/>\n'
                '</Image>\n<Metadata><Property id="XISF:CreatorApplication" type="String">by hand</Property></Metadata>\n</xisf>')
    pos = 4096
    x = xml_for(pos).encode('utf-8')
    while 16 + len(x) > pos:
        pos += 4096
        x = xml_for(pos).encode('utf-8')
    data = b'XISF0100' + struct.pack('<I', len(x)) + b'\0\0\0\0' + x
    data += b'\0' * (pos - len(data)) + block
    open(os.path.join(out, name), 'wb').write(data)
    save_xisf_reference(name, reference, dtype, channels, description, hh, ww)
    expected[name]['object'] = OBJECT


def shuffle(b, n):
    a = np.frombuffer(b, dtype='u1')
    k = len(a) // n
    return np.ascontiguousarray(a[:k * n].reshape(k, n).T).tobytes() + a[k * n:].tobytes()


h, w = 77, 101
base = sky(h, w, stars=20)
i16 = np.clip(base, -32768, 32767).astype('>i2')
u16 = np.clip(base * 3, 0, 65535).astype('>u2')
i32 = (base * 40000).astype('>i4')
u8 = np.clip(base / 80, 0, 255).astype('u1')
f32 = (base / 65535.0).astype('>f4')

# Lossless HCOMPRESS
save_fits('hc-i16.fz', i16, 'HCOMPRESS int16 lossless, default tiles', compression_type='HCOMPRESS_1')
save_fits('hc-i16-tiles.fz', i16, 'HCOMPRESS int16, 20x24 tiles with partial edges', compression_type='HCOMPRESS_1', tile_shape=(20, 24))
save_fits('hc-u16.fz', u16, 'HCOMPRESS uint16 (BZERO 32768)', compression_type='HCOMPRESS_1', tile_shape=(64, 64))
save_fits('hc-i32.fz', i32, 'HCOMPRESS int32 with values up to 8e8', compression_type='HCOMPRESS_1', tile_shape=(77, 101))
save_fits('hc-u8.fz', u8, 'HCOMPRESS uint8', compression_type='HCOMPRESS_1', tile_shape=(32, 101))
# Lossy HCOMPRESS: scale, with and without smoothing
save_fits('hc-i16-s4.fz', i16, 'HCOMPRESS int16 scale 4', compression_type='HCOMPRESS_1', tile_shape=(77, 101), hcomp_scale=4)
save_fits('hc-i16-s4-smooth.fz', i16, 'HCOMPRESS int16 scale 4 smoothed', compression_type='HCOMPRESS_1', tile_shape=(77, 101), hcomp_scale=4, hcomp_smooth=1)
save_fits('hc-i16-s25-smooth.fz', i16, 'HCOMPRESS int16 scale 25 smoothed, 32x32 tiles', compression_type='HCOMPRESS_1', tile_shape=(32, 32), hcomp_scale=25, hcomp_smooth=1)
save_fits('hc-i32-s100-smooth.fz', i32, 'HCOMPRESS int32 scale 100 smoothed', compression_type='HCOMPRESS_1', tile_shape=(40, 48), hcomp_scale=100, hcomp_smooth=1)
# HCOMPRESS on quantized floats
save_fits('hc-f32-d1.fz', f32, 'HCOMPRESS float32 SUBTRACTIVE_DITHER_1', compression_type='HCOMPRESS_1', tile_shape=(16, 32), quantize_level=16, quantize_method=1, dither_seed=5)
save_fits('hc-f32-d2.fz', f32, 'HCOMPRESS float32 SUBTRACTIVE_DITHER_2', compression_type='HCOMPRESS_1', tile_shape=(16, 32), quantize_level=16, quantize_method=2, dither_seed=9)
f32z = f32.copy()
f32z[10:20, 30:60] = 0
save_fits('hc-f32-d2-zeros.fz', f32z, 'HCOMPRESS float32 SUBTRACTIVE_DITHER_2 with zero areas', compression_type='HCOMPRESS_1', tile_shape=(16, 32), quantize_level=16, quantize_method=2, dither_seed=9)
save_fits('hc-f32-nodither.fz', f32, 'HCOMPRESS float32 without dithering', compression_type='HCOMPRESS_1', tile_shape=(77, 101), quantize_level=16, quantize_method=-1)
save_fits('hc-f32-s25-smooth.fz', f32, 'HCOMPRESS float32 dither 1, scale 2.5 sigma, smoothed', compression_type='HCOMPRESS_1', tile_shape=(77, 101), quantize_level=16, quantize_method=1, dither_seed=3, hcomp_scale=2.5, hcomp_smooth=1)
# PLIO: masks
mask = np.zeros((h, w), dtype='>i2')
mask[(base > 2000)] = 1
mask[20:40, 30:80] = 5
mask[60:65, :] = 300
mask[::7, ::11] = rng.integers(0, 4000, mask[::7, ::11].shape)
save_fits('plio-i16.fz', mask, 'PLIO_1 int16 mask', compression_type='PLIO_1')
m32 = mask.astype('>i4')
m32[50:52, :] = 1000000
m32[0, :] = np.arange(w) * 4000
save_fits('plio-i32.fz', m32, 'PLIO_1 int32 mask up to 1e6', compression_type='PLIO_1')
save_fits('plio-u8.fz', (mask % 256).astype('u1'), 'PLIO_1 uint8 mask, tiles of 10 rows', compression_type='PLIO_1', tile_shape=(10, 101))
save_fits('plio-empty.fz', np.zeros((h, w), dtype='>i2'), 'PLIO_1 all-zero mask', compression_type='PLIO_1')

# XISF written by the xisf package (GPL-3.0, only to generate the samples)
rgb16 = np.stack([u16.astype('<u2'),
                  np.clip(u16.astype(np.int64) * 0.8, 0, 65535).astype('<u2'),
                  np.clip(u16.astype(np.int64) // 2 + 300, 0, 65535).astype('<u2')], axis=2)
mono16 = u16.astype('<u2')[:, :, None]
monof = f32.astype('<f4')[:, :, None]
rgbf = (rgb16.astype('<f4') / 65535.0).astype('<f4')
for label, arr, dt, c in [('mono16', mono16, 'u2', 1), ('rgb16', rgb16, 'u2', 3), ('monof32', monof, 'f4', 1), ('rgbf32', rgbf, 'f4', 3)]:
    for codec in [None, 'zlib', 'lz4', 'lz4hc', 'zstd']:
        for sh in ([False] if codec is None else [False, True]):
            name = f'pkg-{label}-{codec or "none"}{"+sh" if sh else ""}.xisf'
            used = xisfpkg.XISF.write(os.path.join(out, name), arr, creator_app='test', image_metadata={},
                                      codec=codec, shuffle=sh, level=(19 if codec == 'zstd' and label == 'rgbf32' else None))
            save_xisf_reference(name, np.transpose(arr, (2, 0, 1)), dt, c, f'xisf package, {label}, {used[1]}', arr.shape[0], arr.shape[1])

# XISF built by hand, on a larger image (191 KB: several 128 KB Zstandard blocks)
h, w = 157, 203
u16m = np.clip(sky(h, w) * 3, 0, 65535).astype('<u2')
rgb16 = np.stack([u16m, np.clip(u16m.astype(np.int64) * 0.8, 0, 65535).astype('<u2'),
                  np.clip(u16m.astype(np.int64) // 2 + 300, 0, 65535).astype('<u2')], axis=2)
planar16 = np.transpose(rgb16, (2, 0, 1)).astype('<u2')
raw = planar16.tobytes()
geo = {'geometry': f'{w}:{h}:3', 'sampleFormat': 'UInt16', 'colorSpace': 'RGB'}
write_xisf('hand-rgb16-zstd.xisf', zstandard.ZstdCompressor(level=9).compress(raw), {**geo, 'compression': f'zstd:{len(raw)}'}, 'by hand, zstd level 9', planar16, 'u2', 3, h, w)
write_xisf('hand-rgb16-zstd+sh.xisf', zstandard.ZstdCompressor(level=3).compress(shuffle(raw, 2)), {**geo, 'compression': f'zstd+sh:{len(raw)}:2'}, 'by hand, zstd+sh', planar16, 'u2', 3, h, w)
pieces = [raw[:50000], raw[50000:150000], raw[150000:]]
cpieces = [zstandard.ZstdCompressor(level=1).compress(p) for p in pieces]
write_xisf('hand-rgb16-zstd-subblocks.xisf', b''.join(cpieces), {**geo, 'compression': f'zstd:{len(raw)}', 'subblocks': ':'.join(f'{len(c)},{len(p)}' for c, p in zip(cpieces, pieces))}, 'by hand, zstd in three sub-blocks', planar16, 'u2', 3, h, w)
norm = np.transpose(planar16, (1, 2, 0)).astype('<f4') * 2.0 - 1000.0
nb = norm.tobytes()
write_xisf('hand-rgbf32-normal-zstd+sh.xisf', zstandard.ZstdCompressor(level=12).compress(shuffle(nb, 4)),
           {'geometry': f'{w}:{h}:3', 'sampleFormat': 'Float32', 'colorSpace': 'RGB', 'pixelStorage': 'Normal', 'bounds': '-1000:130070', 'compression': f'zstd+sh:{len(nb)}:4'},
           'by hand, interleaved float32, bounds -1000:130070, zstd+sh', np.transpose(norm, (2, 0, 1)), 'f4b', 3, h, w)
if real:
    # Only in the extended test: 1.5 MB of reference is too much for the project's samples.
    big = np.clip(sky(768, 1024, seed=3) * 3, 0, 65535).astype('<u2')
    write_xisf('hand-mono16-large-zstd.xisf', zstandard.ZstdCompressor(level=19).compress(big.tobytes()), {'geometry': '1024:768:1', 'sampleFormat': 'UInt16', 'colorSpace': 'Gray', 'compression': f'zstd:{big.nbytes}'}, 'by hand, 1024x768 uint16, zstd level 19 (several 128 KB blocks)', big, 'u2', 1, 768, 1024)

# Bare Zstandard streams: special cases of the format
def save_zst(name, raw, compressed, description):
    open(os.path.join(out, name), 'wb').write(compressed)
    expected[name] = {'type': 'zstd', 'description': description, 'reference': write_reference(raw), 'bytes': len(compressed)}

text = (' '.join(str(x) for x in range(12000))).encode()
save_zst('empty.zst', b'', zstandard.ZstdCompressor().compress(b''), 'empty stream')
save_zst('one.zst', b'x', zstandard.ZstdCompressor().compress(b'x'), 'one byte')
save_zst('text-l1.zst', text, zstandard.ZstdCompressor(level=1).compress(text), 'text, level 1')
save_zst('text-l22.zst', text, zstandard.ZstdCompressor(level=22).compress(text), 'text, level 22')
save_zst('text-l-7.zst', text, zstandard.ZstdCompressor(level=-7).compress(text), 'text, level -7 (fast)')
rnd = rng.bytes(5000)
save_zst('random.zst', rnd, zstandard.ZstdCompressor(level=3).compress(rnd), 'random bytes (uncompressed blocks)')
save_zst('zeros.zst', bytes(300000), zstandard.ZstdCompressor(level=3).compress(bytes(300000)), 'zeros (RLE blocks)')
save_zst('checksum.zst', text, zstandard.ZstdCompressor(level=5, write_checksum=True).compress(text), 'with the XXH64 checksum')
save_zst('no-size.zst', text, zstandard.ZstdCompressor(level=5, write_content_size=False).compress(text), 'without the content size')
co = zstandard.ZstdCompressor(level=4).compressobj()
chunks = b''.join(co.compress(text[i:i + 9000]) for i in range(0, len(text), 9000)) + co.flush()
save_zst('chunked.zst', text, chunks, 'written in chunks (continuous stream)')
f1 = zstandard.ZstdCompressor(level=2).compress(text[:20000])
f2 = zstandard.ZstdCompressor(level=8).compress(text[20000:])
skippable = struct.pack('<II', 0x184D2A53, 6) + b'StarLi'
save_zst('multiple-frames.zst', text, f1 + skippable + f2, 'two frames with a skippable frame in between')
image = np.clip(sky(200, 400, seed=5) * 3, 0, 65535).astype('<u2').tobytes()
save_zst('image-l19.zst', image, zstandard.ZstdCompressor(level=19).compress(image), '16-bit image 400x200, level 19, 128 KB blocks')

if real:
    with fits.open(real) as f:
        d = np.asarray(f[0].data)
    d = d[300:812, 400:1040] if d.ndim == 2 else d[0, 300:812, 400:1040]
    d16 = d.astype(np.int64)
    d16 = (d16 - 32768).astype('>i2') if d16.max() > 32767 else d16.astype('>i2')
    save_fits('real-hc.fz', d16, 'real shot (640x512 crop), lossless HCOMPRESS', compression_type='HCOMPRESS_1')
    save_fits('real-hc-s8-smooth.fz', d16, 'real shot, HCOMPRESS scale 8 smoothed', compression_type='HCOMPRESS_1', hcomp_scale=8, hcomp_smooth=1, tile_shape=(128, 128))
    df = (d.astype('<f4') / 65535).astype('>f4')
    save_fits('real-hc-f32.fz', df, 'real shot float32, dither 2, scale 1.5 smoothed', compression_type='HCOMPRESS_1', quantize_level=8, quantize_method=2, hcomp_scale=1.5, hcomp_smooth=1)
    save_fits('real-plio.fz', (d > np.percentile(d, 99)).astype('>i2') * 7, 'real shot, PLIO_1 mask', compression_type='PLIO_1')
    rr = d.astype('<u2')
    write_xisf('real-zstd+sh.xisf', zstandard.ZstdCompressor(level=6).compress(shuffle(rr.tobytes(), 2)), {'geometry': f'{rr.shape[1]}:{rr.shape[0]}:1', 'sampleFormat': 'UInt16', 'compression': f'zstd+sh:{rr.nbytes}:2'}, 'real shot, zstd+sh', rr, 'u2', 1, rr.shape[0], rr.shape[1])

# Entries added by hand (the real third-party XISF file) are kept.
previous = os.path.join(out, 'expected.json')
if os.path.exists(previous):
    for k, v in json.load(open(previous, encoding='utf-8')).items():
        if k not in expected and os.path.exists(os.path.join(out, k)):
            expected[k] = v
json.dump(expected, open(os.path.join(out, 'expected.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
for k, v in expected.items():
    print(k.ljust(42), str(v.get('bytes', '')).rjust(8), v.get('maxErrorFromOriginal', ''), v.get('rmsErrorFromOriginal', ''))
