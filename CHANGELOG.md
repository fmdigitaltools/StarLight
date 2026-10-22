# Changelog

All notable changes to StarLight are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and StarLight follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): test releases carry a pre-release tag
(`1.0.0-beta.1`), stable releases do not. Each version also has a code name, a well-known celestial object.

## [1.0.0-beta.1] «Vega»

First public Beta.

### Added

- Opening of stacked or single images: FITS and XISF files, TIFF and PNG images and camera RAW formats.
- Abracadabra, automatic preparation of the image (sky background, color, noise, stretch and finish), with every
  step adjustable by hand.
- Calibration and stacking: calibration frames and library, alignment, rejection of blurred frames, drizzle, HDR,
  mosaics, multiple nights and live sessions.
- Processing tools and photographic filters, with local adjustments through masks.
- Plate solving, downloadable deep-sky catalogs, coordinates and captions on the image, export for printing and
  social media.
- Plugin and catalog gallery; plugins run in an isolated environment.
- Interface in Italian and English.
- Automatic updates, with a stable and a test (Beta) channel.

[1.0.0-beta.1]: https://github.com/fmdigitaltools/StarLight/releases/tag/v1.0.0-beta.1
