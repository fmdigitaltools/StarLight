# Writing a plugin for StarLight

A plugin adds an image transformation to StarLight, for example an effect, a
correction or a rotation. It appears in the **Process** step, in the **Extra
tools** tab, and runs after all of StarLight's own tools, in the order in
which the plugins were enabled.

The plugins in this folder (`negative`, `orton-effect`, `star-separation`,
`green-removal`…) are complete examples to copy. The full guide, with every
rejection message and its remedy, is `docs/plugin.md`.

## What a plugin is made of

A plugin is a folder containing the following files.

| File | Required | Purpose |
|---|---|---|
| `plugin.json` | yes | the manifest: who wrote it, license, parameters, translations |
| `plugin.js` | yes | the code, with the `processImage` function |
| icon | yes | square image shown in the gallery |
| before and after previews | yes | two images showing the effect |
| `LICENSE`, `LICENCE`, `COPYING`, `README` (also `.md` or `.txt`; `LICENZA` and `LEGGIMI` too) | no | kept, up to 512 KB each |

Every other file is ignored. A plugin is installed by choosing its folder or
a ZIP archive containing it.

`plugin.js` can weigh up to 2 MB, `plugin.json` up to 64 KB and each image up
to 4 MB and 4096 pixels per side. Images must be PNG, JPEG or WebP. StarLight
checks the format and the dimensions from the file content, not only from the
extension. File names cannot be names reserved by Windows (`con`, `nul`,
`com1`…), contain paths, or end with a dot or a space.

A ZIP archive can contain at most 200 files and 40 MB once extracted (the
archive itself at most 50 MB), a single `plugin.json`, no path leading outside
the folder and no password-protected file; only "deflate" compression or no
compression is accepted.

The same checks are repeated at every startup on the plugins already
installed. A damaged plugin, or one copied by hand into the plugin folder, is
not loaded, and the gallery shows it as "not loaded" with the problem found.

## The manifest, `plugin.json`

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.1.0",
  "author": "Author name",
  "license": "MIT",
  "category": "photography",
  "description": "One or two sentences in English that say what it does and when it is useful.",
  "icon": "icon.png",
  "previews": { "before": "before.png", "after": "after.png" },
  "minimumStarLightVersion": "0.4.0",
  "site": "https://example.org/my-plugin",
  "geometry": "transformed",
  "parameters": [ ... ],
  "translations": { ... }
}
```

| Field | Rule |
|---|---|
| `id` | 2 to 40 characters: lowercase letters, digits and hyphens, not a name reserved by Windows. It is also the folder name, and must differ from the ids of the bundled plugins. |
| `name` | up to 60 characters |
| `version` | in the form `1.2.3` |
| `author` | up to 80 characters |
| `license` | an open source license in SPDX form (see below) |
| `category` | `astrophotography` or `photography` |
| `description` | up to 600 characters, in English |
| `icon`, `previews` | simple file names inside the folder (no paths) |
| `minimumStarLightVersion` | the oldest StarLight it works with, form `0.4.0` |
| `site` | optional, `https://` addresses only, up to 300 characters |
| `geometry` | optional: `unchanged` (default), `transformed` or `unknown`. See "If the plugin moves pixels". |
| `parameters` | list, at most 24 |
| `translations` | optional: texts in other languages (see below) |

No text may contain control characters or characters that reverse the
writing direction.

### Accepted licenses

StarLight installs only free plugins: whoever uses them must be able to read,
modify and share them. These SPDX licenses are accepted, also combined with
`OR` and `AND` (for example `MIT OR Apache-2.0`):

0BSD, AFL-3.0, AGPL-3.0-only, AGPL-3.0-or-later, Apache-2.0, Artistic-2.0,
BSD-2-Clause, BSD-3-Clause, BSL-1.0, CECILL-2.1, ECL-2.0, EPL-1.0, EPL-2.0,
EUPL-1.1, EUPL-1.2, GPL-2.0-only, GPL-2.0-or-later, GPL-3.0-only,
GPL-3.0-or-later, ISC, LGPL-2.1-only, LGPL-2.1-or-later, LGPL-3.0-only,
LGPL-3.0-or-later, MIT, MIT-0, MPL-2.0, MS-PL, MulanPSL-2.0, NCSA, OSL-3.0,
PostgreSQL, UPL-1.0, Unlicense, Zlib.

A plugin without a license, or with a different one, is not installed.

### Parameters

A plugin draws nothing: it declares its parameters and StarLight shows them
with the same look as every other control. Every parameter has `id` (starts
with a letter; letters, digits and underscores; up to 40 characters),
`label` (up to 60 characters) and, if needed, `hint` (up to 400 characters,
shown when the pointer rests on the control). There are three types.

**Slider**, a number:

```json
{ "type": "slider", "id": "strength", "label": "Strength",
  "min": 0, "max": 1, "step": 0.01, "default": 0.5, "format": "percent" }
```

`format` is optional: `percent`, `decimal`, `integer` or `degrees`. `max` must
be greater than `min` (both within ±1,000,000,000), `step` greater than zero
and no larger than the range, `default` between `min` and `max`; with the
`integer` format the four numbers must be whole.

**Toggle**, true or false:

```json
{ "type": "toggle", "id": "luminanceOnly", "label": "Luminance only", "default": false }
```

**Choice**, 2 to 8 options, with non-empty and all different values (each
option may also have a `hint`):

```json
{ "type": "choice", "id": "mode", "label": "Mode",
  "options": [ { "value": "a", "label": "First" }, { "value": "b", "label": "Second" } ],
  "default": "a" }
```

Values always reach the plugin valid. If a project saved with an earlier
version of the plugin contains a value out of range or missing, StarLight
brings it back into range or uses the default.

### Translations

English is the main language of the manifest. The optional `translations`
section adds other languages, by language code (`it`, `de`, `pt-BR`…, at most
40):

```json
"translations": {
  "it": {
    "name": "Il mio plugin",
    "description": "Una o due frasi che dicono che cosa fa e quando serve.",
    "parameters": {
      "strength": { "label": "Intensità", "hint": "Quanto è forte l'effetto." },
      "mode": { "label": "Modo", "options": { "a": "Primo", "b": { "label": "Secondo", "hint": "…" } } }
    }
  }
}
```

Every field is optional, and a missing text stays the English one. StarLight
shows the texts of its current language: the exact code (`pt-BR`), then the
base language (`pt`), then English. Translated texts follow the same length
limits as the main ones. A parameter `id` or an option `value` that the
manifest does not declare is rejected.

## The code, `plugin.js`

A single-file JavaScript module that exports the `processImage` function:

```js
export function processImage(image, params, context) {
  const { width, height, channels, data } = image
  const output = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) output[i] = data[i] * params.strength
  return { width, height, channels, data: output }
}
```

It can also be `async` and return a promise.

**Input:**

- `image`: `{ width, height, channels, data }`. `channels` is 1 (monochrome)
  or 3 (color). `data` is a **planar** `Float32Array`: first all the red
  values, then all the green ones, then the blue ones. The pixel (x, y) of
  channel c is at index `c·width·height + y·width + x`, with (0, 0) at the top
  left. Values are **linear** (as they come from the sensor, not yet
  stretched), normalized roughly between 0 and 1. It is a copy that the
  plugin may modify freely.
- `params`: the chosen values, by `id` (frozen, read-only object).
- `context`:
  - `stretch: { black, midtones, white }`, the stretch the viewer will apply
    afterwards: it serves plugins that work on the image as it appears (see
    the `negative` plugin) and then bring the result back into linear data;
  - `starLightVersion`, for example `"0.4.0"`.

**Output:** an object `{ width, height, channels, data }` with `channels` 1 or
3 and `data` a `Float32Array` exactly `width·height·channels` long. A few
isolated non-numeric values (`NaN`, infinities: up to 0.1% of the values, or
16 if that is more) become 0; beyond that, the result is rejected. Values
beyond ±1000 are rejected too (for example non-normalized data, up to 65535).
The returned image cannot exceed four times the pixels of the received one
(or 4096 × 4096, if that is more).

When something goes wrong (an error, an invalid result, time run out, memory
exhausted) the plugin is stopped and not applied. The image stays as it was
before the plugin, the rest of the processing is applied, and the plugin
stays suspended until StarLight is next opened. A notice states the reason;
if the same version stops in another session too, the notice offers to
disable it permanently.

## If the plugin moves pixels: geometry

Astronomical images often contain the **astrometric solution** (WCS, World
Coordinate System), that is, the exact correspondence between every pixel and
a point in the sky. StarLight uses it to place markers on recognized objects
and writes it into exported FITS files. If a plugin rotates, mirrors or crops
the image, the solution must be transformed in the same way, otherwise the
markers end up in the wrong place. For this reason the manifest declares the
effect of the plugin on pixel positions.

- **`"geometry": "unchanged"`** (or field absent): the plugin changes values
  but does not move pixels, and returns an image of the same dimensions. This
  is the case for almost all plugins. If an `unchanged` plugin returns
  different dimensions, StarLight treats it as `unknown` (see below).

- **`"geometry": "transformed"`**: the plugin moves pixels and, next to the
  image, returns the transformation it applied in the `transform` field, a
  2×3 affine matrix:

  ```js
  return { width, height, channels, data, transform: [[a, b, c], [d, e, f]] }
  ```

  It means that the pixel (x, y) of the **received** image ends up at
  (a·x + b·y + c, d·x + e·y + f) in the **returned** image. Coordinates are
  those of pixel centers counted from 0, the same as in the index
  `y·width + x`. Examples, for an image `w` wide and `h` high:

  | Operation | Matrix | New dimensions |
  |---|---|---|
  | none | `[[1, 0, 0], [0, 1, 0]]` | w × h |
  | 90° clockwise | `[[0, -1, h - 1], [1, 0, 0]]` | h × w |
  | 180° | `[[-1, 0, w - 1], [0, -1, h - 1]]` | w × h |
  | 90° counterclockwise | `[[0, 1, 0], [-1, 0, w - 1]]` | h × w |
  | left-right mirror | `[[-1, 0, w - 1], [0, 1, 0]]` | w × h |
  | top-bottom mirror | `[[1, 0, 0], [0, -1, h - 1]]` | w × h |
  | crop starting at pixel (x0, y0) | `[[1, 0, -x0], [0, 1, -y0]]` | those of the crop |
  | k-fold enlargement | `[[k, 0, (k - 1) / 2], [0, k, (k - 1) / 2]]` | k·w × k·h |

  To chain several operations, the matrices are composed: the first `p`,
  then the second `s`, become
  `[[s00·p00 + s01·p10, s00·p01 + s01·p11, s00·p02 + s01·p12 + s02], [s10·p00 + s11·p10, s10·p01 + s11·p11, s10·p02 + s11·p12 + s12]]`.
  StarLight moves the astrometric solution with this matrix exactly, optical
  distortion (SIP) included, for any affine transformation; and if several
  plugins move pixels, it composes their transformations. The matrix must be
  made of finite numbers and must not flatten the image (non-zero
  determinant). A `transformed` plugin that does not return a valid matrix,
  or returns a matrix that sends all pixels outside the returned image, is
  stopped with a notice.

  If in a particular case the plugin cannot describe the transformation it
  applied, it may return `transform: "unknown"`.

- **`"geometry": "unknown"`**: the plugin moves pixels in a way no matrix
  describes (a free-form warp, a lens correction). StarLight then removes the
  astrometric solution from the processed image: markers are hidden (objects
  remain listed by name, with a notice) and the exported FITS file does not
  contain the solution, because a missing solution is preferable to a wrong
  one. To restore it, the plugin must be turned off and Apply pressed again.

## Isolation: what a plugin cannot do

A plugin's code never runs together with StarLight's. It runs in a process
separate from the interface (the "sandbox"), where for every execution
StarLight creates a worker (Web Worker), passes it a copy of the image and
closes it at the end. In this environment the following limits apply.

- **no files**: the plugin sees neither the disk nor the rest of the program;
- **no network, no devices**: `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource`, `importScripts`, other workers, `indexedDB`, `caches`,
  notifications, USB, HID, serial ports, Bluetooth and the like are removed
  before the plugin code is read, and the security policy of the sandbox
  forbids any connection and the evaluation of text as code (`eval`,
  `new Function`) anyway;
- **no external modules**: all the code must be in `plugin.js`. A plugin
  containing `import` (including dynamic `import(...)` or `import.meta`) is
  rejected at installation;
- **limited time**: half a minute plus four seconds per million pixels,
  rounded up (for a 2-million-pixel photo, 42 seconds). Beyond that, the
  plugin is stopped and skipped;
- **no interface**: the plugin draws no controls or windows; it declares its
  parameters and StarLight shows them;
- **limited memory**: twelve times the image size plus 1.5 GB, never less
  than 2 GB and never more than 60% of the computer's memory. Beyond that,
  the sandbox is closed and the plugin stopped; StarLight stays open.

The code is checked again at every execution: if `plugin.js` changed after
startup and no longer passes the checks, the plugin is not run.

## Installation

From the **Plugins** menu, the gallery offers **From a folder…** and **From a
ZIP archive…** at the bottom of the window. StarLight checks the plugin and,
if it accepts it, copies it into `%APPDATA%\StarLight\plugin\<id>`; otherwise
it shows the reason for the rejection. Installing again a plugin with the same
`id` replaces the previous version. StarLight does not download plugins from
the internet and its server does not host third-party plugins: their
distribution is up to their authors.

## Advice

- Comment in the code the reasons for the choices, not only the operations:
  whoever reads a free plugin must be able to understand and improve it.
- Work on linear data when the operation has a physical meaning (removing
  green, combining channels); on the stretched image, with `context.stretch`,
  when the effect concerns the appearance of the image (negative, glow).
- Test the plugin on a real shot. In astronomical images almost all the
  signal is close to zero, and an effect that works on an ordinary
  photograph may turn out invisible.
