// Species definitions: anatomy (normalised to body length L = 1), skin
// colouring, locomotion, AI tuning and attack numbers for every shark type the
// EnemyManager can spawn. Everything that makes a great white feel different
// from a tiger shark or the megalodon lives here so behaviour code stays
// generic.
//
// Anatomy conventions (see SharkAnatomy.js):
//   s      — normalised position along the body, 0 = snout tip, 1 ≈ caudal tip
//   theta  — angle around the body cross-section in degrees, 0 = flank (+x),
//            90 = dorsal midline, -90 = ventral midline
//   profile rows: [s, yTop, yBottom, halfWidth] in units of L

export const SPECIES = {
  greatWhite: {
    type: 'greatWhite',
    name: '大白鲨',
    isBoss: false,
    length: 6.0,
    maxHealth: 380,
    seed: 1337,
    sOrigin: 0.36, // object origin (≈ centre of mass) along s
    profile: [
      [0.000, 0.009, 0.009, 0.000],
      [0.006, 0.018, -0.001, 0.0095],
      [0.015, 0.026, -0.009, 0.018],
      [0.030, 0.038, -0.022, 0.032],
      [0.050, 0.049, -0.034, 0.043],
      [0.080, 0.062, -0.050, 0.056],
      [0.120, 0.076, -0.066, 0.068],
      [0.170, 0.089, -0.080, 0.077],
      [0.230, 0.099, -0.092, 0.083],
      [0.300, 0.106, -0.099, 0.085],
      [0.360, 0.108, -0.100, 0.084],
      [0.420, 0.105, -0.096, 0.079],
      [0.500, 0.095, -0.084, 0.069],
      [0.580, 0.079, -0.067, 0.056],
      [0.660, 0.059, -0.047, 0.042],
      [0.730, 0.041, -0.030, 0.031],
      [0.790, 0.029, -0.019, 0.025],
      [0.840, 0.023, -0.013, 0.021],
      [0.880, 0.019, -0.009, 0.014],
      [0.920, 0.016, -0.004, 0.008],
      [0.955, 0.010, 0.010, 0.000],
    ],
    expTop: 2.1,
    expBottom: 2.5,
    headSquare: 0,
    noseCone: true, // a pointed, crease-free snout tip (SharkAnatomy)
    keel: { s0: 0.74, s1: 0.93, amount: 0.011 },
    spineS: [0.30, 0.38, 0.46, 0.54, 0.62, 0.70, 0.78, 0.855, 0.92],
    headS: 0.17,
    mouth: { sFront: 0.042, sHinge: 0.15, sClose: 0.2, deltaMax: 72, palate: 0.024, floor: 0.02, gum: 0.0105, maxOpen: 0.86, throat: 0.07, throatDrop: 0.03 },
    eye: { s: 0.085, theta: 22, radius: 0.0066 },
    gills: { s0: 0.2, spacing: 0.0168, count: 5, top: 36, bottom: -35, slant: 0.011, depth: 0.0024, width: 0.0034 },
    fins: {
      dorsal1: { s0: 0.335, s1: 0.445, theta: 90, span: 0.105, sweep: 0.056, tipChord: 0.01, falcate: 0.02, leBow: 0.01, thick: 0.011, dir: [0, 1, 0], edgeDark: 0.25 },
      dorsal2: { s0: 0.765, s1: 0.786, theta: 90, span: 0.021, sweep: 0.012, tipChord: 0.003, falcate: 0.003, leBow: 0.002, thick: 0.003, dir: [0, 1, 0] },
      pectoral: { s0: 0.262, s1: 0.335, theta: -26, span: 0.19, sweep: 0.1, tipChord: 0.012, falcate: 0.016, leBow: 0.012, thick: 0.012, dir: [0.92, -0.39, 0], mirror: true, bone: 'pec', paleUnder: true, tipDarkUnder: 0.88, tipDark: 0.25 },
      pelvic: { s0: 0.565, s1: 0.605, theta: -62, span: 0.045, sweep: 0.022, tipChord: 0.006, falcate: 0.006, leBow: 0.004, thick: 0.005, dir: [0.55, -0.83, 0], mirror: true, paleUnder: true },
      anal: { s0: 0.772, s1: 0.792, theta: -90, span: 0.02, sweep: 0.012, tipChord: 0.003, falcate: 0.003, leBow: 0.002, thick: 0.003, dir: [0, -1, 0] },
      caudalUpper: { s0: 0.835, s1: 0.952, theta: 90, span: 0.158, sweep: 0.162, tipChord: 0.006, falcate: 0.05, leBow: 0.012, thick: 0.008, dir: [0, 1, 0], edgeDark: 0.45, tipDark: 0.35 },
      caudalLower: { s0: 0.858, s1: 0.945, theta: -90, span: 0.128, sweep: 0.1, tipChord: 0.006, falcate: 0.025, leBow: 0.01, thick: 0.007, dir: [0, -1, 0], edgeDark: 0.45, tipDark: 0.35 },
    },
    teeth: { perSide: 12, rows: 3, upper: 0.0128, lower: 0.0112, upperWidth: 0.82, lowerWidth: 0.58, shape: 'triangle', serration: 0.045 },
    colors: {
      back: 0x5f666b, backDark: 0x474d52, flank: 0x7b8287, belly: 0xebe9e3,
      boundary: -0.1, boundaryJag: 0.14, boundarySoft: 0.012,
      mottle: 0.1, scars: 12, freshScars: 1, stripes: 0, axillary: true, pores: 1, snoutGrey: 1,
    },
    stats: { cruise: 3.0, circleSpeed: 3.5, approachSpeed: 6.4, burstSpeed: 14.5, accel: 3.6, decel: 2.2, burstAccel: 38, turnRadius: 0.78, minTurnSpeed: 2.2, maxTurnRate: 1.7, maxPitch: 0.5 },
    swim: { baseFreq: 0.42, freqPerSpeed: 0.11, amp: 0.6, wavelength: 1.05 },
    ai: {
      circleRmax: 34, circleRmin: 12, aggressionRate: 0.05, firstCommit: [8, 10.5], decisionInterval: [3, 5.5],
      feintChance: 0.55, initialFeints: 1, feintOffset: [2.0, 3.2], lungeRange: 9, ramRange: 17,
      lungeTime: 0.9, ramTime: 1.5, recoverTime: 1.9, staggerTime: 2.0, ramChance: 0.15,
      depthWander: 4, depthBias: 0, wakeRadius: 0.32, wakeStrength: 0.7, homing: 0.55, tailChance: 0.4,
      // Murk swings between attacks (SharkAI WIDE_*): now and then the lone
      // white fades back into the murk — short, so the pressure holds
      // (enemies-sim gw-cadence: ≥ 4.3 attacks/min idle in wave 0).
      wide: { chance: 0.45, cd: [14, 22], hold: [2.5, 4] },
    },
    attacks: {
      bite: { damage: 20, grabDamage: 25, knockback: 7, radius: 0.16, telegraph: 0.78 },
      ram: { damage: 15, knockback: 12, radius: 0.13, telegraph: 0.68 },
      tail: { damage: 12, knockback: 10, radius: 0.14, telegraph: 0.45 },
    },
  },

  tiger: {
    type: 'tiger',
    name: '虎鲨',
    isBoss: false,
    length: 4.5,
    maxHealth: 220,
    seed: 4242,
    sOrigin: 0.36,
    profile: [
      [0.000, 0.006, 0.006, 0.000],
      [0.006, 0.021, -0.012, 0.027],
      [0.015, 0.03, -0.021, 0.038],
      [0.030, 0.037, -0.028, 0.046],
      [0.050, 0.042, -0.035, 0.050],
      [0.080, 0.053, -0.047, 0.059],
      [0.120, 0.064, -0.060, 0.066],
      [0.170, 0.074, -0.071, 0.071],
      [0.230, 0.082, -0.080, 0.074],
      [0.300, 0.087, -0.084, 0.075],
      [0.360, 0.088, -0.084, 0.073],
      [0.420, 0.085, -0.079, 0.068],
      [0.500, 0.076, -0.068, 0.058],
      [0.580, 0.063, -0.053, 0.046],
      [0.640, 0.050, -0.040, 0.036],
      [0.700, 0.037, -0.027, 0.027],
      [0.750, 0.028, -0.018, 0.020],
      [0.800, 0.022, -0.011, 0.015],
      [0.850, 0.018, -0.005, 0.010],
      [0.900, 0.014, 0.000, 0.006],
      [0.940, 0.008, 0.008, 0.000],
    ],
    expTop: 2.3,
    expBottom: 2.7,
    headSquare: 0.9, // blunt, box-like snout
    noseCap: 0.024,
    keel: { s0: 0.74, s1: 0.9, amount: 0.004 },
    spineS: [0.30, 0.37, 0.44, 0.51, 0.58, 0.65, 0.72, 0.8, 0.88],
    headS: 0.16,
    mouth: { sFront: 0.03, sHinge: 0.115, sClose: 0.16, deltaMax: 80, palate: 0.02, floor: 0.017, gum: 0.0095, maxOpen: 0.82, throat: 0.06, throatDrop: 0.025 },
    eye: { s: 0.068, theta: 26, radius: 0.0078 },
    gills: { s0: 0.168, spacing: 0.0145, count: 5, top: 30, bottom: -40, slant: 0.008, depth: 0.002, width: 0.0028 },
    fins: {
      dorsal1: { s0: 0.30, s1: 0.4, theta: 90, span: 0.088, sweep: 0.048, tipChord: 0.009, falcate: 0.014, leBow: 0.008, thick: 0.009, dir: [0, 1, 0], edgeDark: 0.2 },
      dorsal2: { s0: 0.655, s1: 0.69, theta: 90, span: 0.03, sweep: 0.014, tipChord: 0.004, falcate: 0.004, leBow: 0.002, thick: 0.004, dir: [0, 1, 0] },
      pectoral: { s0: 0.22, s1: 0.295, theta: -30, span: 0.155, sweep: 0.07, tipChord: 0.013, falcate: 0.01, leBow: 0.012, thick: 0.011, dir: [0.93, -0.36, 0], mirror: true, bone: 'pec', paleUnder: true, tipDark: 0.15, tipDarkUnder: 0.2 },
      pelvic: { s0: 0.5, s1: 0.545, theta: -62, span: 0.042, sweep: 0.02, tipChord: 0.006, falcate: 0.005, leBow: 0.004, thick: 0.005, dir: [0.55, -0.83, 0], mirror: true, paleUnder: true },
      anal: { s0: 0.668, s1: 0.7, theta: -90, span: 0.026, sweep: 0.013, tipChord: 0.004, falcate: 0.004, leBow: 0.002, thick: 0.004, dir: [0, -1, 0] },
      caudalUpper: { s0: 0.75, s1: 0.94, theta: 90, span: 0.112, sweep: 0.228, tipChord: 0.012, falcate: 0.035, leBow: 0.006, thick: 0.007, dir: [0, 1, 0], edgeDark: 0.35, tipDark: 0.3 },
      caudalLower: { s0: 0.79, s1: 0.9, theta: -90, span: 0.078, sweep: 0.05, tipChord: 0.008, falcate: 0.015, leBow: 0.006, thick: 0.006, dir: [0, -1, 0], edgeDark: 0.35 },
    },
    teeth: { perSide: 12, rows: 3, upper: 0.0115, lower: 0.0105, upperWidth: 0.95, lowerWidth: 0.9, shape: 'cockscomb', serration: 0.05 },
    colors: {
      back: 0x7b745e, backDark: 0x4e483a, flank: 0x8f8771, belly: 0xe6dfce,
      boundary: -0.2, boundaryJag: 0.05, boundarySoft: 0.11,
      mottle: 0.12, scars: 7, freshScars: 1, stripes: 15, axillary: false, pores: 1.4,
    },
    stats: { cruise: 3.3, circleSpeed: 3.9, approachSpeed: 7.0, burstSpeed: 15.5, accel: 4.6, decel: 2.6, burstAccel: 42, turnRadius: 0.55, minTurnSpeed: 2.0, maxTurnRate: 2.4, maxPitch: 0.55 },
    swim: { baseFreq: 0.58, freqPerSpeed: 0.14, amp: 0.72, wavelength: 0.95 },
    ai: {
      circleRmax: 27, circleRmin: 9, aggressionRate: 0.07, firstCommit: [6, 9], decisionInterval: [4.5, 8],
      feintChance: 0.4, initialFeints: 1, feintOffset: [1.8, 2.8], lungeRange: 7.5, ramRange: 14,
      lungeTime: 0.78, ramTime: 1.3, recoverTime: 1.4, staggerTime: 1.8, ramChance: 0.15,
      depthWander: 3.5, depthBias: -1, wakeRadius: 0.3, wakeStrength: 0.55, homing: 0.75, tailChance: 0.3,
      // The pack keeps the pressure on: a tiger fades out only now and then.
      wide: { chance: 0.5, cd: [16, 24], hold: [3, 4.5] },
    },
    attacks: {
      bite: { damage: 15, grabDamage: 18, knockback: 6, radius: 0.17, telegraph: 0.66 },
      ram: { damage: 12, knockback: 10, radius: 0.13, telegraph: 0.6 },
      tail: { damage: 10, knockback: 9, radius: 0.14, telegraph: 0.4 },
    },
  },

  megalodon: {
    type: 'megalodon',
    name: '巨齿鲨',
    isBoss: true,
    length: 16.0,
    maxHealth: 1400,
    seed: 9001,
    sOrigin: 0.36,
    // Not a scaled-up great white: a deeper, broader trunk (s 0.12–0.5
    // +10 %) reads as mass. The snout stays a shark's — conical, about the
    // white's in proportion — with the bulk swelling in behind the eyes
    // (s 0.05 → 0.08): the old blunt, broad snout and round forehead read
    // as an orca / beluga head-on and at 3/4 (the boss's close-ups). The
    // rostrum rows (s ≤ 0.015) are slim and noseCone ends them in a point:
    // fatter rows under the elliptical cap made a bulb nose with a crease.
    profile: [
      [0.000, 0.008, 0.008, 0.000],
      [0.006, 0.012, -0.001, 0.008],
      [0.015, 0.022, -0.008, 0.016],
      [0.030, 0.041, -0.026, 0.035],
      [0.050, 0.055, -0.041, 0.049],
      [0.080, 0.0734, -0.0614, 0.0706],
      [0.120, 0.0935, -0.0825, 0.088],
      [0.170, 0.1089, -0.0990, 0.099],
      [0.230, 0.1210, -0.1133, 0.1067],
      [0.300, 0.1298, -0.1221, 0.110],
      [0.360, 0.1320, -0.1243, 0.1089],
      [0.420, 0.1287, -0.1188, 0.1034],
      [0.500, 0.1166, -0.1045, 0.0902],
      [0.580, 0.0924, -0.0798, 0.0704],
      [0.660, 0.066, -0.053, 0.05],
      [0.730, 0.046, -0.034, 0.036],
      [0.790, 0.032, -0.021, 0.029],
      [0.840, 0.025, -0.014, 0.025],
      [0.880, 0.020, -0.009, 0.017],
      [0.920, 0.016, -0.004, 0.009],
      [0.955, 0.01, 0.01, 0.000],
    ],
    expTop: 2.1,
    expBottom: 2.45,
    headSquare: 0.05, // (0.25 squared the snout's cross-section into a blunt melon)
    noseCone: true, // a pointed, crease-free rostrum (SharkAnatomy)
    keel: { s0: 0.74, s1: 0.93, amount: 0.013 },
    spineS: [0.30, 0.38, 0.46, 0.54, 0.62, 0.70, 0.78, 0.855, 0.92],
    headS: 0.18,
    mouth: { sFront: 0.04, sHinge: 0.165, sClose: 0.22, deltaMax: 76, palate: 0.027, floor: 0.022, gum: 0.0125, maxOpen: 1.05, throat: 0.08, throatDrop: 0.035 },
    eye: { s: 0.09, theta: 20, radius: 0.0052 },
    gills: { s0: 0.215, spacing: 0.018, count: 5, top: 40, bottom: -30, slant: 0.012, depth: 0.0024, width: 0.0034 },
    fins: {
      dorsal1: { s0: 0.335, s1: 0.45, theta: 90, span: 0.112, sweep: 0.06, tipChord: 0.011, falcate: 0.022, leBow: 0.011, thick: 0.012, dir: [0, 1, 0], edgeDark: 0.3 },
      dorsal2: { s0: 0.765, s1: 0.786, theta: 90, span: 0.022, sweep: 0.012, tipChord: 0.003, falcate: 0.003, leBow: 0.002, thick: 0.003, dir: [0, 1, 0] },
      // Sickle-shaped: a narrow tip, a deeply concave trailing edge and a
      // tip curling down (edge-on it reads as a blade, not a plank).
      pectoral: { s0: 0.27, s1: 0.345, theta: -26, span: 0.23, sweep: 0.105, tipChord: 0.006, falcate: 0.03, leBow: 0.012, thick: 0.009, curl: 0.2, dir: [0.92, -0.39, 0], mirror: true, bone: 'pec', paleUnder: true, tipDark: 0.3, tipDarkUnder: 0.6 },
      pelvic: { s0: 0.565, s1: 0.605, theta: -62, span: 0.048, sweep: 0.024, tipChord: 0.006, falcate: 0.006, leBow: 0.004, thick: 0.005, dir: [0.55, -0.83, 0], mirror: true, paleUnder: true },
      anal: { s0: 0.772, s1: 0.792, theta: -90, span: 0.021, sweep: 0.012, tipChord: 0.003, falcate: 0.003, leBow: 0.002, thick: 0.003, dir: [0, -1, 0] },
      caudalUpper: { s0: 0.835, s1: 0.952, theta: 90, span: 0.17, sweep: 0.158, tipChord: 0.007, falcate: 0.05, leBow: 0.012, thick: 0.009, dir: [0, 1, 0], edgeDark: 0.5, tipDark: 0.4 },
      caudalLower: { s0: 0.855, s1: 0.945, theta: -90, span: 0.14, sweep: 0.105, tipChord: 0.007, falcate: 0.028, leBow: 0.01, thick: 0.008, dir: [0, -1, 0], edgeDark: 0.5, tipDark: 0.4 },
    },
    teeth: { perSide: 13, rows: 3, upper: 0.0135, lower: 0.012, upperWidth: 0.9, lowerWidth: 0.7, shape: 'triangle', serration: 0.03 },
    colors: {
      back: 0x464a4d, backDark: 0x2f3235, flank: 0x5e6366, belly: 0xd3cfc5,
      boundary: -0.12, boundaryJag: 0.16, boundarySoft: 0.02,
      // Scar sizes are absolute (metres, see SharkTextures), so 80 on a 16 m
      // body reads as far more battle damage per length than 12 on the 6 m white.
      mottle: 0.16, scars: 80, freshScars: 4, stripes: 0, axillary: true, pores: 0.8, snoutGrey: 1,
      // Matte, hide-like head: roughness + on the dorsal head (painted) and
      // the clearcoat × headCoat ahead of the gills (shader; high quality).
      headMatte: 0.2, headCoat: 0.3,
    },
    stats: { cruise: 3.6, circleSpeed: 4.8, approachSpeed: 7.6, burstSpeed: 16.5, accel: 2.6, decel: 1.4, burstAccel: 26, turnRadius: 1.0, minTurnSpeed: 2.6, maxTurnRate: 0.9, maxPitch: 0.42 },
    swim: { baseFreq: 0.26, freqPerSpeed: 0.06, amp: 0.55, wavelength: 1.1 },
    ai: {
      // Pressure: a tighter orbit, faster decisions, fewer feints; it cruises
      // 3.5–8.5 m above 老公 (depthBias / depthWander) so it hangs between him
      // and the light and its passes cross the sun. One pass (the reveal)
      // before its first bite.
      circleRmax: 26, circleRmin: 12, aggressionRate: 0.08, firstCommit: [4, 5.5], decisionInterval: [2.5, 4.5],
      feintChance: 0.35, initialFeints: 1, feintOffset: [4.5, 6.5], lungeRange: 15, ramRange: 19, shockRange: 13,
      lungeTime: 1.25, ramTime: 2.0, recoverTime: 2.2, staggerTime: 2.4, ramChance: 0.2,
      depthWander: 2.5, depthBias: 6, wakeRadius: 0.75, wakeStrength: 3.0, homing: 0.32, tailChance: 0.55,
    },
    attacks: {
      bite: { damage: 30, grabDamage: 30, knockback: 10, radius: 0.15, telegraph: 0.9 },
      ram: { damage: 24, knockback: 16, radius: 0.11, telegraph: 0.85 },
      tail: { damage: 20, knockback: 14, radius: 0.12, telegraph: 0.6 },
      shockwave: { damage: 22, knockback: 18, maxRadius: 17, telegraph: 1.05 },
    },
  },
};

export function getSpecies(type) {
  return SPECIES[type] ?? SPECIES.greatWhite;
}
