# Creating a custom catalog for StarLight

StarLight recognizes deep-sky objects with the OpenNGC catalog, included in the program, and with the additional
catalogs that can be downloaded from the gallery. A custom catalog can also be prepared, for example a list of
frequently imaged objects or a historical catalog with openly licensed data, and installed from a ZIP archive.

A catalog contains only data, never code. This guide describes how a catalog is made, which rules it must follow and
the reasons StarLight may reject it.

## Contents

- [Package structure](#package-structure)
- [The manifest, catalog.json](#the-manifest-catalogjson)
- [Languages](#languages)
- [Objects, objects.tsv](#objects-objectstsv)
- [Star packages, stars.bin](#star-packages-starsbin)
- [License and attribution](#license-and-attribution)
- [Limits](#limits)
- [Hashes](#hashes)
- [Installation](#installation)
- [Complete minimal example](#complete-minimal-example)
- [Rejection messages](#rejection-messages)

## Package structure

A package is a ZIP archive containing these files, either at the root or inside a single folder. File names, field
names and codes are in English, like the main texts; translations are added separately (see
[Languages](#languages)).

| File | Required | Purpose |
|---|---|---|
| `catalog.json` | yes | the manifest: name, version, source, license, number of objects, translations |
| `objects.tsv` | yes, for an object catalog | one row per object |
| `stars.bin` | yes, for a star package | the stars for plate solving, in binary format |
| `LICENSE.txt` (or `LICENSE`, also with the `.md` extension) | yes | the text of the data license |
| `ATTRIBUTION.md` (or `CREDITS`, `README`, also `.txt` or `.md`) | no, but recommended | credits, source and changes made to the data |

There are two package types:

- **object catalog** (`"type": "deep-sky"`): deep-sky objects in `objects.tsv`, which StarLight adds to object
  recognition and to the search by designation;
- **star package** (`"type": "stars"`): the reference stars for plate solving without internet, in `stars.bin`.
  These stars are not added to the object catalog.

StarLight ignores files with other names and subfolders. License and documents larger than 1 MB are not copied.

## The manifest, catalog.json

```json
{
  "format": 2,
  "id": "nebulose-scelte",
  "type": "deep-sky",
  "name": "Selected nebulae",
  "version": "1.0.0",
  "group": "emission-nebulae",
  "description": "A selection of emission nebulae, with positions taken from Wikidata.",
  "authors": "Author name; positions from Wikidata",
  "reference": "Wikidata, https://www.wikidata.org",
  "source": "https://www.wikidata.org",
  "license": "CC0-1.0",
  "licenseLink": "https://creativecommons.org/publicdomain/zero/1.0/",
  "objects": 3,
  "example": "NS-1",
  "noteLanguages": ["it"],
  "translations": {
    "it": {
      "name": "Nebulose scelte",
      "description": "Una selezione di nebulose a emissione, con le posizioni prese da Wikidata.",
      "authors": "Nome dell'autore; posizioni da Wikidata"
    }
  }
}
```

| Field | Required | Rule |
|---|---|---|
| `format` | yes | must be `2` |
| `id` | yes | 2 to 40 characters: lowercase letters, digits and hyphens, starting with a letter or a digit; not a name reserved by Windows (`con`, `nul`, `com1`…). It is also the name of the folder where StarLight installs the catalog. |
| `type` | yes | `deep-sky` for an object catalog, `stars` for a star package |
| `name` | yes | the name shown in the gallery, in English, up to 80 characters |
| `version` | yes | in the form `1.2.3`; must be increased when the data or the texts change |
| `group` | yes | the code of one of the gallery groups, see below |
| `description` | yes | two or three sentences in English on the content and usefulness of the catalog, up to 600 characters |
| `authors` | yes | who compiled the original catalog, up to 200 characters |
| `reference` | yes | the bibliographic reference to cite, up to 400 characters |
| `dataNote` | no | the description of objects that have no note of their own, up to 300 characters (for example “Position from Wikidata, without size…”); if missing, StarLight shows “From the … catalog.” with the catalog name |
| `source` | yes | the origin of the data, usually the address of the archive, up to 300 characters |
| `license` | yes | the data license, with its SPDX identifier, up to 40 characters (see [License and attribution](#license-and-attribution)) |
| `licenseLink` | yes | the address of the page that states the license, up to 300 characters |
| `objects` | yes | whole number of objects in the package (of stars, for a star package), greater than zero |
| `example` | yes for objects | an example designation, showing how to search for the objects, up to 40 characters; may be omitted for stars |
| `limitMagnitude` | yes for stars | the magnitude of the faintest star included, a number between 0 and 20 |
| `noteLanguages` | no | the languages of the note columns that follow the English one in `objects.tsv` (see [Languages](#languages)) |
| `translations` | no | the translated texts, by language code (see [Languages](#languages)) |

No text may contain control characters or invisible characters that reverse the writing direction (line breaks and
tabs are allowed). StarLight keeps only the fields listed here; any others are ignored.

### Groups

The gallery divides catalogs into these groups, given in the `group` field by their code:

| Code | Group |
|---|---|
| `stars` | Stars for plate solving (only for star packages, and star packages only here) |
| `emission-nebulae` | Emission nebulae |
| `dark-nebulae` | Dark nebulae |
| `reflection-nebulae` | Reflection nebulae |
| `planetary-nebulae` | Planetary nebulae |
| `supernova-remnants` | Supernova remnants |
| `galaxies` | Galaxies |
| `galaxy-groups` | Galaxy groups and clusters |
| `star-clusters` | Star clusters |
| `other` | Other |

The gallery shows the group name in the selected language.

The `id` should differ from those of the catalogs in the StarLight gallery, so that the custom catalog is not
confused with the downloadable ones.

## Languages

The main texts of the package are in English. Translations are optional, and StarLight shows the texts in the
language selected in Settings; when a translation is missing, it shows the English text.

- **Manifest texts**: the `translations` field contains, for each language code (`it`, `fr`, `pt-BR`…), the
  translated texts among `name`, `description`, `authors`, `reference` and `dataNote`, with the same length limits.
  At most 50 languages. The list of catalogs on the server carries the same texts, so the gallery is in the right
  language even before downloading.
- **Object notes**: in `objects.tsv`, column 11 contains the note in English; the following columns contain the same
  note in the languages listed in `noteLanguages`, in the same order (at most 20 languages, all different, without
  `en`). A note that is the same for all objects is best written only once, in `dataNote` and its translations,
  leaving the note columns empty.

The description of an object changes immediately with the language, without reinstalling the catalog.

## Objects, objects.tsv

A UTF-8 text file, one row per object, with columns separated by tabs. Rows starting with `#` and empty rows are
ignored; the first one is usually used for the header.

The columns, in order:

| No. | Column | Content | Rule |
|---|---|---|---|
| 1 | designation | the object designation, for example `Sh2-155` | required; StarLight keeps the first 60 characters |
| 2 | alternative names | other designations and names, separated by `\|` | optional |
| 3 | type | code in English, see below | optional; an unknown code becomes “other” |
| 4 | RA | right ascension in degrees, J2000 | required, from 0 (included) to 360 (excluded) |
| 5 | Dec | declination in degrees, J2000 | required, from -90 to +90 |
| 6 | major axis | in arcminutes | optional, from 0 to 3600 (60 degrees) |
| 7 | minor axis | in arcminutes | optional, from 0 to 3600 |
| 8 | position angle | in degrees | optional, from -360 to +360 |
| 9 | magnitude | | optional, from -30 to +40 |
| 10 | common name | for example `Bubble Nebula` | optional; if missing, the designation is shown |
| 11 | note | a sentence about the object, in English | optional; if missing, `dataNote` is shown or, without it, “From the … catalog.” with the catalog name |
| 12… | translated notes | the note in the languages of `noteLanguages`, in order | optional; if one is missing, the English one is shown |

Columns without data stay empty, but the tabs separating them must be present if a filled column follows. Numbers
are written with a decimal point (`83.82`, not `83,82`). Each row can be at most 4096 characters long.

The type codes:

| Code | Type |
|---|---|
| `galaxy` | galaxy |
| `galaxy-group` | galaxy group |
| `nebula` | nebula |
| `planetary-nebula` | planetary nebula |
| `supernova-remnant` | supernova remnant |
| `open-cluster` | open cluster |
| `globular-cluster` | globular cluster |
| `dark-nebula` | dark nebula |
| `star` | star |
| `double-star` | double star |
| `other` | other |

Codes are written in lowercase, exactly as in the table.

### Discarded rows

Rows with a problem (missing designation, coordinates outside the sky, an unreadable number, impossible values, row
too long) are discarded one by one, and the rest of the catalog is used anyway. However, if 5 or more rows are
discarded and they exceed 5% of the data rows, StarLight rejects the whole catalog, because a file with that many
errors is damaged or not in the right format.

The number of objects read must be consistent with the `objects` field of the manifest: never more, and not less
than 95%.

## Star packages, stars.bin

A star package has `"type": "stars"`, the `stars` group, the `limitMagnitude` field and, instead of `objects.tsv`,
the binary file `stars.bin`. StarLight reads it in pieces, only in the sky areas needed, without loading it all into
memory. With several star packages installed, StarLight uses the first active one that passes the checks.

The format, with numbers in little-endian order:

| Offset | Content | Type |
|---|---|---|
| 0 | the signature `SLST` | 4 bytes |
| 4 | format version, `1` | uint16 |
| 6 | number of declination strips (from 1 to 3600; 180 means one degree each) | uint16 |
| 8 | number of stars | uint32 |
| 12 | epoch of the positions, for example 2025.0 | float32 |
| 16 | number of cells | uint32 |
| 20 | index: for each cell, the position of its first star; plus a final value equal to the number of stars | (cells + 1) × uint32 |
| then | the stars, 6 bytes each | |

Each star takes 6 bytes:

- RA: uint24, the fraction of the full circle multiplied by 2^24;
- Dec: uint16, the position within the strip multiplied by 65535;
- magnitude: uint8, (m + 2) × 16.

The strips run from south to north, all of the same height h = 180 / strips. Each strip is divided into right
ascension cells about as wide as the strip is high, measured on the sky: max(1, ceil(360 · cos δ / h)) cells, where δ
is the edge of the strip closest to the equator (0 for the strip that crosses it). The cells are ordered by strip
and, within the strip, by right ascension; each star must be in its own cell.

StarLight checks that:

- the signature, the version, the number of cells and the index are consistent;
- the file length is exactly 20 + (cells + 1) × 4 + stars × 6 bytes;
- the number of stars equals the `objects` field of the manifest;
- no star is fainter than `limitMagnitude` (with a tolerance of one encoding step, 1/16);
- each star is in the right cell.

The project tool `tools/prepare-stars.mjs` writes this format and serves as a reference.

## License and attribution

StarLight only installs catalogs with free data. Whoever downloads them must be able to use and redistribute them
without restrictions such as “scientific use only” or “non-commercial”. These licenses are allowed, written with
their identifier (case does not matter):

| Identifier | License |
|---|---|
| `CC0-1.0` | Creative Commons Zero, waiver of rights (public domain) |
| `PDDL-1.0` | Open Data Commons Public Domain Dedication and License |
| `CC-BY-3.0`, `CC-BY-4.0` | Creative Commons Attribution |
| `CC-BY-SA-3.0`, `CC-BY-SA-4.0` | Creative Commons Attribution-ShareAlike |
| `ODC-By-1.0` | Open Data Commons Attribution License |
| `ODbL-1.0` | Open Database License |
| `etalab-2.0` | Licence Ouverte / Open Licence 2.0 |
| `OGL-UK-3.0` | United Kingdom Open Government Licence, version 3.0 |
| `LicenseRef-US-Government-Work` | work of the United States federal government, not subject to copyright in the United States; the gallery shows it as “Public domain” |

Several licenses cannot be combined into a single expression; the field contains only one license from this list.
Data from a source that does not state a license must not be used and, when in doubt, the source must be excluded.
Many historical catalogs do not state a license, while Wikidata data is all CC0.

The package must contain the license text, that is a file named `LICENSE`, with or without the `.txt` or `.md`
extension, up to 1 MB.

It is recommended to also add `ATTRIBUTION.md`, in English, with:

- the catalog name and a short description;
- the authors of the original catalog, the bibliographic reference, the data source, the license with its address
  and the number of objects;
- the changes made to the data (conversion to the StarLight format, objects removed, descriptions and translations
  added).

Attribution licenses (CC-BY, CC-BY-SA, ODC-By, ODbL) require exactly this information.

## Limits

| Item | Limit |
|---|---|
| ZIP archive | 300 MB, at most 20 files, 300 MB once extracted |
| single file in the archive | 256 MB |
| `catalog.json` | 64 KB |
| `objects.tsv` | 48 MB and 600,000 rows, comments included |
| row of `objects.tsv` | 4096 characters, translated notes included |
| objects in a catalog | 500,000 |
| `stars.bin` | 256 MB |
| stars in a package | 40 million |
| license and documents | 1 MB each (beyond that, they are not copied) |

The archive must be a ZIP without a password, with deflate compression or no compression (stored), without paths
that lead outside the folder and with a single `catalog.json`.

Each additional object makes recognition slightly heavier, so it is best to include only the objects actually
visible in images.

## Hashes

Catalogs downloaded from the StarLight gallery come with their SHA-256 hash, a kind of seal computed on the archive.
StarLight recomputes it after downloading and rejects a file that does not match, that is incomplete or larger than
expected.

Catalogs installed from an archive on disk have no hash to compare against, but they go through all the other
checks. Whoever distributes a catalog can publish its SHA-256 hash next to the archive, so that it can be verified.
On Windows it is computed in PowerShell with:

```
Get-FileHash .\nebulose-scelte-1.0.0.zip -Algorithm SHA256
```

## Installation

1. Open the gallery from the **Plugins** menu and choose the **Deep-sky catalogs** filter.
2. At the bottom of the window, next to “No connection? Install a catalog locally:”, choose **From a ZIP
   archive…**.
3. StarLight checks the package. If it accepts it, it copies it to the `%APPDATA%\StarLight\catalogs\<id>` folder,
   together with only the expected files; otherwise it shows the reason for the rejection.

A catalog with the same `id` as one already installed replaces it; to update it, increase the version and install it
again.

At every startup StarLight checks the installed catalogs again (manifest, folder name, license, data files and their
limits). A catalog that fails the checks stays in the gallery as “not loaded”, with the problem found and the buttons
to reinstall or uninstall it. If a catalog turns out to be unreadable during use, it is excluded and the others keep
working.

## Complete minimal example

**Archive `nebulose-scelte-1.0.0.zip`:**

```
catalog.json
objects.tsv
LICENSE.txt
ATTRIBUTION.md
```

**catalog.json**: the one shown in [The manifest](#the-manifest-catalogjson).

**objects.tsv** (columns are separated by a tab character, which appears here as a space; the last column is the
note in Italian, as declared by `"noteLanguages": ["it"]`):

```
# designation	alternative names	type	RA (degrees, J2000)	Dec (degrees, J2000)	major axis (arcmin)	minor axis (arcmin)	position angle (degrees)	magnitude	common name	note	note (it)
NS-1	NGC 7635|Sh2-162	nebula	350.20125	61.20167	15	8			Bubble Nebula	Bubble of gas blown by a young, hot star.	Bolla di gas soffiata da una stella giovane e calda.
NS-2	NGC 281|Sh2-184	nebula	13.10458	56.565	35	30			Pacman Nebula
NS-3	IC 1805|Sh2-190	nebula	38.175	61.45	150	150			Heart Nebula
```

**LICENSE.txt**: the text of the CC0 1.0 license, copied from the page given in `licenseLink`.

**ATTRIBUTION.md**

```markdown
# Selected nebulae

A selection of emission nebulae.

## Source and credits

- Authors: author name; positions from Wikidata
- Data source: https://www.wikidata.org
- Data license: CC0-1.0 (https://creativecommons.org/publicdomain/zero/1.0/)
- Objects in the package: 3

## Modifications

Positions converted to J2000 degrees; sizes estimated on the shots; notes written in English and Italian.
```

## Rejection messages

When StarLight rejects a catalog, the notice always has three parts: the subject (“The catalog “X” was not
installed.”, or “The star package “X”…”), the problem found and the suggested remedy. The following tables list all
possible problems, with the cause and how to fix it in the catalog. Parts shown as “…” are replaced with the actual
name or value.

### ZIP archive

| Message | Cause | Remedy |
|---|---|---|
| The selected file is not a valid ZIP archive. | the file is not a ZIP | compress the files in ZIP format |
| The ZIP archive is damaged: some parts cannot be read or do not match their declared size. | damaged or incomplete archive | recreate the archive and check that it downloads completely |
| The archive is password-protected and StarLight cannot open it. | encrypted archive | create the archive without a password |
| The archive uses a compression method StarLight does not support (only “stored” and “deflate” are allowed). | different compression method | use the standard deflate method |
| The archive contains files whose paths lead outside its folder (for example “../”) or point to a drive… | a path leads outside the folder | create the archive without absolute paths |
| The archive contains the same file twice with different contents… | two files with the same name, even if only the case differs | keep only one file per name |
| The archive contains too many files to be a catalog (maximum 20). | more than 20 files | remove the unnecessary files |
| Once extracted, the archive would take up too much space to be a catalog (maximum 300 MB). | content over 300 MB | reduce the data |
| The file “…” inside the archive is too large (maximum 256 MB). | a single file over 256 MB | reduce the file |
| The archive is built to inflate enormously when extracted… | a file over 1 MB compressed more than 500 times, or data longer than declared | do not include artificial files or files full of repeated data |
| The archive is too large to be a catalog (maximum 300 MB). | archive over 300 MB or using the extension for archives over 4 GB (ZIP64) | reduce the data and use a normal ZIP |
| The archive contains more than one catalog.json file: it must contain a single plugin or a single catalog. | several catalogs in the same archive | distribute one archive per catalog |
| The archive does not contain a catalog.json file, so it is not a StarLight catalog. | manifest missing, or nested in more than one folder | put `catalog.json` at the root or in a single folder |

### Manifest

| Message | Cause | Remedy |
|---|---|---|
| The catalog.json file is missing, so this is not a StarLight catalog. | manifest missing | add it |
| The catalog.json file is too large (maximum 64 kB). | manifest over 64 KB | keep only the expected fields |
| The catalog.json file does not contain valid JSON and cannot be read. | JSON syntax error | check commas, quotes and brackets with a JSON validator |
| The catalog.json file does not contain a valid manifest. | the content is not an object `{ … }` | write the manifest as a JSON object |
| The catalog uses a newer format than this version of StarLight can read. | `format` greater than 2 | write `"format": 2`; at installation the remedy “Update StarLight to the latest version and try again.” appears |
| The catalog format is not recognized (the “format” field must be 2). | `format` missing, not numeric or from an earlier version | write `"format": 2` |
| A required field is missing: … (the missing field, one of: the identifier, the name, the version, the group, the description, the authors, the bibliographic reference, the data source, the license, the license URL, an example designation) | required field missing or empty | add the field |
| The “…” field is too long (maximum … characters). | text over the allowed length | shorten it according to the [manifest](#the-manifest-catalogjson) table |
| The “…” field contains invisible or control characters, which can distort the displayed text. | control or direction-reversing characters | rewrite the text without invisible characters |
| The catalog identifier can only contain lowercase letters, digits and hyphens (2 to 40 characters). | invalid `id` | use for example `nebulose-scelte` |
| The name “…” is reserved by Windows (like CON, NUL, COM1) and cannot be used for a file or folder. | reserved `id` | choose another `id` |
| The version must have the form 1.2.3. | `version` not in the three-number form | write for example `1.0.0` |
| The package type “…” is not supported by this version of StarLight. | `type` missing or different from `deep-sky` and `stars` | write `"type": "deep-sky"` or `"type": "stars"` |
| The group “…” is not supported. | `group` not in the list | copy the exact code from [Groups](#groups) |
| The group “…” does not match the package type. | a star package outside its group, or an object catalog in the star group | match type and group correctly |
| The license “…” is not one of the open licenses allowed for data (CC0, CC-BY, CC-BY-SA, ODbL, public domain and similar). | license not in the list | use only data with a license from the [table](#license-and-attribution) |
| The number of objects is missing or is not a positive whole number. | `objects` missing, zero, negative or with decimals | write the number of data rows |
| The catalog declares too many objects for StarLight (maximum 500,000). | over 500,000 objects (40 million for stars) | split the catalog or keep only the objects visible in images |
| The limiting magnitude of the stars is missing or is not a number between 0 and 20. | `limitMagnitude` missing or out of range in a star package | add the magnitude of the faintest star |
| The “translations” field must hold the translated texts for each language code (it, fr…). | `translations` is not an object, has more than 50 languages, an invalid language code or a text that is not a string | write `"translations": { "it": { "name": "…" } }` |
| The “noteLanguages” field must be a list of distinct language codes (it, fr…), at most 20. | `noteLanguages` is not a list, repeats a language, contains `en` or an invalid code | write for example `"noteLanguages": ["it"]` |

### Objects

| Message | Cause | Remedy |
|---|---|---|
| The objects.tsv file with the catalog objects is missing. | file missing | add it with this exact name |
| The objects.tsv file is too large for a catalog (maximum 48 MB). | file over 48 MB | reduce the objects or the notes |
| The objects.tsv file is not readable text (it contains bytes that are not valid UTF-8). | file not saved as UTF-8 | save it with UTF-8 encoding |
| The objects.tsv file contains too many rows for a catalog (maximum 600,000). | over 600,000 rows, comments included | reduce the catalog |
| The objects.tsv file contains no readable objects. | no valid rows | check that columns are separated by tabs and not by spaces or commas |
| In the objects.tsv file, … rows out of … are unreadable or have impossible values (…): too many for the catalog to be reliable. | 5 or more rows discarded, over 5% | fix the rows; the problem of the first one appears in parentheses, see below |
| The manifest declares … objects, but … are read from the file: the package is incomplete or does not match its manifest. | the `objects` field does not match the rows read | update `objects` with the number of data rows |

The problems of a row, which appear in parentheses in the message about unreadable rows:

| Problem | Remedy |
|---|---|
| a row without a designation | each row must start with the designation |
| coordinates outside the sky (RA between 0 and 360 degrees, Dec between -90 and +90) | write the coordinates in decimal degrees, not in hours or in degrees, minutes and seconds |
| impossible sizes (negative or over 60 degrees) | axes are given in arcminutes |
| an impossible magnitude (outside -30…+40) | check the magnitude column |
| an impossible position angle | the angle is given in degrees, between -360 and +360 |
| a row that is too long | shorten notes and alternative names below 4096 characters |
| an unreadable number | use the decimal point and leave the column empty if the value is missing |

### Stars

| Message | Cause | Remedy |
|---|---|---|
| The stars.bin file with the package stars is missing. | file missing | add it with this exact name |
| The stars.bin file is too large for a star package (maximum 256 MB). | file over 256 MB | lower the limiting magnitude |
| The star file is too short. | file shorter than the header | regenerate the file |
| The file does not contain stars for plate solving. | `SLST` signature missing | regenerate the file in the format described above |
| The star file uses a newer format than this version of StarLight can read. | format version greater than 1 | write version 1 |
| The star file format is not recognized. | invalid format version | write version 1 |
| The star file is damaged (strips / cells / index / total). | inconsistent number of strips, cells or index | recompute cells and index with the rule described above |
| The star file is incomplete: its length does not match the index. | length different from 20 + (cells + 1) × 4 + stars × 6 | regenerate the whole file |
| The stars.bin file contains … stars, but the manifest declares …. | `objects` does not match the file | update `objects` in the manifest |
| The stars.bin file contains stars down to magnitude …, but the manifest declares a limit of …: the two are inconsistent. | stars fainter than the declared limit | raise `limitMagnitude` or remove the fainter stars |
| In the stars.bin file, … stars are recorded in the wrong sky zone… | stars outside their cell | sort the stars by strip and by cell before writing them |

### License, copy and startup

| Message | Cause | Remedy |
|---|---|---|
| The package is missing the data license text (a LICENSE.txt file). | license file missing, or larger than 1 MB | add `LICENSE.txt` with the license text |
| The catalog could not be copied: “…”. | copy to the catalogs folder failed | free up disk space and try again |
| The catalog folder is named “…”, but its manifest declares the identifier “…”: the two names must match. | appears only at startup, if the installed folder was renamed or copied by hand | uninstall the catalog and install it again from the archive |
| The file … could not be read from disk. | appears at startup, if the installed folder is not readable | uninstall the catalog and install it again |

### Only for catalogs downloaded from the gallery

These messages concern packages downloaded from the StarLight server, not those installed from disk.

| Message | Meaning |
|---|---|
| The downloaded file does not match the original (different SHA-256 hash): it was not installed. | the file was damaged during the download |
| The downloaded file is incomplete. | the download was interrupted |
| The downloaded file is larger than expected. | the file is not the expected one |
| The downloaded package contains a different catalog from the one selected. | the `id` in the package is not the one requested |

In these cases the remedy shown is “Try again later; if the problem persists, report it to FM Digital Tools.”
