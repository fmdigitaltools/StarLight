import type { CelestialObject, ObjectType } from '@shared/types'
import { CONSTELLATIONS } from './openNgcData'
import { OBJECT_TEXTS_IT } from './objects.it'

/**
 * Catalog of the deep-sky objects that can be framed with a small
 * telescope: the most imaged Messier, NGC and IC objects, with carefully
 * written names and descriptions. Names and descriptions live in the
 * per-language data files objects.it.ts and objects.en.ts, keyed by object
 * ID; the objects built here carry the reference (Italian) texts, and
 * catalog.ts switches them to the current language. The other objects take
 * their Italian names and descriptions from
 * resources/catalog/translations-it.mjs, through the generated catalog.
 *
 * Coordinates are in decimal degrees, epoch J2000.
 */

/** Name and description of an object in one language. */
export interface ObjectText {
  name: string
  description: string
}

/** IAU constellation abbreviation of each curated object, to show the constellation in the current language. */
export const CURATED_CONSTELLATION_CODES = new Map<string, string>()

/** Compact constructor of a catalog entry; `constellation` is the IAU abbreviation. */
function o(
  id: string,
  aliases: string[],
  type: ObjectType,
  ra: number,
  dec: number,
  magnitude: number | null,
  sizeArcmin: number | null,
  constellation: string
): CelestialObject {
  CURATED_CONSTELLATION_CODES.set(id, constellation)
  const text = OBJECT_TEXTS_IT[id]
  return {
    id,
    name: text?.name ?? id,
    aliases,
    type,
    ra,
    dec,
    magnitude,
    sizeArcmin,
    constellation: CONSTELLATIONS[constellation] ?? '',
    description: text?.description ?? ''
  }
}

const NEBULAE: CelestialObject[] = [
  // Diffuse nebulae
  o('M 42', ['NGC 1976', 'Great Orion Nebula'], 'nebula', 83.822, -5.391, 4.0, 85, 'Ori'),
  o('M 43', ['NGC 1982'], 'nebula', 83.88, -5.27, 9.0, 20, 'Ori'),
  o('M 78', ['NGC 2068'], 'nebula', 86.691, 0.079, 8.3, 8, 'Ori'),
  o('M 8', ['NGC 6523'], 'nebula', 270.904, -24.387, 6.0, 90, 'Sgr'),
  o('M 16', ['NGC 6611', 'Eagle Nebula'], 'nebula', 274.7, -13.807, 6.0, 35, 'Ser'),
  o('M 17', ['NGC 6618', 'Swan Nebula'], 'nebula', 275.196, -16.177, 6.0, 46, 'Sgr'),
  o('M 20', ['NGC 6514'], 'nebula', 270.675, -22.972, 6.3, 28, 'Sgr'),
  o('NGC 7000', ['Caldwell 20', 'North America Nebula'], 'nebula', 314.75, 44.367, 4.0, 120, 'Cyg'),
  o('IC 5070', ['Pelican Nebula'], 'nebula', 313.75, 44.36, 8.0, 60, 'Cyg'),
  o('NGC 2237', ['Caldwell 49', 'Rosette Nebula'], 'nebula', 97.98, 5.03, 9.0, 80, 'Mon'),
  o('IC 434', ['Barnard 33', 'Horsehead'], 'dark-nebula', 85.24, -2.46, null, 8, 'Ori'),
  o('NGC 1499', ['Sh2-220'], 'nebula', 60.0, 36.42, 6.0, 145, 'Per'),
  o('NGC 7635', ['Caldwell 11', 'Bubble Nebula'], 'nebula', 350.2, 61.2, 10.0, 15, 'Cas'),
  o('NGC 6888', ['Caldwell 27', 'Crescent Nebula'], 'nebula', 303.05, 38.35, 7.4, 20, 'Cyg'),
  o('NGC 281', ['IC 11'], 'nebula', 13.18, 56.62, 7.4, 35, 'Cas'),
  o('NGC 2264', ['Christmas Tree Cluster'], 'nebula', 100.25, 9.88, 3.9, 60, 'Mon'),
  o('IC 1396', ['Elephant Trunk'], 'nebula', 324.74, 57.5, 3.5, 170, 'Cep'),
  o('NGC 7380', ['Sh2-142', 'Wizard Nebula'], 'nebula', 341.98, 58.12, 7.2, 25, 'Cep'),
  o('NGC 6960', ['Caldwell 34', 'Veil Nebula'], 'supernova-remnant', 311.65, 30.72, 7.0, 70, 'Cyg'),
  o('NGC 6992', ['Caldwell 33'], 'supernova-remnant', 313.3, 31.72, 7.0, 60, 'Cyg'),
  o('M 1', ['NGC 1952', 'Crab Nebula'], 'supernova-remnant', 83.633, 22.015, 8.4, 7, 'Tau'),
  o('IC 443', ['Sh2-248'], 'supernova-remnant', 94.25, 22.57, 12.0, 50, 'Gem'),
  o('NGC 3372', ['Caldwell 92', 'Eta Carinae Nebula'], 'nebula', 161.26, -59.87, 1.0, 120, 'Car')
]

const PLANETARY_NEBULAE: CelestialObject[] = [
  o('M 27', ['NGC 6853', 'Dumbbell'], 'planetary-nebula', 299.902, 22.721, 7.4, 8, 'Vul'),
  o('M 57', ['NGC 6720', 'Ring Nebula'], 'planetary-nebula', 283.396, 33.029, 8.8, 3.8, 'Lyr'),
  o('M 76', ['NGC 650'], 'planetary-nebula', 25.58, 51.575, 10.1, 3, 'Per'),
  o('M 97', ['NGC 3587', 'Owl Nebula'], 'planetary-nebula', 168.699, 55.019, 9.9, 3.4, 'UMa'),
  o('NGC 7293', ['Caldwell 63', 'Helix Nebula'], 'planetary-nebula', 337.411, -20.837, 7.3, 25, 'Aqr'),
  o('NGC 6543', ['Caldwell 6'], 'planetary-nebula', 269.64, 66.63, 8.1, 5.8, 'Dra'),
  o('NGC 2392', ['Caldwell 39'], 'planetary-nebula', 112.3, 20.91, 9.1, 0.8, 'Gem')
]

const GALAXIES: CelestialObject[] = [
  o('M 31', ['NGC 224'], 'galaxy', 10.685, 41.269, 3.4, 190, 'And'),
  o('M 32', ['NGC 221'], 'galaxy', 10.674, 40.865, 8.1, 8, 'And'),
  o('M 110', ['NGC 205'], 'galaxy', 10.092, 41.685, 8.5, 20, 'And'),
  o('M 33', ['NGC 598'], 'galaxy', 23.462, 30.66, 5.7, 70, 'Tri'),
  o('M 51', ['NGC 5194', 'Whirlpool'], 'galaxy', 202.47, 47.195, 8.4, 11, 'CVn'),
  o('M 63', ['NGC 5055'], 'galaxy', 198.955, 42.029, 8.6, 12, 'CVn'),
  o('M 64', ['NGC 4826'], 'galaxy', 194.182, 21.683, 8.5, 10, 'Com'),
  o('M 65', ['NGC 3623'], 'galaxy', 169.733, 13.092, 9.3, 10, 'Leo'),
  o('M 66', ['NGC 3627'], 'galaxy', 170.062, 12.991, 8.9, 9, 'Leo'),
  o('M 81', ['NGC 3031'], 'galaxy', 148.888, 69.065, 6.9, 27, 'UMa'),
  o('M 82', ['NGC 3034', 'Cigar Galaxy'], 'galaxy', 148.968, 69.68, 8.4, 11, 'UMa'),
  o('M 101', ['NGC 5457', 'Pinwheel'], 'galaxy', 210.802, 54.349, 7.9, 29, 'UMa'),
  o('M 104', ['NGC 4594'], 'galaxy', 189.998, -11.623, 8.0, 9, 'Vir'),
  o('M 106', ['NGC 4258'], 'galaxy', 184.74, 47.304, 8.4, 19, 'CVn'),
  o('M 108', ['NGC 3556'], 'galaxy', 167.879, 55.674, 10.0, 8, 'UMa'),
  o('M 109', ['NGC 3992'], 'galaxy', 179.4, 53.375, 9.8, 8, 'UMa')
]

const GALAXIES_2: CelestialObject[] = [
  o('M 74', ['NGC 628'], 'galaxy', 24.174, 15.784, 9.4, 10, 'Psc'),
  o('M 77', ['NGC 1068'], 'galaxy', 40.67, -0.013, 8.9, 7, 'Cet'),
  o('M 83', ['NGC 5236'], 'galaxy', 204.25, -29.867, 7.5, 13, 'Hya'),
  o('M 87', ['NGC 4486', 'Virgo A'], 'galaxy', 187.706, 12.391, 8.6, 8, 'Vir'),
  o('M 94', ['NGC 4736'], 'galaxy', 192.721, 41.12, 8.2, 11, 'CVn'),
  o('M 95', ['NGC 3351'], 'galaxy', 160.99, 11.704, 9.7, 7, 'Leo'),
  o('M 96', ['NGC 3368'], 'galaxy', 161.691, 11.82, 9.2, 7, 'Leo'),
  o('M 100', ['NGC 4321'], 'galaxy', 185.729, 15.822, 9.3, 7, 'Com'),
  o('NGC 253', ['Caldwell 65'], 'galaxy', 11.888, -25.288, 7.1, 27, 'Scl'),
  o('NGC 4565', ['Caldwell 38', 'Needle Galaxy'], 'galaxy', 189.086, 25.988, 9.6, 16, 'Com'),
  o('NGC 5907', [], 'galaxy', 229.0, 56.33, 10.3, 13, 'Dra'),
  o('NGC 6946', ['Caldwell 12'], 'galaxy', 308.718, 60.154, 8.8, 11, 'Cep'),
  o('NGC 7331', ['Caldwell 30'], 'galaxy', 339.267, 34.416, 9.5, 10, 'Peg'),
  o('NGC 891', ['Caldwell 23'], 'galaxy', 35.639, 42.349, 10.0, 13, 'And'),
  o('NGC 3628', [], 'galaxy', 170.071, 13.59, 9.5, 15, 'Leo')
]

const CLUSTERS: CelestialObject[] = [
  o('M 45', ['Sette Sorelle', 'Melotte 22'], 'open-cluster', 56.75, 24.117, 1.6, 110, 'Tau'),
  o('M 44', ['NGC 2632', 'Beehive'], 'open-cluster', 130.1, 19.667, 3.1, 95, 'Cnc'),
  o('M 13', ['NGC 6205'], 'globular-cluster', 250.423, 36.461, 5.8, 20, 'Her'),
  o('M 3', ['NGC 5272'], 'globular-cluster', 205.548, 28.377, 6.2, 18, 'CVn'),
  o('M 5', ['NGC 5904'], 'globular-cluster', 229.638, 2.081, 5.6, 23, 'Ser'),
  o('M 15', ['NGC 7078'], 'globular-cluster', 322.493, 12.167, 6.2, 18, 'Peg'),
  o('M 22', ['NGC 6656'], 'globular-cluster', 279.1, -23.904, 5.1, 32, 'Sgr'),
  o('M 92', ['NGC 6341'], 'globular-cluster', 259.281, 43.136, 6.4, 14, 'Her'),
  o('M 11', ['NGC 6705'], 'open-cluster', 282.766, -6.27, 6.3, 14, 'Sct'),
  o('M 35', ['NGC 2168'], 'open-cluster', 92.27, 24.33, 5.3, 28, 'Gem'),
  o('M 36', ['NGC 1960'], 'open-cluster', 84.08, 34.14, 6.3, 12, 'Aur'),
  o('M 37', ['NGC 2099'], 'open-cluster', 88.07, 32.55, 6.2, 24, 'Aur'),
  o('M 38', ['NGC 1912'], 'open-cluster', 82.17, 35.85, 7.4, 21, 'Aur'),
  o('M 39', ['NGC 7092'], 'open-cluster', 322.9, 48.43, 4.6, 32, 'Cyg'),
  o('M 52', ['NGC 7654'], 'open-cluster', 351.2, 61.593, 7.3, 13, 'Cas'),
  o('M 103', ['NGC 581'], 'open-cluster', 23.35, 60.658, 7.4, 6, 'Cas'),
  o('M 34', ['NGC 1039'], 'open-cluster', 40.52, 42.72, 5.5, 35, 'Per'),
  o('NGC 869', ['h Persei', 'Caldwell 14'], 'open-cluster', 34.75, 57.133, 5.3, 30, 'Per'),
  o('NGC 884', ['chi Persei'], 'open-cluster', 35.58, 57.133, 6.1, 30, 'Per'),
  o('NGC 7789', [], 'open-cluster', 359.33, 56.71, 6.7, 16, 'Cas')
]

/**
 * Shape of the curated galaxies: minor axis in arcminutes and position
 * angle in degrees (from north through east), to draw the marker as an
 * ellipse oriented along the galaxy.
 *
 * The angles are those of OpenNGC. The minor axis is OpenNGC's, rescaled
 * to the major axis written above (which is sometimes rounded or taken from
 * another source), so the ratio between the two axes, i.e. how flattened
 * the galaxy is, stays that of the catalog. Objects not listed here
 * (nebulae, clusters, planetary nebulae) have no position angle in OpenNGC
 * and remain circles.
 */
const SHAPES: Record<string, [number, number]> = {
  'M 31': [74.4, 35],
  'M 32': [5, 170],
  'M 110': [11.8, 170],
  'M 33': [41.4, 23],
  'M 51': [9.4, 163],
  'M 63': [7.3, 103],
  'M 64': [5.1, 114],
  'M 65': [2.6, 173],
  'M 66': [4, 168],
  'M 81': [14, 157],
  'M 82': [5.1, 66],
  'M 101': [27.9, 28],
  'M 104': [5.2, 90],
  'M 106': [8.1, 150],
  'M 108': [3.3, 79],
  'M 109': [5.6, 78],
  'M 74': [9.4, 87],
  'M 77': [6.4, 12],
  'M 83': [12.6, 45],
  'M 87': [7.5, 153],
  'M 94': [9.5, 105],
  'M 95': [4.3, 11],
  'M 96': [4.7, 5],
  'M 100': [6.4, 108],
  'NGC 253': [4.6, 53],
  'NGC 4565': [2.8, 135],
  'NGC 5907': [2, 156],
  'NGC 6946': [10.5, 52],
  'NGC 7331': [4.1, 170],
  'NGC 891': [3, 22],
  'NGC 3628': [4.7, 104],
}

/**
 * Hand-curated objects. They are the quality override on top of the
 * OpenNGC catalog (see catalog.ts).
 */
export const CURATED: CelestialObject[] = [
  ...NEBULAE,
  ...PLANETARY_NEBULAE,
  ...GALAXIES,
  ...GALAXIES_2,
  ...CLUSTERS
].map((c) => (c.id in SHAPES ? { ...c, minorArcmin: SHAPES[c.id][0], positionAngle: SHAPES[c.id][1] } : c))

