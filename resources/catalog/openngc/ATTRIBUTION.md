# Object catalog — source and license

StarLight's deep-sky objects come from **OpenNGC**, a database of NGC/IC
objects maintained by Mattia Verga.

- Source: https://github.com/mattiaverga/OpenNGC
- Data license: **CC-BY-SA-4.0** (full text in `CC-BY-SA-4.0.txt`)
- Original files, unmodified: `NGC.csv`, `addendum.csv`

At build time `tools/generate-catalog.mjs` derives from these files a version
reduced to the columns the application uses
(`src/core/catalog/openNgcData.ts`). That version is an adaptation of the
database and therefore stays under the **CC-BY-SA-4.0** license: it must be
attributed to OpenNGC and, if redistributed, kept under the same license. The
license covers the catalog data, not the application code.

The attribution must also be shown in the app's "About StarLight" window.
