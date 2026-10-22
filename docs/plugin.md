# Writing a plugin for StarLight

A plugin adds an image transformation to StarLight: an effect, a correction, a rotation. It appears in the
**Process** step, in the **Extra tools** tab, and runs after all of StarLight's own tools, in the order in which the
plugins were enabled.

This guide describes how a plugin is made, what it can and cannot do, how it is installed and why StarLight may
reject it. The plugins bundled with the program, in the `resources/plugin` folder (`negative`, `orton-effect`,
`star-separation`, `green-removal`…), are complete examples to copy and study.

## Contents

- [Structure of a plugin](#structure-of-a-plugin)
- [The manifest, plugin.json](#the-manifest-pluginjson)
- [Parameters](#parameters)
- [Translations](#translations)
- [The code, plugin.js](#the-code-pluginjs)
- [Plugins that move pixels: geometry](#plugins-that-move-pixels-geometry)
- [The sandbox: what a plugin cannot do](#the-sandbox-what-a-plugin-cannot-do)
- [Icon and previews](#icon-and-previews)
- [Accepted licenses](#accepted-licenses)
- [Installation and testing](#installation-and-testing)
- [Minimal complete example](#minimal-complete-example)
- [Rejection messages](#rejection-messages)
- [Advice](#advice)

## Structure of a plugin

A plugin is a folder containing these files.

| File | Required | Purpose |
|---|---|---|
| `plugin.json` | yes | the manifest: author, license, description, parameters, translations |
| `plugin.js` | yes | the code, with the `processImage` function |
| icon | yes | image shown in the gallery, with the name given in the manifest |
| before and after previews | yes | two images showing the effect, with the names given in the manifest |
| `LICENSE`, `LICENCE`, `COPYING`, `README` (also with a `.md` or `.txt` extension; the Italian names `LICENZA` and `LEGGIMI` are accepted too) | no | kept next to the plugin |

StarLight ignores every other file and all subfolders. A plugin is distributed as a folder or as a ZIP archive
containing it.

### Size limits

| Item | Limit |
|---|---|
| `plugin.json` | 64 KB |
| `plugin.js` | 2 MB |
| each image (icon, previews) | 4 MB and 4096 pixels per side |
| license and readme | 512 KB each (larger files are not copied) |
| ZIP archive | 50 MB, at most 200 files and 40 MB once extracted |

Images must be PNG, JPEG or WebP. StarLight recognizes the format and the dimensions from the file content, not only
from the extension.

File names must be simple: no paths, no names reserved by Windows (`con`, `prn`, `aux`, `nul`, `com1`, `lpt1`…, also
with an extension such as `con.png`), no trailing dot or space, no leading dot, at most 80 characters.

A ZIP archive can contain the plugin at its root or inside a single folder (as happens when the plugin folder itself is
compressed). It must contain a single `plugin.json`, no path leading outside the folder, no password-protected file,
and use either "deflate" compression or no compression.

## The manifest, plugin.json

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "author": "Author name",
  "license": "MIT",
  "category": "astrophotography",
  "description": "One or two sentences in English that say what the plugin does and when it is useful.",
  "icon": "icon.png",
  "previews": { "before": "before.png", "after": "after.png" },
  "minimumStarLightVersion": "0.4.0",
  "site": "https://example.org/my-plugin",
  "geometry": "unchanged",
  "parameters": [],
  "translations": {}
}
```

| Field | Required | Rule |
|---|---|---|
| `id` | yes | 2 to 40 characters: lowercase letters, digits and hyphens, starting with a letter or a digit; not a name reserved by Windows. It is also the name of the folder in which StarLight installs the plugin. |
| `name` | yes | up to 60 characters |
| `version` | yes | in the form `1.2.3` (up to 20 characters) |
| `author` | yes | up to 80 characters |
| `license` | yes | an open source license in SPDX form, up to 80 characters (see [Accepted licenses](#accepted-licenses)) |
| `category` | yes | `astrophotography` or `photography`: decides under which gallery filter the plugin appears |
| `description` | yes | up to 600 characters, in English; may contain line breaks |
| `icon` | yes | name of a PNG, JPEG or WebP file in the plugin folder |
| `previews` | yes | object with `before` and `after`, two names of PNG, JPEG or WebP files in the plugin folder |
| `minimumStarLightVersion` | yes | the oldest StarLight version the plugin works with, in the form `0.4.0` |
| `site` | no | address of the source code or of the project page, `https://` only, up to 300 characters |
| `geometry` | no | `unchanged` (when absent), `transformed` or `unknown`: see [geometry](#plugins-that-move-pixels-geometry) |
| `parameters` | no | list of the controls to show, at most 24 (when absent, the plugin has no parameters) |
| `translations` | no | texts in other languages: see [Translations](#translations) |

English is the main language of the manifest: `name`, `description` and the texts of the parameters are written in
English, and other languages are added in `translations`.

No text may contain control characters or invisible characters that reverse the writing direction: with these, a name
could pass for another.

StarLight keeps only the fields listed here; any others are ignored.

The `id` must differ from those of the plugins bundled with StarLight (the folder names in `resources/plugin`). When
the program is reopened, the bundled plugin always prevails and an installed copy with the same `id` is removed.

## Parameters

A plugin draws nothing: it declares its parameters and StarLight shows them with the same look as every other
control. Every parameter has:

- `type`: `slider`, `toggle` or `choice`;
- `id`: starts with a letter and contains only letters, digits and underscores, up to 40 characters; it must differ
  from the ids of the other parameters;
- `label`: up to 60 characters;
- `hint`, optional: up to 400 characters, shown when the pointer rests on the control.

### Slider

A number within a range.

```json
{ "type": "slider", "id": "strength", "label": "Strength",
  "min": 0, "max": 1, "step": 0.01, "default": 0.5, "format": "percent" }
```

- `min` and `max` are numbers between -1,000,000,000 and 1,000,000,000, with `max` greater than `min`;
- `step` is greater than zero and no larger than `max - min`;
- `default` lies between `min` and `max`;
- `format`, optional, sets how the value is shown: `percent`, `decimal`, `integer` or `degrees`. With `integer`,
  `min`, `max`, `step` and `default` must be whole numbers.

### Toggle

True or false.

```json
{ "type": "toggle", "id": "luminanceOnly", "label": "Luminance only", "default": false }
```

`default` must be `true` or `false`.

### Choice

One of 2 to 8 options.

```json
{ "type": "choice", "id": "mode", "label": "Mode",
  "options": [
    { "value": "a", "label": "First", "hint": "Optional explanation of the option." },
    { "value": "b", "label": "Second" }
  ],
  "default": "a" }
```

- every option has a `value` (up to 40 characters) and a `label` (up to 60), neither empty, and may have a `hint`
  (up to 400);
- values must all be different;
- `default` must be one of the values.

### Values received by the plugin

Values always reach the plugin valid. If a project saved with an earlier version of the plugin contains a value out of
range, missing or referring to an option that no longer exists, StarLight brings it back into range or uses the
default. Parameters can therefore change from one version to the next without breaking saved projects.

## Translations

The optional `translations` section holds the texts of the manifest in other languages, by language code. StarLight
shows the texts of its current language: first the exact code (for example `pt-BR`), then the base language (`pt`),
then the English texts of the manifest.

```json
"translations": {
  "it": {
    "name": "Il mio plugin",
    "description": "Una o due frasi che dicono che cosa fa il plugin e quando serve.",
    "parameters": {
      "strength": { "label": "Intensità", "hint": "Quanto è forte l'effetto." },
      "mode": {
        "label": "Modo",
        "options": {
          "a": { "label": "Primo", "hint": "Spiegazione facoltativa dell'opzione." },
          "b": "Secondo"
        }
      }
    }
  }
}
```

- Language codes have the form `it`, `de`, `pt-BR`, `zh-Hant` (two or three lowercase letters, optionally followed by
  a hyphen and 2 to 8 letters or digits). At most 40 languages.
- Every field is optional: a missing text stays the English one of the manifest.
- `parameters` is indexed by parameter `id`, and each entry may contain `label`, `hint` and, for a choice parameter
  only, `options`.
- `options` is indexed by option `value`. Each entry is either a string (the translated label) or an object with
  `label` and `hint`.
- Translated texts follow the same limits as the main ones: `name` 60 characters, `description` 600, `label` 60,
  `hint` 400, option label 60; they cannot be empty or contain control characters.
- A parameter `id` or an option `value` that the manifest does not declare is rejected.

Identifiers and values never change with the language: only the displayed texts do.

## The code, plugin.js

`plugin.js` is a single-file JavaScript module that exports the `processImage` function:

```js
export function processImage(image, params, context) {
  const { width, height, channels, data } = image
  const output = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) output[i] = data[i] * params.strength
  return { width, height, channels, data: output }
}
```

The forms `export async function processImage(…)` and `export const processImage = …` are also accepted; the function
may return a promise.

### Input

- `image`: `{ width, height, channels, data }`.
  - `channels` is 1 (monochrome) or 3 (color).
  - `data` is a **planar** `Float32Array`: first all the red values, then all the green ones, then the blue ones. The
    pixel (x, y) of channel c is at index `c·width·height + y·width + x`, with (0, 0) at the top left.
  - Values are **linear**, as they come from the sensor and not yet stretched, normalized roughly between 0 and 1. In
    astronomical images almost all the signal is very close to zero.
  - It is a copy that the plugin may modify freely; StarLight's image stays untouched.
- `params`: the chosen values, by parameter `id`. It is a frozen, read-only object.
- `context`, also read-only:
  - `stretch: { black, midtones, white }`, the stretch the viewer will apply afterwards, with the same meaning as in
    the Correct step: values below `black` become black, those above `white` become white, and `midtones` below 0.5
    brightens. It serves plugins that work on the image as it appears on screen and then bring the result back into
    linear data (see the `negative` plugin);
  - `starLightVersion`, for example `"0.4.7"`.

### Output

The plugin returns an object `{ width, height, channels, data }`:

- `width` and `height` whole numbers greater than zero;
- `channels` 1 or 3 (a monochrome image may become a color one, and vice versa);
- `data` a `Float32Array` exactly `width·height·channels` long, in the same planar order;
- at most four times the pixels of the received image, or 4096 × 4096 pixels if that is more;
- values within ±1000: a result with larger values (for example non-normalized data, up to 65535) is rejected;
- a few isolated non-numeric values (`NaN`, infinities) become 0, up to 0.1% of the values or 16 values if that is
  more; beyond that, the result is rejected.

A plugin that moves pixels also adds the `transform` field (see the next section).

### Errors during execution

If the plugin throws an error, returns an invalid result or exceeds the time or memory granted, StarLight stops it and
does not apply it:

- the image stays as it was before the plugin, and the rest of the processing is applied;
- the plugin stays suspended until StarLight is next opened, and the gallery shows the "suspended" label;
- a notice states the reason;
- if the same version of the plugin stops in another session too, the notice offers to disable it permanently with
  the **Disable plugin** button. The plugin can be enabled again when a fixed version is released.

## Plugins that move pixels: geometry

Astronomical images often contain the **astrometric solution** (WCS, World Coordinate System), that is, the exact
correspondence between every pixel and a point in the sky. StarLight uses it to place markers on recognized objects
and writes it into exported FITS files. If a plugin rotates, mirrors or crops the image, the solution must be
transformed in the same way, otherwise the markers end up in the wrong place. For this reason the manifest declares
the effect of the plugin on pixel positions.

### "geometry": "unchanged"

This is the default, which also applies when the field is absent. The plugin changes values but does not move pixels,
and returns an image of the same dimensions. This is the case for almost all plugins.

An `unchanged` plugin that returns different dimensions is treated as `unknown` (see below).

### "geometry": "transformed"

The plugin moves pixels and, next to the image, returns the transformation it applied in the `transform` field, a
2 × 3 affine matrix:

```js
return { width, height, channels, data, transform: [[a, b, c], [d, e, f]] }
```

The pixel (x, y) of the **received** image ends up at (a·x + b·y + c, d·x + e·y + f) in the **returned** image.
Coordinates are those of pixel centers counted from 0, the same as in the index `y·width + x`. The most common
matrices, for an image `w` wide and `h` high:

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

Several operations in a row are obtained by composing the matrices. With `p` the first and `s` the second, the overall
matrix is:

```js
function compose(p, s) {
  return [
    [s[0][0] * p[0][0] + s[0][1] * p[1][0], s[0][0] * p[0][1] + s[0][1] * p[1][1], s[0][0] * p[0][2] + s[0][1] * p[1][2] + s[0][2]],
    [s[1][0] * p[0][0] + s[1][1] * p[1][0], s[1][0] * p[0][1] + s[1][1] * p[1][1], s[1][0] * p[0][2] + s[1][1] * p[1][2] + s[1][2]]
  ]
}
```

StarLight moves the astrometric solution with this matrix exactly, optical distortion (SIP) included, for any affine
transformation; if several plugins move pixels, it composes their transformations.

The matrix must be made of finite numbers, must not flatten the image (non-zero determinant) and must bring at least
part of the received image inside the returned one. A `transformed` plugin that does not return a valid matrix, or
returns a matrix that sends all pixels outside the image, is stopped with a notice.

If in a particular case the plugin cannot describe the transformation it applied, it may return
`transform: "unknown"`.

The `tools/test-plugin-geometry` folder contains a complete plugin that rotates and mirrors the image and returns the
matrix.

### "geometry": "unknown"

The plugin moves pixels in a way no matrix describes, for example a free-form warp or a lens correction. StarLight
then removes the astrometric solution from the processed image: markers are hidden (objects remain listed by name,
with a notice) and the exported FITS file does not contain the solution, because a missing solution is preferable to a
wrong one. To restore it, turn the plugin off and press Apply again.

## The sandbox: what a plugin cannot do

A plugin's code never runs together with StarLight's. It runs in a process separate from the interface, the
"sandbox", where for every execution StarLight creates a worker (Web Worker), passes it a copy of the image and closes
it at the end. Inside the sandbox these limits apply.

- **No files**: the plugin sees neither the disk nor the rest of the program.
- **No network, no devices**: before the plugin code is read, StarLight removes from the environment `fetch`,
  `XMLHttpRequest`, `WebSocket`, `WebSocketStream`, `EventSource`, `WebTransport`, `importScripts`, `Worker`,
  `SharedWorker`, `BroadcastChannel`, `indexedDB`, `caches`, direct file access (`FileSystemHandle` and similar),
  `RTCPeerConnection`, `Notification`, and from `navigator` the storage (`storage`, `locks`) and devices (`usb`,
  `hid`, `serial`, `bluetooth`). Any attempt to use them throws the error "StarLight plugins cannot use …, because
  they have no access to the network, files or devices." In addition, the security policy of the sandbox forbids any
  connection and the evaluation of text as code (`eval`, `new Function`).
- **No external modules**: all the code must be in `plugin.js`. A plugin containing `import`, including dynamic
  `import(...)` or `import.meta`, is rejected at installation. Functions from a library must be copied into
  `plugin.js`, respecting its license.
- **No interface**: the plugin draws no controls or windows; it declares its parameters and StarLight shows them.
- **Limited time**: half a minute plus four seconds per million pixels, with the millions rounded up. For a
  1920 × 1080 image (2.07 million, hence 3) the limit is 42 seconds; for a 6248 × 4176 image (26.09 million,
  hence 27) it is 138 seconds. Beyond that, the plugin is stopped.
- **Limited memory**: twelve times the image size plus 1.5 GB, never less than 2 GB and never more than 60% of the
  computer's memory. Beyond that, StarLight closes the sandbox and stops the plugin, but stays open. If the plugin
  exhausts the memory of the JavaScript engine, only the sandbox goes down.

The code is checked again at every execution: if `plugin.js` changed on disk after startup and no longer passes the
checks, the plugin is not run.

## Icon and previews

For every plugin the gallery shows the icon and a before and after comparison, with a line that follows the pointer.

- **Icon**: square. Those of the bundled plugins measure 72 × 72 pixels; the gallery shows it at 40 × 40.
- **Previews**: two images with the same size and framing, one without and one with the plugin applied. Those of the
  bundled plugins are square, 240 × 240 pixels. The gallery shows them in a 16:10 frame filled entirely, so the
  meaningful part must be in the center, because the top and bottom edges may be cropped.
- Previews work best when taken from a real, already stretched shot in which the effect is clearly visible.
- PNG, JPEG or WebP format, at most 4 MB and 4096 pixels per side each.

## Accepted licenses

StarLight installs only free plugins: whoever uses them must be able to read, modify and share them. These licenses
are accepted, written with their SPDX identifier:

0BSD, AFL-3.0, AGPL-3.0-only, AGPL-3.0-or-later, Apache-2.0, Artistic-2.0, BSD-2-Clause, BSD-3-Clause, BSL-1.0,
CECILL-2.1, ECL-2.0, EPL-1.0, EPL-2.0, EUPL-1.1, EUPL-1.2, GPL-2.0-only, GPL-2.0-or-later, GPL-3.0-only,
GPL-3.0-or-later, ISC, LGPL-2.1-only, LGPL-2.1-or-later, LGPL-3.0-only, LGPL-3.0-or-later, MIT, MIT-0, MPL-2.0, MS-PL,
MulanPSL-2.0, NCSA, OSL-3.0, PostgreSQL, UPL-1.0, Unlicense, Zlib.

Licenses can be combined with `OR` and `AND`, also in parentheses, for example `MIT OR Apache-2.0`; every license named
must be in the list. Case does not matter. A plugin without a license, or with a different one, is not installed.

It is advisable to include the full license text in the folder as well (`LICENSE`), which StarLight keeps next to the
plugin.

## Installation and testing

1. Open the gallery from the **Plugins** menu.
2. At the bottom of the window, next to "Install a plugin locally:", choose **From a folder…** or **From a ZIP
   archive…**.
3. StarLight checks the plugin. If it accepts it, it copies it into the `%APPDATA%\StarLight\plugin\<id>` folder,
   together with the expected files only; otherwise it shows the reason for the rejection.
4. The plugin appears under the **Active** filter of the gallery and in the **Extra tools** tab of the Process step,
   where it is turned on, its parameters are adjusted and Apply is pressed.

StarLight does not download plugins from the internet, and the StarLight server does not host third-party plugins:
they are installed only from files present on the computer, and their distribution is up to their authors.

To test a new version, install it again from the same folder: a plugin with the same `id` replaces the previous
version. StarLight uses the installed copy, not the working folder.

The installation checks are repeated at every startup. A damaged plugin, or one copied by hand into the plugin
folder, is not loaded, and the gallery shows it as "not loaded" with the problem found and the **Reinstall** and
**Uninstall** buttons.

## Minimal complete example

A plugin that adjusts brightness by multiplying the values, with an Italian translation of its texts.

**Folder `brightness-multiplier`:**

```
brightness-multiplier/
  plugin.json
  plugin.js
  icon.png       (72 × 72)
  before.png     (240 × 240)
  after.png      (240 × 240)
  LICENSE
```

**plugin.json**

```json
{
  "id": "brightness-multiplier",
  "name": "Brightness multiplier",
  "version": "1.0.0",
  "author": "Author name",
  "license": "MIT",
  "category": "photography",
  "description": "Multiplies the brightness of the image by a factor. Useful as a starting point for writing a new plugin.",
  "icon": "icon.png",
  "previews": { "before": "before.png", "after": "after.png" },
  "minimumStarLightVersion": "0.4.0",
  "parameters": [
    {
      "type": "slider",
      "id": "factor",
      "label": "Factor",
      "hint": "1 leaves the image unchanged, above 1 brightens it, below 1 darkens it.",
      "min": 0,
      "max": 4,
      "step": 0.05,
      "default": 1.5,
      "format": "decimal"
    }
  ],
  "translations": {
    "it": {
      "name": "Moltiplicatore di luminosità",
      "description": "Moltiplica la luminosità dell'immagine per un fattore. Utile come punto di partenza per scrivere un nuovo plugin.",
      "parameters": {
        "factor": {
          "label": "Fattore",
          "hint": "1 lascia l'immagine com'è, sopra 1 la schiarisce, sotto 1 la scurisce."
        }
      }
    }
  }
}
```

**plugin.js**

```js
/*
 * Brightness multiplier. Example plugin for StarLight. MIT license.
 *
 * Multiplies the linear values by a factor: working on linear data means
 * really changing the amount of light recorded, like a longer or shorter
 * exposure.
 */

export function processImage(image, params) {
  const { width, height, channels, data } = image
  // The received image is already a copy: it can be modified and returned.
  const output = data
  for (let i = 0; i < data.length; i++) {
    // Stay below the ±1000 limit accepted by StarLight.
    output[i] = Math.min(1000, data[i] * params.factor)
  }
  return { width, height, channels, data: output }
}
```

For distribution the folder is compressed into a ZIP archive; for testing it is installed directly with **From a
folder…**.

## Rejection messages

When StarLight rejects a plugin, the notice always has three parts: the subject ("The plugin “X” was not
installed."), the problem found and the suggested remedy. The tables below list every possible problem, with its cause
and the way to fix it in the plugin. Placeholders in braces, such as `{name}`, are replaced by the actual name or
value.

### ZIP archive

| Message | Cause | Remedy |
|---|---|---|
| The selected file is not a valid ZIP archive. | the file is not a ZIP | compress the folder in ZIP format with the Windows tool or an archiving program |
| The ZIP archive is damaged: some parts cannot be read or do not match their declared size. | damaged or incomplete archive | recreate the archive; if it is distributed online, check that it downloads completely |
| The archive is password-protected and StarLight cannot open it. | encrypted archive | create the archive without a password |
| The archive uses a compression method StarLight does not support (only “stored” and “deflate” are allowed). | different compression method | create the ZIP archive with the standard deflate method |
| The archive contains files whose paths lead outside its folder (for example “../”) or point to a drive… | a path in the archive leads outside the folder | create the archive by compressing the plugin folder, without absolute paths |
| The archive contains the same file twice with different contents… | two files with the same name, even differing only in case | keep a single file per name |
| The archive contains too many files to be a plugin (maximum 200). | more than 200 files | remove unneeded files: StarLight uses only those listed in [Structure of a plugin](#structure-of-a-plugin) |
| Once extracted, the archive would take up too much space to be a plugin (maximum 40 MB). | content over 40 MB | remove unneeded files and reduce the images |
| The file “{name}” inside the archive is too large (maximum {mb} MB). | a single file over the limit | reduce that file |
| The archive is built to inflate enormously when extracted… | a file over 1 MB compressed more than 500 times, or data longer than declared | do not include artificial files or files full of repeated data |
| The archive is too large to be a plugin (maximum 50 MB). | archive over 50 MB, or using the extension for archives over 4 GB (ZIP64) | reduce the content and use a normal ZIP archive |
| The archive contains more than one plugin.json file: it must contain a single plugin or a single catalog. | several plugins in the same archive | distribute one archive per plugin |
| The archive does not contain a plugin.json file, so it is not a StarLight plugin. | manifest missing, or nested in more than one folder | put `plugin.json` at the root of the archive or inside a single folder |

### Folder and files

| Message | Cause | Remedy |
|---|---|---|
| The folder does not contain a plugin.json file, so it is not a StarLight plugin. | manifest missing from the chosen folder | choose the folder that directly contains `plugin.json` |
| The folder could not be read: {detail}. | folder not accessible | check the permissions or copy the folder to a readable location |
| The plugin could not be copied: {detail}. | copy into the plugin folder failed | free some disk space and try again |
| The name “{name}” is reserved by Windows (like CON, NUL, COM1) and cannot be used for a file or folder. | reserved `id` or file name | choose another name |
| The plugin folder is named “{folder}”, but its manifest declares the identifier “{id}”: the two names must match. | appears only at startup, if the installed folder was renamed or copied by hand | uninstall the plugin and install it again from the original file |

### Manifest

| Message | Cause | Remedy |
|---|---|---|
| The plugin.json file is too large (maximum 64 kB). | manifest over 64 KB | remove unneeded data: a real manifest fits in a few kilobytes |
| The plugin.json file does not contain valid JSON and cannot be read. | JSON syntax error | check commas, quotes and brackets with a JSON validator |
| The plugin.json file does not contain a valid manifest. | the content is not an object `{ … }` | write the manifest as a JSON object |
| A required field is missing: {name}. ({name} is one of: the identifier (id), the name, the version, the author, the license, the description, the icon, the minimum StarLight version) | required field absent or empty | add the field |
| {name} is too long (maximum {max} characters). | text over the allowed length | shorten it: `id` 40, `name` 60, `version` 20, `author` 80, `license` 80, `description` 600, `icon` 80, `minimumStarLightVersion` 20 |
| The “{field}” field contains invisible or control characters, which can distort the displayed text. | control or direction-reversal characters | rewrite the text without invisible characters |
| The identifier “{id}” can only contain lowercase letters, digits and hyphens (2 to 40 characters). | invalid `id` | use for example `my-plugin` |
| The version must have the form 1.0.0. | `version` not made of three numbers | write for example `1.0.0` |
| The license “{license}” is not a recognized open source license. StarLight only installs free plugins… | license not accepted | choose a license from the [list](#accepted-licenses), with its SPDX identifier |
| The category must be “astrophotography” or “photography”. | `category` absent or different | use one of the two values |
| The icon must be a PNG, JPEG or WebP file in the plugin folder. | extension not allowed or name not simple | use a name such as `icon.png`, without paths |
| The before and after previews are missing. | `previews` absent or without `before` and `after` | add `"previews": { "before": "before.png", "after": "after.png" }` |
| The previews must be PNG, JPEG or WebP files in the plugin folder. | extension not allowed or name not simple | use simple names with a `.png`, `.jpg`, `.jpeg` or `.webp` extension |
| The minimum StarLight version must have the form 0.3.0. | `minimumStarLightVersion` not made of three numbers | write for example `0.4.0` |
| This plugin requires StarLight {minimum} or later; the installed version is {app}. | the installed StarLight is older | the remedy shown is "Update StarLight to the latest version and try again."; in the manifest, avoid declaring a version higher than necessary |
| The website, if given, must be an https address. | `site` does not start with `https://`, contains spaces or exceeds 300 characters | fix the address or remove the field |
| The geometry, if given, must be “unchanged”, “transformed” or “unknown”. | unknown `geometry` value | use one of the three values or remove the field |

### Parameters

| Message | Cause | Remedy |
|---|---|---|
| The parameters must be a list. | `parameters` is not an array `[ … ]` | enclose the parameters in square brackets |
| A plugin can declare at most 24 parameters. | more than 24 parameters | merge or remove the least useful parameters |
| The parameter “{id}” is declared twice. | two parameters with the same `id` | give every parameter a different `id` |

Errors in a single parameter start with "Parameter N:", where N is its position in the list (counted from 1).

| Message | Remedy |
|---|---|
| it is not an object. | write the parameter as an object `{ … }` |
| the id must start with a letter and contain only letters, digits and underscores (up to 40). | for example `strength` or `star_radius` |
| the label is missing or too long (maximum 60 characters). | add or shorten `label` |
| the hint is not valid (maximum 400 characters). | shorten the `hint` of the parameter or option and remove any invisible characters |
| the slider requires numeric min and max, with max greater than min. | fix `min` and `max` |
| min and max must be between -1,000,000,000 and 1,000,000,000. | reduce the range |
| the slider step must be greater than zero and no larger than the range between min and max. | fix `step` |
| the default value must be between min and max. | fix `default` |
| the format must be percent, decimal, integer or degrees. | use one of the four values or remove `format` |
| with the “integer” format, min, max, step and default must be whole numbers. | use whole numbers or another format |
| the toggle requires a true or false default. | write `"default": true` or `false`, without quotes |
| the choice requires 2 to 8 options. | bring the options to between 2 and 8 |
| every option requires a value and a label, neither empty nor too long. | `value` up to 40 characters, `label` up to 60 |
| the value “{value}” appears in two options. | make all values different |
| the default must be one of the option values. | fix `default` |
| the type “{type}” does not exist: the allowed types are slider, toggle and choice. | fix `type` |

### Translations

| Message | Remedy |
|---|---|
| The “translations” section must be an object with one entry per language code (for example “it”). | write `translations` as an object `{ "it": { … } }` |
| The “translations” section can contain at most 40 languages. | remove the excess languages |
| In “translations”, “{language}” is not a valid language code (for example “it” or “pt-BR”). | use a code such as `it`, `de` or `pt-BR` |
| The “{language}” translation must be an object with the fields name, description and parameters. | write the translation, and each of its `parameters` entries, as an object |
| In the “{language}” translation, the text “{field}” is not valid (it must not be empty, must not contain control characters and can be at most {max} characters long). | fix or shorten the text named in `{field}` (for example `parameters.factor.label`) |
| The “{language}” translation refers to the parameter “{id}”, which the manifest does not declare. | use the `id` of a declared parameter, or remove the entry |
| In the “{language}” translation, the options of “{id}” must be an object, and only a choice parameter has options. | write `options` as an object indexed by value, only for `choice` parameters |
| The “{language}” translation refers to the option “{value}” of the parameter “{id}”, which the manifest does not declare. | use the `value` of a declared option, or remove the entry |

### Code

| Message | Cause | Remedy |
|---|---|---|
| The plugin.js file with the plugin code is missing. | file absent or with another name | name it exactly `plugin.js` |
| The plugin.js file is too large (maximum 2 MB). | code over 2 MB | remove unneeded code and avoid bulky data in the source |
| The plugin.js file is not readable text (it contains bytes that are not valid UTF-8). | file not saved as UTF-8 | save it with UTF-8 encoding |
| The plugin.js file must export the “processImage” function (export function processImage(image, params, context)). | no `processImage` export outside comments | write `export function processImage(…)`, `export async function processImage(…)` or `export const processImage = …` |
| The plugin.js file cannot import other modules: all the code must be in that file. | the code contains `import`, `import(…)` or `import.meta` | copy the necessary code into `plugin.js`; outside comments, avoid the word `import` followed by a space, a parenthesis, an asterisk or quotes, even inside a string |

### Images

| Message | Cause | Remedy |
|---|---|---|
| The image “{name}” declared in the manifest is missing. | the file named in `icon` or `previews` does not exist | check the name, including case and extension |
| The image “{name}” is too large (maximum 4 MB). | file over 4 MB | reduce the dimensions or compress the image better |
| The file “{name}” is not a PNG, JPEG or WebP image. | the content is not one of the three formats, even if the extension is | save the image again in the right format |
| The image “{name}” has excessive or unreadable dimensions (maximum 4096 pixels per side). | a side over 4096 pixels or an unreadable header | reduce the image (a few hundred pixels are enough) |

### During execution

When a plugin is stopped while working, the notice reads "The plugin “X” was stopped:" followed by one of these
reasons.

| Reason | Remedy |
|---|---|
| the plugin does not export the “processImage” function | export `processImage` at module level |
| the plugin did not return an image | always return an object `{ width, height, channels, data }`, even when the image does not change |
| the plugin returned an image with invalid dimensions | `width` and `height` must be whole numbers greater than zero |
| the plugin returned an invalid number of channels (1 or 3 are allowed) | fix `channels` |
| the plugin must return the data as a Float32Array | create the data with `new Float32Array(…)`, not with a plain array |
| the plugin returned an image that is too large | at most four times the received pixels, or 4096 × 4096 if that is more |
| the data returned by the plugin does not match the declared dimensions | `data.length` must equal `width·height·channels` |
| the plugin returned {count} non-numeric values (NaN or infinite) out of {total} | avoid divisions by zero and logarithms of non-positive numbers |
| the plugin returned out-of-range values (for example {value}, while StarLight works with values close to the 0 to 1 range) | keep the values normalized, within ±1000 |
| the plugin declares that it moves pixels but did not return the transformation (a 2×3 matrix of numbers, or “unknown”) | with `"geometry": "transformed"`, always return `transform` |
| the plugin returned a transformation that does not match the returned image (pixels would end up outside the image) | check the matrix, for example dimensions swapped after a 90° rotation |
| the plugin did not finish within {seconds} seconds and was stopped | look for infinite loops and computations that grow too fast with the image size |
| the plugin used too much memory (over {size}) and was stopped | reuse `Float32Array`s instead of creating many, and avoid needless copies of the image |
| the separate environment the plugin runs in closed unexpectedly | usually memory exhaustion: the previous remedy applies |
| the plugin code could not start | the code contains a syntax error or uses something the sandbox forbids, such as `eval` |
| an error occurred in the plugin code (“{detail}”) | the quoted text is the message of the error thrown by the code |
| invalid response / unreadable response | the worker replied unexpectedly: `processImage` must return a plain object |
| the plugin.js file changed after startup and no longer passes the checks | the installed copy was modified: install the plugin again from the original folder |

## Advice

- Comments in the code should explain the reasons for the choices, not only the operations: a free plugin must be
  understandable and improvable by others.
- Linear data suits operations with a physical meaning (removing green, combining channels); the stretched image,
  obtained with `context.stretch`, suits effects that concern appearance (negative, glow).
- Test the plugin on a real shot. In astronomical images almost all the signal is close to zero, and an effect that
  works on an ordinary photograph may turn out invisible.
- Test the plugin on both color and monochrome images.
- On a large image every pass over the pixels counts: simple loops over indices and a few reused `Float32Array`s are
  preferable.
