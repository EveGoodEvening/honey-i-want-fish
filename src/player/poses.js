// Procedural pose library for 老公.
//
// A Pose describes the body with a handful of intuitive controls rather than
// raw joint angles, so poses blend well (positions lerp linearly):
//   - spine / chest / neck / head: Euler (x = flex forward, y = twist toward
//     the left, z = side bend toward the right), radians, 'YXZ'
//   - handR / handL: WRIST targets in the CHEST frame (m), solved with 2-bone IK
//   - poleR / poleL: direction the elbow points (chest frame)
//   - knifeDir / knifeEdge: right-hand orientation = where the blade points and
//     which way its edge faces (chest frame)
//   - fingersL / palmL / curlL: left-hand orientation and finger curl
//   - footR / footL: ANKLE targets in the PELVIS frame, kneeR/L poles,
//     flex (toe point, + = plantar), out (turn-out)
//   - rootPos / rootRot: pelvis offset / rotation in the model frame
// Body frame: +Y head, +Z chest, +X character's left. When prone, "forward"
// (travel) is +Y and "down" (seabed) is +Z.
import * as THREE from 'three';
import { TAU, sampleVec3, sampleScalar, sampleLoopVec3, sampleLoopScalar, smoothstep, saturate, noise1, easeOutCubic } from './math.js';

const V = THREE.Vector3;

const UPPER_V = ['spine', 'chest', 'neck', 'head', 'handR', 'poleR', 'knifeDir', 'knifeEdge', 'handL', 'poleL', 'fingersL', 'palmL'];
const UPPER_S = ['curlL'];
const LOWER_V = ['rootPos', 'rootRot', 'footR', 'kneeR', 'footL', 'kneeL'];
const LOWER_S = ['flexR', 'outR', 'flexL', 'outL'];

export class Pose {
  constructor() {
    for (const k of UPPER_V) this[k] = new V();
    for (const k of LOWER_V) this[k] = new V();
    for (const k of UPPER_S) this[k] = 0;
    for (const k of LOWER_S) this[k] = 0;
  }

  copy(p) {
    for (let i = 0; i < UPPER_V.length; i++) this[UPPER_V[i]].copy(p[UPPER_V[i]]);
    for (let i = 0; i < LOWER_V.length; i++) this[LOWER_V[i]].copy(p[LOWER_V[i]]);
    for (let i = 0; i < UPPER_S.length; i++) this[UPPER_S[i]] = p[UPPER_S[i]];
    for (let i = 0; i < LOWER_S.length; i++) this[LOWER_S[i]] = p[LOWER_S[i]];
    return this;
  }

  lerpUpper(p, t) {
    if (t <= 0) return this;
    for (let i = 0; i < UPPER_V.length; i++) this[UPPER_V[i]].lerp(p[UPPER_V[i]], t);
    for (let i = 0; i < UPPER_S.length; i++) {
      const k = UPPER_S[i];
      this[k] += (p[k] - this[k]) * t;
    }
    return this;
  }

  lerpLower(p, t) {
    if (t <= 0) return this;
    for (let i = 0; i < LOWER_V.length; i++) this[LOWER_V[i]].lerp(p[LOWER_V[i]], t);
    for (let i = 0; i < LOWER_S.length; i++) {
      const k = LOWER_S[i];
      this[k] += (p[k] - this[k]) * t;
    }
    return this;
  }

  lerp(p, t) {
    return this.lerpUpper(p, t).lerpLower(p, t);
  }
}

// ---------------------------------------------------------------------------
// Neutral upright pose + a ready guard
// ---------------------------------------------------------------------------
export const NEUTRAL = new Pose();
{
  const p = NEUTRAL;
  p.spine.set(0.04, 0, 0);
  p.chest.set(0.03, 0, 0);
  p.neck.set(-0.02, 0, 0);
  p.handR.set(-0.25, -0.16, 0.24);
  p.poleR.set(-0.45, -1, -0.4);
  p.knifeDir.set(-0.15, 0.05, 1);
  p.knifeEdge.set(0, -1, 0);
  p.handL.set(0.25, -0.16, 0.24);
  p.poleL.set(0.45, -1, -0.4);
  p.fingersL.set(0.25, -0.15, 1);
  p.palmL.set(0, -1, 0.1);
  p.curlL = 0.3;
  p.footR.set(-0.12, -0.74, 0.12);
  p.kneeR.set(-0.15, 0, 1);
  p.footL.set(0.12, -0.74, 0.12);
  p.kneeL.set(0.15, 0, 1);
  p.flexR = p.flexL = 0.5;
  p.outR = p.outL = 0.15;
}

const GUARD_HAND_R = new V(-0.21, 0.0, 0.3);
const GUARD_KNIFE = new V(-0.08, 0.28, 1);
const GUARD_EDGE = new V(0, -1, 0.25);
const GUARD_POLE_R = new V(-0.6, -1, -0.3);
const GUARD_HAND_L = new V(0.19, -0.02, 0.32);
const GUARD_FINGERS_L = new V(-0.15, 0.45, 1);
const GUARD_PALM_L = new V(-0.35, 0.1, 1);

/** Blends arms/chest toward a fighting guard by `g` (0..1). */
export function applyGuard(out, g) {
  if (g <= 0) return;
  out.handR.lerp(GUARD_HAND_R, g);
  out.knifeDir.lerp(GUARD_KNIFE, g);
  out.knifeEdge.lerp(GUARD_EDGE, g);
  out.poleR.lerp(GUARD_POLE_R, g);
  out.handL.lerp(GUARD_HAND_L, g);
  out.fingersL.lerp(GUARD_FINGERS_L, g);
  out.palmL.lerp(GUARD_PALM_L, g);
  out.curlL += (0.4 - out.curlL) * g;
  out.spine.x += 0.06 * g;
  out.chest.x += 0.05 * g;
  out.neck.x -= 0.05 * g;
  out.head.x -= 0.04 * g;
}

// ---------------------------------------------------------------------------
// Locomotion
// ---------------------------------------------------------------------------

/** Upright treading water: sculling hands + eggbeater legs. phase 0..1. */
export function poseTread(out, phase, effort) {
  out.copy(NEUTRAL);
  const p = phase * TAU;
  const s = Math.sin(p);
  const c = Math.cos(p);
  const amp = 1 + effort * 0.6;
  // sculling: forearms forward at waist height, hands sweeping out and in,
  // palms pitching with the sweep; elbows hang down and slightly back
  const sweep = 0.05 * s * amp;
  out.handR.set(-0.25 - sweep, -0.17 + 0.012 * Math.sin(2 * p), 0.25 + 0.035 * c);
  out.handL.set(0.25 + sweep, -0.17 + 0.012 * Math.sin(2 * p), 0.25 + 0.035 * c);
  out.palmL.set(0.5 * c, -1, 0.15);
  out.fingersL.set(0.3, -0.05, 1);
  out.knifeDir.set(-0.22 - 0.18 * c, 0.02, 1);
  out.knifeEdge.set(-0.3 * c, -1, 0);
  out.poleR.set(-0.45, -1, -0.4);
  out.poleL.set(0.45, -1, -0.4);
  // eggbeater-ish: lower legs circle in opposite directions, knees forward
  const ra = 0.045 * amp;
  out.footR.set(-0.12 + ra * c, -0.7 + 0.03 * s, 0.1 + ra * s);
  out.footL.set(0.12 + ra * Math.cos(p + Math.PI), -0.7 - 0.03 * s, 0.1 + ra * Math.sin(p + Math.PI));
  out.kneeR.set(-0.18, 0.1, 1);
  out.kneeL.set(0.18, 0.1, 1);
  out.flexR = 0.35 + 0.3 * Math.sin(p + 1);
  out.flexL = 0.35 + 0.3 * Math.sin(p + 1 + Math.PI);
  out.outR = out.outL = 0.25;
  out.spine.x = 0.06;
  out.chest.x = 0.03;
  out.rootPos.y = 0.008 * Math.sin(2 * p);
}

// Breaststroke (prone). Keys: [phase, x, y, z]; L mirrors x.
const BR_HAND = [
  [0.0, -0.1, 0.6, 0.1],
  [0.1, -0.25, 0.56, 0.14],
  [0.22, -0.31, 0.42, 0.22],
  [0.32, -0.18, 0.22, 0.3],
  [0.4, -0.07, 0.24, 0.26],
  [0.52, -0.08, 0.5, 0.15],
  [0.66, -0.1, 0.6, 0.1],
  [0.84, -0.1, 0.61, 0.1],
];
const BR_KNIFE = [
  [0.0, 0.5, 0.8, 0.25],
  [0.22, 0.25, 0.4, 0.88],
  [0.32, 0.4, 0.1, 0.9],
  [0.45, 0.4, 0.75, 0.4],
  [0.66, 0.5, 0.8, 0.25],
];
const BR_PALM_L = [
  [0.0, 0, 0, 1],
  [0.1, 0.65, 0, 0.75],
  [0.22, 0.4, -0.55, 0.7],
  [0.32, -0.5, -0.6, 0.6],
  [0.42, -0.4, 0.2, 0.9],
  [0.6, -0.1, 0, 1],
];
const BR_FING_L = [
  [0.0, 0, 1, 0.05],
  [0.12, 0.35, 0.85, 0.3],
  [0.25, 0.25, 0.4, 0.9],
  [0.36, -0.3, 0.5, 0.8],
  [0.48, 0, 1, 0.3],
];
const BR_FOOT = [
  [0.0, -0.065, -0.86, 0.03],
  [0.38, -0.065, -0.86, 0.03],
  [0.48, -0.12, -0.62, -0.18],
  [0.56, -0.16, -0.5, -0.24],
  [0.63, -0.27, -0.64, -0.1],
  [0.7, -0.2, -0.8, 0.02],
  [0.77, -0.07, -0.86, 0.04],
];
const BR_FLEX = [
  [0.0, 1.0],
  [0.4, 0.9],
  [0.5, -0.2],
  [0.6, -0.3],
  [0.7, 0.4],
  [0.78, 1.0],
];
const BR_OUT = [
  [0.0, 0.0],
  [0.45, 0.25],
  [0.55, 0.75],
  [0.66, 0.6],
  [0.76, 0.1],
];
const _t = new V();

export function poseBreast(out, phase) {
  out.copy(NEUTRAL);
  sampleLoopVec3(BR_HAND, phase, out.handR);
  out.handL.copy(out.handR);
  out.handL.x *= -1;
  sampleLoopVec3(BR_KNIFE, phase, out.knifeDir);
  out.knifeEdge.set(0, 0.2, 1);
  sampleLoopVec3(BR_PALM_L, phase, out.palmL);
  sampleLoopVec3(BR_FING_L, phase, out.fingersL);
  out.curlL = 0.08;
  out.poleR.set(-0.8, 0.3, -0.5);
  out.poleL.set(0.8, 0.3, -0.5);
  sampleLoopVec3(BR_FOOT, phase, out.footR);
  out.footL.copy(out.footR);
  out.footL.x *= -1;
  out.kneeR.set(-0.35, 0, 1);
  out.kneeL.set(0.35, 0, 1);
  out.flexR = out.flexL = sampleLoopScalar(BR_FLEX, phase);
  out.outR = out.outL = sampleLoopScalar(BR_OUT, phase);
  // arch during the pull, streamline in the glide
  const arch = Math.exp(-(((phase - 0.3) / 0.09) ** 2));
  out.spine.x = -0.06 * arch;
  out.chest.x = -0.12 * arch;
  out.neck.x = -0.3 - 0.15 * arch;
  out.head.x = -0.22 - 0.12 * arch;
  const kick = Math.exp(-(((phase - 0.55) / 0.08) ** 2));
  out.rootPos.z = 0.02 * kick;
  out.rootRot.x = 0.12 * kick;
}

/** Sprint: streamlined arms forward, fast flutter kick. phase 0..1. */
export function poseFlutter(out, phase) {
  out.copy(NEUTRAL);
  const p = phase * TAU;
  const s = Math.sin(p);
  out.handR.set(-0.05, 0.62, 0.08);
  out.handL.set(0.04, 0.62, 0.1);
  out.knifeDir.set(0.55, 0.5, 0.65);
  out.knifeEdge.set(0, 0.2, 1);
  out.poleR.set(-1, 0.2, -0.3);
  out.poleL.set(1, 0.2, -0.3);
  out.fingersL.set(-0.1, 1, 0.05);
  out.palmL.set(0, 0, 1);
  out.curlL = 0.05;
  out.footR.set(-0.075, -0.84 + 0.02 * Math.abs(s), 0.13 * s);
  out.footL.set(0.075, -0.84 + 0.02 * Math.abs(s), -0.13 * s);
  out.kneeR.set(-0.1, 0, 1);
  out.kneeL.set(0.1, 0, 1);
  out.flexR = 1.1 - 0.2 * s;
  out.flexL = 1.1 + 0.2 * s;
  out.outR = out.outL = 0.1;
  out.spine.x = 0.04 * Math.sin(2 * p);
  out.chest.x = -0.03 * Math.sin(2 * p);
  out.neck.x = -0.35;
  out.head.x = -0.2;
  out.rootRot.y = 0.05 * s;
}

// ---------------------------------------------------------------------------
// Light combo. Timeline τ: [0,1) windup, [1,2) active, [2,3] recovery.
// ---------------------------------------------------------------------------
const G0 = [-0.24, 0.0, 0.28];
const K0 = [-0.1, 0.2, 1];
const E0 = [0, -1, 0.1];
const P0 = [-0.7, -0.7, -0.4];
const L0 = [0.22, 0.0, 0.28];

const COMBO = [
  {
    // 1: forehand slash, right → left, palm up
    hand: [[0, ...G0], [1, -0.52, 0.16, -0.04], [1.33, -0.34, 0.13, 0.36], [1.66, 0.0, 0.08, 0.48], [2, 0.3, 0.03, 0.27], [2.5, 0.12, -0.02, 0.28], [3, ...G0]],
    knife: [[0, ...K0], [1, -0.9, 0.12, -0.25], [1.33, -0.5, 0.05, 0.86], [1.66, 0.45, -0.05, 0.9], [2, 0.95, -0.1, 0.1], [2.5, 0.4, 0.05, 0.9], [3, ...K0]],
    edge: [[0, ...E0], [1, 0, 0, 1], [1.33, 0.9, 0, 0.45], [1.66, 0.9, 0, -0.45], [2, 0.1, 0, -1], [2.5, 0, -1, 0], [3, ...E0]],
    pole: [[0, ...P0], [1, -0.4, 0.7, -0.6], [1.5, -0.6, 0.6, -0.2], [2, 0.1, -0.2, -1], [3, ...P0]],
    handL: [[0, ...L0], [1, 0.24, 0.06, 0.32], [1.5, 0.26, 0.0, 0.1], [2, 0.3, -0.05, -0.08], [3, ...L0]],
    chestTwist: [[0, 0], [1, -0.38], [1.5, 0.05], [2, 0.42], [3, 0]],
    spineTwist: [[0, 0], [1, -0.18], [2, 0.22], [3, 0]],
    chestFlex: [[0, 0.05], [1, 0.0], [1.6, 0.12], [3, 0.05]],
    spineFlex: [[0, 0.04], [3, 0.04]],
    foot: [[0, -0.12, -0.76, 0.1], [1, -0.16, -0.66, 0.2], [1.7, -0.08, -0.84, -0.06], [3, -0.12, -0.76, 0.1]],
    footL: [[0, 0.12, -0.76, 0.1], [1, 0.1, -0.82, -0.05], [1.7, 0.16, -0.66, 0.2], [3, 0.12, -0.76, 0.1]],
  },
  {
    // 2: backhand slash, left → right, palm down
    hand: [[0, ...G0], [1, 0.16, 0.12, 0.18], [1.33, 0.06, 0.13, 0.44], [1.66, -0.26, 0.13, 0.44], [2, -0.5, 0.12, 0.1], [2.5, -0.36, 0.04, 0.22], [3, ...G0]],
    knife: [[0, ...K0], [1, 0.92, 0.2, 0.3], [1.33, 0.5, 0.06, 0.86], [1.66, -0.5, 0.0, 0.86], [2, -0.95, -0.05, 0.05], [2.5, -0.4, 0.1, 0.9], [3, ...K0]],
    edge: [[0, ...E0], [1, -0.25, 0, 1], [1.33, -0.86, 0, 0.5], [1.66, -0.86, 0, -0.5], [2, -0.05, 0, -1], [2.5, 0, -1, 0], [3, ...E0]],
    pole: [[0, ...P0], [1, -0.2, 0.6, 0.5], [1.5, -0.6, 0.5, 0.0], [2, -1, 0.3, -0.4], [3, ...P0]],
    handL: [[0, ...L0], [1, 0.3, -0.04, 0.0], [2, 0.28, 0.04, 0.3], [3, ...L0]],
    chestTwist: [[0, 0], [1, 0.4], [1.5, 0.0], [2, -0.4], [3, 0]],
    spineTwist: [[0, 0], [1, 0.2], [2, -0.2], [3, 0]],
    chestFlex: [[0, 0.05], [1, 0.08], [1.6, 0.1], [3, 0.05]],
    spineFlex: [[0, 0.04], [3, 0.04]],
    foot: [[0, -0.12, -0.76, 0.1], [1, -0.1, -0.84, -0.06], [1.7, -0.16, -0.66, 0.2], [3, -0.12, -0.76, 0.1]],
    footL: [[0, 0.12, -0.76, 0.1], [1, 0.16, -0.66, 0.2], [1.7, 0.08, -0.84, -0.06], [3, 0.12, -0.76, 0.1]],
  },
  {
    // 3: overhead downward stab / hook with a body crunch and a dolphin kick
    hand: [[0, ...G0], [1, -0.22, 0.42, 0.02], [1.33, -0.16, 0.32, 0.38], [1.66, -0.09, 0.04, 0.5], [2, -0.04, -0.18, 0.38], [2.5, -0.15, -0.08, 0.3], [3, ...G0]],
    knife: [[0, ...K0], [1, -0.05, 0.85, 0.5], [1.33, 0, 0.25, 1], [1.66, 0.05, -0.55, 0.85], [2, 0.1, -0.95, 0.3], [2.5, 0, -0.3, 1], [3, ...K0]],
    edge: [[0, ...E0], [1, 0, -0.5, 0.85], [1.33, 0, -1, 0.25], [1.66, 0, -0.85, -0.55], [2, 0, -0.3, -0.95], [2.5, 0, -1, 0], [3, ...E0]],
    pole: [[0, ...P0], [1, -0.6, 0.7, -0.5], [1.66, -0.8, 0.3, -0.3], [2, -0.8, -0.2, -0.4], [3, ...P0]],
    handL: [[0, ...L0], [1, 0.18, 0.14, 0.42], [1.7, 0.26, -0.02, 0.12], [3, ...L0]],
    chestTwist: [[0, 0], [1, -0.22], [2, 0.1], [3, 0]],
    spineTwist: [[0, 0], [1, -0.1], [2, 0.05], [3, 0]],
    chestFlex: [[0, 0.05], [1, -0.18], [1.4, 0.0], [1.8, 0.32], [2.2, 0.36], [3, 0.05]],
    spineFlex: [[0, 0.04], [1, -0.1], [1.8, 0.22], [2.4, 0.2], [3, 0.04]],
    foot: [[0, -0.12, -0.76, 0.1], [1, -0.12, -0.56, 0.24], [1.7, -0.08, -0.86, -0.1], [3, -0.12, -0.76, 0.1]],
    footL: [[0, 0.12, -0.76, 0.1], [1, 0.12, -0.56, 0.24], [1.7, 0.08, -0.86, -0.1], [3, 0.12, -0.76, 0.1]],
    flex: [[0, 0.5], [1, 0.1], [1.7, 1.15], [3, 0.5]],
  },
];

export function poseLight(out, combo, tau) {
  const k = COMBO[combo] ?? COMBO[0];
  out.copy(NEUTRAL);
  sampleVec3(k.hand, tau, out.handR);
  sampleVec3(k.knife, tau, out.knifeDir);
  sampleVec3(k.edge, tau, out.knifeEdge);
  sampleVec3(k.pole, tau, out.poleR);
  sampleVec3(k.handL, tau, out.handL);
  out.fingersL.set(-0.1, 0.35, 1);
  out.palmL.set(-0.4, 0, 1);
  out.curlL = 0.35;
  out.poleL.set(1, -0.4, -0.5);
  out.chest.set(sampleScalar(k.chestFlex, tau), sampleScalar(k.chestTwist, tau), 0);
  out.spine.set(sampleScalar(k.spineFlex, tau), sampleScalar(k.spineTwist, tau), 0);
  out.head.y = -out.chest.y * 0.6 - out.spine.y * 0.6; // keep eyes on the target
  out.head.x = -out.chest.x * 0.6 - out.spine.x * 0.5;
  sampleVec3(k.foot, tau, out.footR);
  sampleVec3(k.footL, tau, out.footL);
  if (k.flex) out.flexR = out.flexL = sampleScalar(k.flex, tau);
  out.kneeR.set(-0.2, 0, 1);
  out.kneeL.set(0.2, 0, 1);
}

// ---------------------------------------------------------------------------
// Heavy: charge (coil) and thrust
// ---------------------------------------------------------------------------
const CH_HAND_A = new V(-0.3, -0.02, -0.1);
const CH_HAND_B = new V(-0.34, -0.05, -0.24);

export function poseHeavyCharge(out, charge01) {
  const c = easeOutCubic(saturate(charge01));
  out.copy(NEUTRAL);
  out.handR.lerpVectors(CH_HAND_A, CH_HAND_B, c);
  out.knifeDir.set(-0.04, 0.06, 1);
  out.knifeEdge.set(0, -1, 0);
  out.poleR.set(-0.5, 0.15, -1);
  out.handL.set(0.15, 0.1, 0.44);
  out.fingersL.set(-0.05, 0.3, 1);
  out.palmL.set(-0.15, 0, 1);
  out.curlL = 0.15;
  out.poleL.set(1, -0.3, -0.3);
  out.chest.set(0.1 + 0.1 * c, -0.18 - 0.16 * c, 0);
  out.spine.set(0.1 + 0.1 * c, -0.12 - 0.1 * c, 0);
  out.head.set(-0.12 - 0.12 * c, 0.2 + 0.18 * c, 0);
  // legs gather under the body, ready to drive
  out.footR.set(-0.13, -0.56 + 0.04 * c, 0.16);
  out.footL.set(0.13, -0.6, 0.08 - 0.06 * c);
  out.kneeR.set(-0.3, 0.1, 1);
  out.kneeL.set(0.3, 0.1, 1);
  out.flexR = out.flexL = 0.15;
  out.rootPos.z = -0.02 * c;
}

const HV = {
  hand: [[0, -0.34, -0.04, -0.22], [1, -0.34, -0.03, -0.24], [1.35, -0.12, 0.08, 0.5], [2, -0.1, 0.09, 0.53], [2.6, -0.2, 0.02, 0.36], [3, ...G0]],
  pole: [[0, -0.5, 0.15, -1], [1.35, -1, 0.1, -0.3], [3, ...P0]],
  handL: [[0, 0.15, 0.1, 0.44], [1.4, 0.34, -0.06, -0.2], [2.4, 0.28, -0.02, 0.0], [3, ...L0]],
  chestTwist: [[0, -0.33], [1, -0.35], [1.4, 0.3], [2, 0.28], [3, 0]],
  spineTwist: [[0, -0.22], [1, -0.22], [1.4, 0.15], [3, 0]],
  chestFlex: [[0, 0.2], [1.4, 0.04], [3, 0.05]],
  foot: [[0, -0.13, -0.56, 0.16], [1, -0.13, -0.54, 0.16], [1.4, -0.07, -0.86, -0.08], [2.4, -0.08, -0.84, -0.02], [3, -0.12, -0.76, 0.1]],
  flex: [[0, 0.15], [1.4, 1.15], [2.4, 1.0], [3, 0.5]],
};

export function poseHeavy(out, tau) {
  out.copy(NEUTRAL);
  sampleVec3(HV.hand, tau, out.handR);
  out.knifeDir.set(-0.03, 0.04, 1);
  out.knifeEdge.set(0, -1, 0);
  sampleVec3(HV.pole, tau, out.poleR);
  sampleVec3(HV.handL, tau, out.handL);
  out.fingersL.set(0.2, -0.2, -1);
  out.palmL.set(0.2, 0.2, -1);
  out.curlL = 0.1;
  out.chest.set(sampleScalar(HV.chestFlex, tau), sampleScalar(HV.chestTwist, tau), 0);
  out.spine.set(0.06, sampleScalar(HV.spineTwist, tau), 0);
  out.head.y = -out.chest.y * 0.7 - out.spine.y * 0.7;
  out.head.x = -0.1;
  sampleVec3(HV.foot, tau, out.footR);
  out.footL.copy(out.footR);
  out.footL.x *= -1;
  out.flexR = out.flexL = sampleScalar(HV.flex, tau);
  out.kneeR.set(-0.2, 0, 1);
  out.kneeL.set(0.2, 0, 1);
}

// ---------------------------------------------------------------------------
// Dodge, parry, hurt, grabbed, dead
// ---------------------------------------------------------------------------
const DODGE_BACK_A = new V(-0.18, 0.08, 0.45);
const DODGE_BACK_B = new V(-0.46, -0.02, 0.0);

export function poseDodge(out, u, back) {
  out.copy(NEUTRAL);
  const k = smoothstep(0.25, 0.55, u);
  if (back) {
    // big forward arm sweep that shoves him backwards
    _t.copy(DODGE_BACK_A).lerp(DODGE_BACK_B, smoothstep(0.0, 0.5, u));
    out.handR.copy(_t);
    out.handL.set(-_t.x, _t.y, _t.z);
    out.knifeDir.set(-0.2, 0.2, 1);
    out.fingersL.set(0.2, 0.0, 1);
    out.palmL.set(0, 0, 1);
    out.spine.x = -0.12 + 0.2 * k;
    out.chest.x = -0.1 + 0.15 * k;
  } else {
    out.handR.set(-0.14, 0.0, 0.17);
    out.handL.set(0.14, 0.02, 0.17);
    out.knifeDir.set(0.1, 1, 0.25);
    out.knifeEdge.set(0, 0, 1);
    out.fingersL.set(0, 1, 0.2);
    out.palmL.set(-1, 0, 0);
    out.spine.x = 0.18 * (1 - k);
    out.chest.x = 0.12 * (1 - k);
  }
  out.poleR.set(-1, -0.6, -0.2);
  out.poleL.set(1, -0.6, -0.2);
  out.curlL = 0.5;
  // big whip kick: knees snap from bent to straight, toes pointed
  const kick = smoothstep(0.18, 0.5, u);
  out.footR.set(-0.11 + 0.04 * kick, -0.52 - 0.34 * kick, -0.16 + 0.17 * kick);
  out.footL.set(0.11 - 0.04 * kick, -0.52 - 0.34 * kick, -0.16 + 0.17 * kick);
  out.kneeR.set(-0.3, 0, 1);
  out.kneeL.set(0.3, 0, 1);
  out.flexR = out.flexL = 0.0 + 1.2 * kick;
  out.outR = out.outL = 0.4 * (1 - kick);
}

const PARRY_HAND = new V(-0.1, 0.24, 0.3);
const PARRY_KNIFE = new V(0.5, 0.82, 0.25);
const PARRY_EDGE = new V(-0.15, -0.1, 1);
const PARRY_HAND_L = new V(0.03, 0.2, 0.28);
const RIPOSTE_HAND = new V(-0.42, 0.2, 0.24);
const RIPOSTE_KNIFE = new V(-0.8, 0.55, 0.3);
// whiff: the block braced for a hit that never came falls through — knife
// hand forward and down past the guard, blade tipping down, left arm out
const WHIFF_HAND = new V(-0.13, -0.14, 0.42);
const WHIFF_KNIFE = new V(0.2, -0.45, 1);
const WHIFF_EDGE = new V(0, -0.9, -0.4);
const WHIFF_HAND_L = new V(0.3, -0.05, 0.18);

/**
 * Parry block. u = 0..1 over PARRY_TOTAL (raise, hold, release); successU =
 * 0..1 through a successful parry's flourish (else −1); whiffU = 0..1 through
 * the whiff recovery after a window closed on nothing (else −1), whiffAmp =
 * how far the miss throws him off balance.
 */
export function poseParry(out, u, successU, whiffU = -1, whiffAmp = 1) {
  out.copy(NEUTRAL);
  applyGuard(out, 1);
  const raise = smoothstep(0, 0.16, u);
  // a whiff drops the block at once; otherwise it is held through the window
  const up = whiffU >= 0 ? raise * (1 - smoothstep(0, 0.6, whiffU)) : raise * (1 - smoothstep(0.72, 1, u));
  out.handR.lerp(PARRY_HAND, up);
  out.knifeDir.lerp(PARRY_KNIFE, up);
  out.knifeEdge.lerp(PARRY_EDGE, up);
  out.poleR.set(-1, -0.3, 0);
  out.handL.lerp(PARRY_HAND_L, up);
  out.fingersL.set(-0.3, 0.9, 0.2);
  out.palmL.set(0, 0, 1);
  out.curlL = 0.1;
  out.spine.x = 0.04 - 0.1 * up;
  out.chest.x = 0.03 - 0.12 * up;
  out.head.x = 0.12 * up;
  if (successU >= 0) {
    const s = easeOutCubic(saturate(successU * 2.2)) * (1 - smoothstep(0.6, 1, successU));
    out.handR.lerp(RIPOSTE_HAND, s);
    out.knifeDir.lerp(RIPOSTE_KNIFE, s);
    out.chest.y -= 0.3 * s;
    out.spine.y -= 0.12 * s;
  } else if (whiffU > 0) {
    // off balance for a beat, then back into the guard
    const dip = Math.sin(Math.PI * Math.min(1, whiffU)) * whiffAmp;
    out.handR.lerp(WHIFF_HAND, dip);
    out.knifeDir.lerp(WHIFF_KNIFE, dip);
    out.knifeEdge.lerp(WHIFF_EDGE, dip);
    out.handL.lerp(WHIFF_HAND_L, dip * 0.7);
    out.spine.x += 0.14 * dip;
    out.chest.x += 0.12 * dip;
    out.head.x -= 0.1 * dip; // eyes stay on the water ahead
  }
}

export function poseHurt(out, u, dir, heavy, time) {
  out.copy(NEUTRAL);
  const env = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.5 + 0.06)), 0.7) * (1 - smoothstep(0.7, 1, u));
  const amp = heavy ? 1.35 : 0.85;
  out.chest.x = 0.03 + 0.5 * dir.z * env * amp;
  out.spine.x = 0.04 + 0.25 * dir.z * env * amp;
  out.chest.z = -0.4 * dir.x * env * amp;
  out.head.x = 0.4 * dir.z * env * amp;
  out.neck.x = 0.2 * dir.z * env * amp;
  const fl = heavy ? 0.05 * Math.sin(time * 37) * env : 0;
  out.handR.set(-0.42, 0.14 + fl, 0.0).lerp(NEUTRAL.handR, 1 - env);
  out.handL.set(0.42, 0.18 - fl, 0.02).lerp(NEUTRAL.handL, 1 - env);
  out.knifeDir.set(-0.5, 0.75, 0.1);
  out.fingersL.set(0.5, 0.7, 0.2);
  out.palmL.set(0, 0, 1);
  out.curlL = 0.15;
  out.poleR.set(-0.6, -0.6, -0.6);
  out.poleL.set(0.6, -0.6, -0.6);
  out.footR.set(-0.2, -0.7 + fl, 0.18 * env + 0.05);
  out.footL.set(0.2, -0.74 - fl, 0.1 * env + 0.05);
  out.flexR = out.flexL = 0.7;
  out.outR = out.outL = 0.3;
}

const GR_RAISED = new V(-0.25, 0.35, 0.13);
const GR_RAISED_K = new V(0.05, 0.75, 0.65);
const GR_HIGH = new V(-0.24, 0.42, 0.05);
const GR_HIGH_K = new V(0.0, 0.92, 0.4);
const GR_STAB = new V(-0.05, 0.1, 0.5);
const GR_STAB_K = new V(0.05, -0.35, 1);

export function poseGrabbed(out, time, stabU) {
  out.copy(NEUTRAL);
  const n1 = noise1(time * 3.1, 1);
  const n2 = noise1(time * 2.7, 2);
  out.handL.set(0.12 + 0.03 * n1, 0.08 + 0.03 * n2, 0.46);
  out.fingersL.set(0, 0.6, 0.8);
  out.palmL.set(0, -0.1, 1);
  out.curlL = 0.1 + 0.2 * Math.abs(n2);
  out.poleL.set(1, -0.2, -0.6);
  out.handR.copy(GR_RAISED);
  out.knifeDir.copy(GR_RAISED_K);
  out.knifeEdge.set(0, -0.65, 0.75);
  out.poleR.set(-0.7, 0.6, -0.3);
  if (stabU >= 0) {
    if (stabU < 0.25) {
      const k = smoothstep(0, 0.25, stabU);
      out.handR.lerp(GR_HIGH, k);
      out.knifeDir.lerp(GR_HIGH_K, k);
    } else if (stabU < 0.55) {
      const k = easeOutCubic((stabU - 0.25) / 0.3);
      out.handR.copy(GR_HIGH).lerp(GR_STAB, k);
      out.knifeDir.copy(GR_HIGH_K).lerp(GR_STAB_K, k);
      out.knifeEdge.set(0, -1, -0.3);
    } else {
      const k = smoothstep(0.55, 1, stabU);
      out.handR.copy(GR_STAB).lerp(GR_RAISED, k);
      out.knifeDir.copy(GR_STAB_K).lerp(GR_RAISED_K, k);
    }
  }
  out.spine.set(0.18 + 0.06 * n1, 0.15 * Math.sin(time * 5), 0.08 * n2);
  out.chest.set(0.12, 0.1 * Math.sin(time * 5 + 1), 0);
  out.head.set(-0.2, 0.1 * n2, 0);
  // frantic kicking
  const a = time * 11;
  out.footR.set(-0.13 + 0.04 * Math.sin(a), -0.72 + 0.06 * Math.sin(a * 1.3), 0.08 + 0.15 * Math.sin(a));
  out.footL.set(0.13 + 0.04 * Math.sin(a + 2), -0.72 + 0.06 * Math.sin(a * 1.3 + 2), 0.08 + 0.15 * Math.sin(a + Math.PI));
  out.flexR = 0.6 + 0.4 * Math.sin(a);
  out.flexL = 0.6 + 0.4 * Math.sin(a + Math.PI);
}

export function poseDead(out, time) {
  out.copy(NEUTRAL);
  const s = Math.sin(time * 0.7);
  const c = Math.cos(time * 0.55);
  out.handR.set(-0.36, 0.16 + 0.03 * s, 0.1);
  out.handL.set(0.34, 0.22 + 0.03 * c, 0.08);
  out.knifeDir.set(-0.4, -0.25, 0.8);
  out.knifeEdge.set(0, -1, 0);
  out.fingersL.set(0.4, 0.3, 0.8);
  out.palmL.set(0, -0.3, 1);
  out.curlL = 0.5;
  out.poleR.set(-1, -0.5, -0.6);
  out.poleL.set(1, -0.5, -0.6);
  out.footR.set(-0.12, -0.76, 0.1 + 0.02 * s);
  out.footL.set(0.13, -0.74, 0.06 + 0.02 * c);
  out.flexR = out.flexL = 0.7;
  out.outR = out.outL = 0.25;
  out.spine.set(0.3, 0.05 * s, 0.04 * c);
  out.chest.set(0.22, 0, 0);
  out.neck.set(0.3, 0, 0);
  out.head.set(0.28, 0.1 * c, 0.06 * s);
}
