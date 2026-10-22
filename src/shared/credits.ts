/**
 * Third-party acknowledgements: components, data, services and methods
 * StarLight relies on.
 *
 * This is the short list shown in the License and acknowledgements window
 * and on the first page of the installer. The full text, with the complete
 * component licenses, is in THIRD-PARTY-NOTICES.md at the project root and
 * is regenerated with `node tools/generate-credits.mjs`, which also reads
 * this file.
 *
 * The file imports nothing and uses only type annotations, so the script can
 * load it directly with Node without compiling it. For the same reason the
 * English texts are kept here as data (`CREDITS_EN`, `CATEGORY_TITLES_EN`)
 * instead of in the language files: the interface picks the list with
 * `creditsFor()` and `categoryTitlesFor()`.
 */

/** Section the entry appears in. */
export type CreditCategory = 'component' | 'data' | 'catalogs' | 'service' | 'algorithm' | 'installer'

export interface Credit {
  /** Name of the component, data or method. */
  name: string
  /** Authors or rights holders. */
  author: string
  /** License, or the terms of use for data and services. */
  license: string
  /** Reference page. */
  link: string
  category: CreditCategory
  /**
   * Package name in node_modules, for components installed with npm: the
   * generation script reads its license and full text and reports if the
   * license declared here no longer matches.
   */
  pkg?: string
  /** Bibliographic reference (for methods taken from papers). */
  reference?: string
  /** Short note shown below the entry. */
  note?: string
  /**
   * True for the entries that must appear in the installer license note;
   * see INSTALLER_LINES for the rule.
   */
  installer?: boolean
}

export const CATEGORY_TITLES: Record<CreditCategory, string> = {
  component: 'Componenti inclusi nel programma',
  data: 'Dati inclusi',
  catalogs: 'Cataloghi deep sky da scaricare',
  service: 'Servizi consultati in rete',
  algorithm: 'Metodi di elaborazione tratti dalla letteratura',
  installer: 'Programma di installazione'
}

/** Acknowledgement text required by ESA for the use of Gaia data. */
export const GAIA_CITATION =
  'This work has made use of data from the European Space Agency (ESA) mission Gaia ' +
  '(https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis ' +
  'Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). Funding for the ' +
  'DPAC has been provided by national institutions, in particular the institutions ' +
  'participating in the Gaia Multilateral Agreement.'

export const CREDITS: Credit[] = [
  // --- Components included in the program ---
  {
    name: 'Electron',
    author: 'Electron contributors, GitHub Inc.',
    license: 'MIT',
    link: 'https://www.electronjs.org',
    category: 'component',
    pkg: 'electron',
    installer: true
  },
  {
    name: 'Chromium',
    author: 'The Chromium Authors',
    license: 'BSD-3-Clause e altre licenze libere',
    link: 'https://www.chromium.org',
    category: 'component',
    note: 'Incluso in Electron. Le licenze di tutti i suoi componenti sono nel file LICENSES.chromium.html, nella cartella del programma.',
    installer: true
  },
  {
    name: 'Node.js',
    author: 'OpenJS Foundation e collaboratori di Node.js',
    license: 'MIT',
    link: 'https://nodejs.org',
    category: 'component',
    note: 'Incluso in Electron.',
    installer: true
  },
  {
    name: 'React',
    author: 'Meta Platforms, Inc. e collaboratori',
    license: 'MIT',
    link: 'https://react.dev',
    category: 'component',
    pkg: 'react',
    installer: true
  },
  {
    name: 'React DOM',
    author: 'Meta Platforms, Inc. e collaboratori',
    license: 'MIT',
    link: 'https://react.dev',
    category: 'component',
    pkg: 'react-dom',
    installer: true
  },
  {
    name: 'Scheduler',
    author: 'Meta Platforms, Inc. e collaboratori',
    license: 'MIT',
    link: 'https://github.com/facebook/react',
    category: 'component',
    pkg: 'scheduler',
    note: 'Libreria di supporto di React DOM.'
  },
  {
    name: 'Zustand',
    author: 'Paul Henschel e collaboratori',
    license: 'MIT',
    link: 'https://github.com/pmndrs/zustand',
    category: 'component',
    pkg: 'zustand',
    installer: true
  },
  {
    name: 'electron-updater',
    author: 'Vladimir Krivosheev e collaboratori di electron-builder',
    license: 'MIT',
    link: 'https://github.com/electron-userland/electron-builder',
    category: 'component',
    pkg: 'electron-updater',
    installer: true
  },
  {
    name: 'Librerie di supporto di electron-updater',
    author: 'Autori vari',
    license: 'MIT, ISC, BlueOak-1.0.0, Python-2.0',
    link: 'https://github.com/electron-userland/electron-builder',
    category: 'component',
    note: 'fs-extra, graceful-fs, jsonfile, universalify, js-yaml, argparse, lazy-val, lodash.escaperegexp, lodash.isequal, semver, tiny-typed-emitter, builder-util-runtime, debug, ms, sax. Autori e licenze integrali in THIRD-PARTY-NOTICES.md.',
    installer: true
  },
  {
    name: 'LibRaw',
    author: 'LibRaw LLC',
    license: 'LGPL-2.1',
    link: 'https://www.libraw.org',
    category: 'component',
    note: 'Lettura dei RAW delle fotocamere, compilata in WebAssembly. LibRaw è offerta con licenza LGPL-2.1 o CDDL-1.0: StarLight la usa con la LGPL-2.1, compatibile con la GPL.',
    installer: true
  },
  {
    name: '@colorhythm/libraw-wasm',
    author: 'TOMIKAWA Sotaro',
    license: 'MIT',
    link: 'https://github.com/colorhythm/libraw-wasm',
    category: 'component',
    pkg: '@colorhythm/libraw-wasm',
    note: 'LibRaw compilata in WebAssembly, con l’accesso ai dati grezzi del sensore.',
    installer: true
  },
  {
    name: 'typed-cstruct',
    author: 'TOMIKAWA Sotaro',
    license: 'MIT',
    link: 'https://github.com/ssssota/typed-cstruct',
    category: 'component',
    pkg: 'typed-cstruct',
    note: 'Libreria di supporto di @colorhythm/libraw-wasm.'
  },

  // --- Included data ---
  {
    name: 'Catalogo OpenNGC',
    author: 'Mattia Verga',
    license: 'CC BY-SA 4.0',
    link: 'https://github.com/mattiaverga/OpenNGC',
    category: 'data',
    note: 'StarLight include una versione ridotta del catalogo, con i nomi comuni tradotti in italiano. Questo adattamento resta sotto licenza CC BY-SA 4.0.',
    installer: true
  },

  {
    name: 'Tavolozze viridis, magma, inferno e plasma',
    author: 'Nathaniel J. Smith, Stéfan van der Walt, Eric Firing',
    license: 'CC0 1.0 (pubblico dominio)',
    link: 'https://github.com/BIDS/colormap',
    category: 'data',
    note: 'Tavolozze percettivamente uniformi usate dal plugin Falsi colori per luminosità.'
  },

  // --- Downloadable deep-sky catalogs (plugin gallery) ---
  {
    name: 'Ammassi stellari da Gaia DR3',
    author: 'Emily L. Hunt, Sabine Reffert',
    license: 'CC BY 4.0',
    link: 'https://doi.org/10.1051/0004-6361/202346285',
    category: 'catalogs',
    reference: 'E. L. Hunt, S. Reffert, «Improving the open cluster census. II», A&A 673, A114 (2023).',
    note: 'Pacchetto facoltativo, scaricato dal server di StarLight solo su richiesta.'
  },
  {
    name: 'UCAC4, quarto catalogo astrometrico dello U.S. Naval Observatory',
    author: 'Norbert Zacharias e collaboratori, U.S. Naval Observatory',
    license: 'Opera del governo degli Stati Uniti, non soggetta a copyright negli USA (17 U.S.C. § 105)',
    link: 'https://doi.org/10.26131/IRSA17',
    category: 'catalogs',
    reference:
      'N. Zacharias et al., «The Fourth US Naval Observatory CCD Astrograph Catalog (UCAC4)», AJ 145, 44 (2013); dati dal NASA/IPAC Infrared Science Archive, DOI 10.26131/IRSA17.',
    note: 'Stelle fino alla magnitudine 12 per la risoluzione del campo senza internet, nel pacchetto facoltativo «Stelle per la risoluzione del campo», scaricato dal server di StarLight solo su richiesta.'
  },
  {
    name: 'Ammassi globulari della Via Lattea',
    author: 'Eugene Vasiliev, Holger Baumgardt',
    license: 'CC BY 4.0',
    link: 'https://doi.org/10.1093/mnras/stab1475',
    category: 'catalogs',
    reference: 'E. Vasiliev, H. Baumgardt, «Gaia EDR3 view on galactic globular clusters», MNRAS 505, 5978 (2021).',
    note: 'Pacchetto facoltativo, scaricato dal server di StarLight solo su richiesta.'
  },
  {
    name: 'Siena Galaxy Atlas 2020',
    author: 'John Moustakas e collaboratori',
    license: 'CC BY 4.0',
    link: 'https://doi.org/10.3847/1538-4365/acfaa2',
    category: 'catalogs',
    reference: 'J. Moustakas et al., «Siena Galaxy Atlas 2020», ApJS 269, 3 (2023).',
    note: 'Pacchetto facoltativo di galassie fino alla magnitudine 14, scaricato dal server di StarLight solo su richiesta.'
  },
  {
    name: 'Diametri delle nebulose planetarie',
    author: 'Beatrice Bucciarelli, Letizia Stanghellini e collaboratori',
    license: 'CC BY 4.0 e CC BY 3.0',
    link: 'https://doi.org/10.1051/0004-6361/202347519',
    category: 'catalogs',
    reference:
      'B. Bucciarelli, L. Stanghellini, A&A 680, A104 (2023); L. Stanghellini et al., ApJ 889, 21 (2020).',
    note: 'Pacchetto facoltativo «Nebulose planetarie», scaricato dal server di StarLight solo su richiesta.'
  },
  {
    name: 'Resti di supernova della Via Lattea',
    author: 'Sujith Ranasinghe, Denis Leahy',
    license: 'CC BY 4.0',
    link: 'https://doi.org/10.3847/1538-4365/acc1de',
    category: 'catalogs',
    reference: 'S. Ranasinghe, D. Leahy, ApJS 265, 53 (2023).',
    note: 'Pacchetto facoltativo «Resti di supernova», scaricato dal server di StarLight solo su richiesta.'
  },
  {
    name: 'Catalogo MCXC-II degli ammassi di galassie',
    author: 'Tatyana Sadibekova e collaboratori',
    license: 'CC BY 4.0',
    link: 'https://doi.org/10.1051/0004-6361/202449427',
    category: 'catalogs',
    reference: 'T. Sadibekova et al., A&A 688, A187 (2024).',
    note: 'Pacchetto facoltativo «Ammassi di galassie vicini», scaricato dal server di StarLight solo su richiesta.'
  },
  {
    name: 'Wikidata',
    author: 'Wikimedia Foundation e comunità di Wikidata',
    license: 'CC0 1.0',
    link: 'https://www.wikidata.org',
    category: 'catalogs',
    note: 'Posizioni e nomi dei cataloghi Sharpless, LBN, LDN, Barnard, RCW, Gum, Cederblad, van den Bergh, Arp e Hickson, delle nebulose planetarie, dei resti di supernova e degli ammassi di galassie, in pacchetti facoltativi scaricati dal server di StarLight solo su richiesta.'
  },

  // --- Online services ---
  {
    name: 'Catalogo Gaia DR3',
    author: 'ESA/Gaia/DPAC',
    license: 'Uso libero con citazione',
    link: 'https://www.cosmos.esa.int/gaia',
    category: 'service',
    reference:
      'Gaia Collaboration, T. Prusti et al., «The Gaia mission», A&A 595, A1 (2016); ' +
      'Gaia Collaboration, A. Vallenari et al., «Gaia Data Release 3. Summary of the content and survey properties», A&A 674, A1 (2023).',
    note: 'Consultato per la calibrazione fotometrica del colore e per la risoluzione del campo. ' + GAIA_CITATION,
    installer: true
  },
  {
    name: 'VizieR',
    author: 'CDS, Strasbourg Astronomical Observatory, France',
    license: 'Uso libero con citazione',
    link: 'https://vizier.cds.unistra.fr',
    category: 'service',
    reference:
      'F. Ochsenbein, P. Bauer, J. Marcout, «The VizieR database of astronomical catalogues», A&AS 143, 23 (2000). DOI: 10.26093/cds/vizier.',
    note: 'Servizio da cui StarLight legge di preferenza il catalogo Gaia. In alternativa usa l’archivio Gaia dell’ESA.'
  },

  // --- Processing methods ---
  {
    name: 'Riduzione del rumore NL-Bayes',
    author: 'Marc Lebrun, Antoni Buades, Jean-Michel Morel',
    license: 'Citazione',
    link: 'https://doi.org/10.5201/ipol.2013.16',
    category: 'algorithm',
    reference:
      'M. Lebrun, A. Buades, J.-M. Morel, «Implementation of the "Non-Local Bayes" (NL-Bayes) Image Denoising Algorithm», Image Processing On Line 3, 1–42 (2013); ' +
      '«A Nonlocal Bayesian Image Denoising Algorithm», SIAM J. Imaging Sciences 6(3), 1665–1688 (2013).'
  },
  {
    name: 'Distensione iperbolica generalizzata (GHS)',
    author: 'David Payne, Mike Cranfield',
    license: 'Citazione',
    link: 'https://ghsastro.co.uk',
    category: 'algorithm',
    reference: 'D. Payne, M. Cranfield, «Generalised Hyperbolic Stretch» (2021), ghsastro.co.uk.'
  },
  {
    name: 'Ondine «à trous»',
    author: 'Jean-Luc Starck, Fionn Murtagh',
    license: 'Citazione',
    link: 'https://doi.org/10.1007/978-3-540-33025-7',
    category: 'algorithm',
    reference:
      'J.-L. Starck, F. Murtagh, «Image restoration with noise suppression using the wavelet transform», A&A 288, 342–348 (1994); ' +
      '«Astronomical Image and Data Analysis», Springer, 2ª ed. (2006).'
  },
  {
    name: 'Deconvoluzione di Richardson-Lucy',
    author: 'William H. Richardson, Leon B. Lucy',
    license: 'Citazione',
    link: 'https://doi.org/10.1364/JOSA.62.000055',
    category: 'algorithm',
    reference:
      'W. H. Richardson, «Bayesian-Based Iterative Method of Image Restoration», J. Opt. Soc. Am. 62(1), 55–59 (1972); ' +
      'L. B. Lucy, «An iterative technique for the rectification of observed distributions», AJ 79, 745 (1974).'
  },
  {
    name: 'Contrasto locale CLAHE',
    author: 'Karel Zuiderveld; Stephen M. Pizer e altri',
    license: 'Citazione',
    link: 'https://doi.org/10.1016/B978-0-12-336156-1.50061-6',
    category: 'algorithm',
    reference:
      'K. Zuiderveld, «Contrast Limited Adaptive Histogram Equalization», in Graphics Gems IV, Academic Press, 474–485 (1994); ' +
      'S. M. Pizer et al., «Adaptive histogram equalization and its variations», Computer Vision, Graphics, and Image Processing 39, 355–368 (1987).'
  },
  {
    name: 'Relazione fra colore e temperatura delle stelle',
    author: 'Mark J. Pecaut, Eric E. Mamajek',
    license: 'Citazione',
    link: 'https://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt',
    category: 'algorithm',
    reference:
      'M. J. Pecaut, E. E. Mamajek, «Intrinsic Colors, Temperatures, and Bolometric Corrections of Pre-main-sequence Stars», ApJS 208, 9 (2013), ' +
      'con la tabella aggiornata «A Modern Mean Dwarf Stellar Color and Effective Temperature Sequence».',
    note: 'Usata dalla calibrazione fotometrica del colore.'
  },
  {
    name: 'Selezione robusta delle corrispondenze (RANSAC)',
    author: 'Martin A. Fischler, Robert C. Bolles',
    license: 'Citazione',
    link: 'https://doi.org/10.1145/358669.358692',
    category: 'algorithm',
    reference:
      'M. A. Fischler, R. C. Bolles, «Random Sample Consensus: A Paradigm for Model Fitting with Applications to Image Analysis and Automated Cartography», Communications of the ACM 24(6), 381–395 (1981).',
    note: 'Usata dalla risoluzione astrometrica del campo.'
  },
  {
    name: 'Coordinate celesti nei file FITS (WCS e SIP)',
    author: 'Eric W. Greisen, Mark R. Calabretta; David L. Shupe e altri',
    license: 'Citazione',
    link: 'https://doi.org/10.1051/0004-6361:20021326',
    category: 'algorithm',
    reference:
      'E. W. Greisen, M. R. Calabretta, «Representations of world coordinates in FITS», A&A 395, 1061–1075 (2002); ' +
      'M. R. Calabretta, E. W. Greisen, «Representations of celestial coordinates in FITS», A&A 395, 1077–1122 (2002); ' +
      'D. L. Shupe et al., «The SIP Convention for Representing Distortion in FITS Image Headers», ASP Conf. Ser. 347, 491 (2005).'
  },
  {
    name: 'Compressione HCOMPRESS dei FITS',
    author: 'Richard L. White',
    license: 'Citazione',
    link: 'https://heasarc.gsfc.nasa.gov/fitsio/',
    category: 'algorithm',
    reference:
      'R. L. White, «High-performance compression of astronomical images», Proceedings of the NASA Space and Earth Science Data Compression Workshop, 70–79 (1992).',
    note: 'Decompressore scritto per StarLight; per la disposizione dei bit si è consultato il codice di riferimento distribuito con cfitsio (NASA, licenza permissiva).'
  },
  {
    name: 'Compressione Zstandard',
    author: 'Yann Collet, Murray S. Kucherawy',
    license: 'Citazione',
    link: 'https://www.rfc-editor.org/rfc/rfc8878',
    category: 'algorithm',
    reference: 'Y. Collet, M. Kucherawy (a cura di), «Zstandard Compression and the \'application/zstd\' Media Type», RFC 8878 (2021).',
    note: 'Decompressore scritto per StarLight dalla specifica, usato per gli XISF compressi.'
  },
  {
    name: 'Funzioni di corrispondenza dei colori CIE 1931, approssimazione analitica',
    author: 'Chris Wyman, Peter-Pike Sloan, Peter Shirley',
    license: 'Citazione',
    link: 'https://jcgt.org/published/0002/02/01/',
    category: 'algorithm',
    reference:
      'C. Wyman, P.-P. Sloan, P. Shirley, «Simple Analytic Approximations to the CIE XYZ Color Matching Functions», Journal of Computer Graphics Techniques 2(2), 1–11 (2013).',
    note: 'Usata per calcolare le tinte delle righe di emissione del plugin Colorazione delle immagini monocromatiche.'
  },

  // --- Installer ---
  {
    name: 'Neutralinojs',
    author: 'Shalitha Suranga e collaboratori',
    license: 'MIT',
    link: 'https://neutralino.js.org',
    category: 'installer',
    note: 'Versione 6.10.0, usata solo dalla finestra di installazione; non resta nel programma installato.',
    installer: true
  }
]

/** Compact line, e.g. "Catalogo OpenNGC, Mattia Verga — CC BY-SA 4.0". */
export function creditLine(r: Credit): string {
  // For software components the name is enough: the authors are collective.
  const withAuthor = r.category === 'data' || r.category === 'service'
  return (withAuthor ? r.name + ', ' + r.author : r.name) + ' — ' + r.license
}

/**
 * Lines of the installer license note.
 *
 * Rule: list what is distributed, or queried, on condition of attribution.
 * That is, the included components under MIT, BSD or similar licenses,
 * which require every copy to carry the copyright notice (minor libraries
 * are grouped in one line that refers to THIRD-PARTY-NOTICES.md), the
 * OpenNGC catalog (CC BY-SA requires attribution) and Gaia (ESA requires a
 * citation). Methods taken from papers, which have no license and only need
 * to be cited, are left out, and so is VizieR, which is only the channel
 * the already cited Gaia data passes through.
 */
export const INSTALLER_LINES: string[] = CREDITS.filter((r) => r.installer).map(creditLine)


/** Section titles in English. */
export const CATEGORY_TITLES_EN: Record<CreditCategory, string> = {
  component: 'Components included in the program',
  data: 'Included data',
  catalogs: 'Downloadable deep-sky catalogs',
  service: 'Online services',
  algorithm: 'Processing methods from the literature',
  installer: 'Installer'
}

type CreditTexts = Partial<Pick<Credit, 'name' | 'author' | 'license' | 'note' | 'reference'>>

/** English texts of the entries, keyed by the Italian name; fields left out are the same in both languages. */
const ENGLISH: Record<string, CreditTexts> = {
  Chromium: {
    license: 'BSD-3-Clause and other free licenses',
    note: 'Included in Electron. The licenses of all its components are in the LICENSES.chromium.html file, in the program folder.'
  },
  'Node.js': { author: 'OpenJS Foundation and Node.js contributors', note: 'Included in Electron.' },
  React: { author: 'Meta Platforms, Inc. and contributors' },
  'React DOM': { author: 'Meta Platforms, Inc. and contributors' },
  Scheduler: { author: 'Meta Platforms, Inc. and contributors', note: 'Support library of React DOM.' },
  Zustand: { author: 'Paul Henschel and contributors' },
  'electron-updater': { author: 'Vladimir Krivosheev and electron-builder contributors' },
  'Librerie di supporto di electron-updater': {
    name: 'electron-updater support libraries',
    author: 'Various authors',
    note: 'fs-extra, graceful-fs, jsonfile, universalify, js-yaml, argparse, lazy-val, lodash.escaperegexp, lodash.isequal, semver, tiny-typed-emitter, builder-util-runtime, debug, ms, sax. Authors and full licenses in THIRD-PARTY-NOTICES.md.'
  },
  LibRaw: {
    note: 'Reading of camera RAW files, compiled to WebAssembly. LibRaw is offered under the LGPL-2.1 or CDDL-1.0 license: StarLight uses it under the LGPL-2.1, which is compatible with the GPL.'
  },
  '@colorhythm/libraw-wasm': { note: 'LibRaw compiled to WebAssembly, with access to the raw sensor data.' },
  'typed-cstruct': { note: 'Support library of @colorhythm/libraw-wasm.' },
  'Catalogo OpenNGC': {
    name: 'OpenNGC catalog',
    note: 'StarLight includes a reduced version of the catalog, with translated common names. This adaptation remains under the CC BY-SA 4.0 license.'
  },
  'Tavolozze viridis, magma, inferno e plasma': {
    name: 'Viridis, magma, inferno and plasma colormaps',
    license: 'CC0 1.0 (public domain)',
    note: 'Perceptually uniform colormaps used by the luminance false color plugin.'
  },
  'Ammassi stellari da Gaia DR3': {
    name: 'Star clusters from Gaia DR3',
    note: 'Optional package, downloaded from the StarLight server only on request.'
  },
  'UCAC4, quarto catalogo astrometrico dello U.S. Naval Observatory': {
    name: 'UCAC4, fourth U.S. Naval Observatory astrometric catalog',
    author: 'Norbert Zacharias and collaborators, U.S. Naval Observatory',
    license: 'U.S. Government work, not subject to copyright in the United States (17 U.S.C. § 105)',
    reference:
      'N. Zacharias et al., “The Fourth US Naval Observatory CCD Astrograph Catalog (UCAC4)”, AJ 145, 44 (2013); data from the NASA/IPAC Infrared Science Archive, DOI 10.26131/IRSA17.',
    note: 'Stars down to magnitude 12 for plate solving without internet access, in the optional “Stars for plate solving” package, downloaded from the StarLight server only on request.'
  },
  'Ammassi globulari della Via Lattea': {
    name: 'Milky Way globular clusters',
    reference: 'E. Vasiliev, H. Baumgardt, “Gaia EDR3 view on galactic globular clusters”, MNRAS 505, 5978 (2021).',
    note: 'Optional package, downloaded from the StarLight server only on request.'
  },
  'Siena Galaxy Atlas 2020': {
    author: 'John Moustakas and collaborators',
    reference: 'J. Moustakas et al., “Siena Galaxy Atlas 2020”, ApJS 269, 3 (2023).',
    note: 'Optional package of galaxies down to magnitude 14, downloaded from the StarLight server only on request.'
  },
  'Diametri delle nebulose planetarie': {
    name: 'Planetary nebula diameters',
    author: 'Beatrice Bucciarelli, Letizia Stanghellini and collaborators',
    license: 'CC BY 4.0 and CC BY 3.0',
    note: 'Optional “Planetary nebulae” package, downloaded from the StarLight server only on request.'
  },
  'Resti di supernova della Via Lattea': {
    name: 'Milky Way supernova remnants',
    note: 'Optional “Supernova remnants” package, downloaded from the StarLight server only on request.'
  },
  'Catalogo MCXC-II degli ammassi di galassie': {
    name: 'MCXC-II galaxy cluster catalog',
    author: 'Tatyana Sadibekova and collaborators',
    note: 'Optional “Nearby galaxy clusters” package, downloaded from the StarLight server only on request.'
  },
  Wikidata: {
    author: 'Wikimedia Foundation and the Wikidata community',
    note: 'Positions and names of the Sharpless, LBN, LDN, Barnard, RCW, Gum, Cederblad, van den Bergh, Arp and Hickson catalogs, of planetary nebulae, supernova remnants and galaxy clusters, in optional packages downloaded from the StarLight server only on request.'
  },
  'Catalogo Gaia DR3': {
    name: 'Gaia DR3 catalog',
    license: 'Free use with citation',
    reference:
      'Gaia Collaboration, T. Prusti et al., “The Gaia mission”, A&A 595, A1 (2016); ' +
      'Gaia Collaboration, A. Vallenari et al., “Gaia Data Release 3. Summary of the content and survey properties”, A&A 674, A1 (2023).',
    note: 'Queried for photometric color calibration and for plate solving. ' + GAIA_CITATION
  },
  VizieR: {
    license: 'Free use with citation',
    reference:
      'F. Ochsenbein, P. Bauer, J. Marcout, “The VizieR database of astronomical catalogues”, A&AS 143, 23 (2000). DOI: 10.26093/cds/vizier.',
    note: 'Service from which StarLight preferably reads the Gaia catalog. Otherwise it uses the ESA Gaia archive.'
  },
  'Riduzione del rumore NL-Bayes': {
    name: 'NL-Bayes noise reduction',
    license: 'Citation',
    reference:
      'M. Lebrun, A. Buades, J.-M. Morel, “Implementation of the "Non-Local Bayes" (NL-Bayes) Image Denoising Algorithm”, Image Processing On Line 3, 1–42 (2013); ' +
      '“A Nonlocal Bayesian Image Denoising Algorithm”, SIAM J. Imaging Sciences 6(3), 1665–1688 (2013).'
  },
  'Distensione iperbolica generalizzata (GHS)': {
    name: 'Generalized hyperbolic stretch (GHS)',
    license: 'Citation',
    reference: 'D. Payne, M. Cranfield, “Generalised Hyperbolic Stretch” (2021), ghsastro.co.uk.'
  },
  'Ondine «à trous»': {
    name: '“À trous” wavelets',
    license: 'Citation',
    reference:
      'J.-L. Starck, F. Murtagh, “Image restoration with noise suppression using the wavelet transform”, A&A 288, 342–348 (1994); ' +
      '“Astronomical Image and Data Analysis”, Springer, 2nd ed. (2006).'
  },
  'Deconvoluzione di Richardson-Lucy': {
    name: 'Richardson-Lucy deconvolution',
    license: 'Citation',
    reference:
      'W. H. Richardson, “Bayesian-Based Iterative Method of Image Restoration”, J. Opt. Soc. Am. 62(1), 55–59 (1972); ' +
      'L. B. Lucy, “An iterative technique for the rectification of observed distributions”, AJ 79, 745 (1974).'
  },
  'Contrasto locale CLAHE': {
    name: 'CLAHE local contrast',
    author: 'Karel Zuiderveld; Stephen M. Pizer et al.',
    license: 'Citation',
    reference:
      'K. Zuiderveld, “Contrast Limited Adaptive Histogram Equalization”, in Graphics Gems IV, Academic Press, 474–485 (1994); ' +
      'S. M. Pizer et al., “Adaptive histogram equalization and its variations”, Computer Vision, Graphics, and Image Processing 39, 355–368 (1987).'
  },
  'Relazione fra colore e temperatura delle stelle': {
    name: 'Relation between star color and temperature',
    license: 'Citation',
    reference:
      'M. J. Pecaut, E. E. Mamajek, “Intrinsic Colors, Temperatures, and Bolometric Corrections of Pre-main-sequence Stars”, ApJS 208, 9 (2013), ' +
      'with the updated table “A Modern Mean Dwarf Stellar Color and Effective Temperature Sequence”.',
    note: 'Used by photometric color calibration.'
  },
  'Selezione robusta delle corrispondenze (RANSAC)': {
    name: 'Robust match selection (RANSAC)',
    license: 'Citation',
    reference:
      'M. A. Fischler, R. C. Bolles, “Random Sample Consensus: A Paradigm for Model Fitting with Applications to Image Analysis and Automated Cartography”, Communications of the ACM 24(6), 381–395 (1981).',
    note: 'Used by astrometric plate solving.'
  },
  'Coordinate celesti nei file FITS (WCS e SIP)': {
    name: 'Celestial coordinates in FITS files (WCS and SIP)',
    author: 'Eric W. Greisen, Mark R. Calabretta; David L. Shupe et al.',
    license: 'Citation',
    reference:
      'E. W. Greisen, M. R. Calabretta, “Representations of world coordinates in FITS”, A&A 395, 1061–1075 (2002); ' +
      'M. R. Calabretta, E. W. Greisen, “Representations of celestial coordinates in FITS”, A&A 395, 1077–1122 (2002); ' +
      'D. L. Shupe et al., “The SIP Convention for Representing Distortion in FITS Image Headers”, ASP Conf. Ser. 347, 491 (2005).'
  },
  'Compressione HCOMPRESS dei FITS': {
    name: 'FITS HCOMPRESS compression',
    license: 'Citation',
    reference:
      'R. L. White, “High-performance compression of astronomical images”, Proceedings of the NASA Space and Earth Science Data Compression Workshop, 70–79 (1992).',
    note: 'Decompressor written for StarLight; for the bit layout, the reference code distributed with cfitsio (NASA, permissive license) was consulted.'
  },
  'Compressione Zstandard': {
    name: 'Zstandard compression',
    license: 'Citation',
    reference: 'Y. Collet, M. Kucherawy (eds.), “Zstandard Compression and the \'application/zstd\' Media Type”, RFC 8878 (2021).',
    note: 'Decompressor written for StarLight from the specification, used for compressed XISF files.'
  },
  'Funzioni di corrispondenza dei colori CIE 1931, approssimazione analitica': {
    name: 'CIE 1931 color matching functions, analytic approximation',
    license: 'Citation',
    reference:
      'C. Wyman, P.-P. Sloan, P. Shirley, “Simple Analytic Approximations to the CIE XYZ Color Matching Functions”, Journal of Computer Graphics Techniques 2(2), 1–11 (2013).',
    note: 'Used to compute the emission line hues of the monochrome image colorization plugin.'
  },
  Neutralinojs: {
    author: 'Shalitha Suranga and contributors',
    note: 'Version 6.10.0, used only by the installer window; it does not remain in the installed program.'
  }
}

/** The acknowledgements with the English texts, in the same order as `CREDITS`. */
export const CREDITS_EN: Credit[] = CREDITS.map((r) => ({ ...r, ...ENGLISH[r.name] }))

/**
 * The content for `language`, else English, else Italian: the same rule as
 * `byLanguage()` in the i18n module, repeated here because
 * tools/generate-credits.mjs imports this file directly with Node, which
 * cannot resolve the i18n module's imports.
 */
function forLanguage<T>(contents: Partial<Record<string, T>> & { it: T }, language: string): T {
  return contents[language] ?? contents.en ?? contents.it
}

/** Acknowledgements for an interface language (`getLanguage()` from the i18n module). */
export function creditsFor(language: string): Credit[] {
  return forLanguage({ it: CREDITS, en: CREDITS_EN }, language)
}

/** Section titles for an interface language. */
export function categoryTitlesFor(language: string): Record<CreditCategory, string> {
  return forLanguage({ it: CATEGORY_TITLES, en: CATEGORY_TITLES_EN }, language)
}
