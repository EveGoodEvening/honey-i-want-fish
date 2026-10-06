// Procedural, layered animation for 老公.
//
//  1. locomotion layer: tread / breaststroke / flutter poses blended by weight
//  2. action layer: light combo, heavy charge/thrust, dodge, parry, hurt,
//     grabbed, dead — with a per-action leg mask
//  3. crossfade: whenever the action instance changes, the previous output is
//     snapshotted and blended into the new target (no pops between swings)
//  4. additive: breathing, charge tremble, head look-at
//  5. solve: FK for the spine chain, analytic two-bone IK for arms and legs
//     (with forearm twist sharing), finger curl, spring-driven cloth bones.
//
// All solving happens in MODEL space using our own FK arrays, so the knife
// segment we report to combat matches the rendered bones exactly.
import * as THREE from 'three';
import { BONE_DEFS, BONE_INDEX, ARM_DIR_R, ARM_DIR_L, HAND_L, KNIFE_DIR_BIND, KNIFE_EDGE_BIND, GRIP_OFFSET_R, KNIFE, MOUTH_OFFSET, HEM_BONES } from './rig.js';
import { Pose, poseTread, poseBreast, poseFlutter, poseLight, poseHeavyCharge, poseHeavy, poseDodge, poseParry, poseHurt, poseGrabbed, poseDead, applyGuard } from './poses.js';
import { quatFromBasis, twistAngle, clamp, smoothstep, noise1, softClamp } from './math.js';

const B = BONE_INDEX;
const NB = BONE_DEFS.length;
const SPINE_CHAIN = [B.pelvis, B.spine, B.chest, B.neck, B.head];

// temps
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _d = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _u1 = new THREE.Vector3();
const _u2 = new THREE.Vector3();
const _z = new THREE.Vector3();
const _y = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _wrist = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _k = new THREE.Vector3();
const _ed = new THREE.Vector3();
const _qHand = new THREE.Quaternion();

// Crossfade-in durations per action kind (s).
const FADE_IN = {
  none: 0.24,
  light: 0.06,
  heavyCharge: 0.12,
  heavy: 0.05,
  dodge: 0.06,
  parry: 0.05,
  hurt: 0.04,
  grabbed: 0.14,
  dead: 0.35,
};
// How much each action drives the legs (rest comes from locomotion).
const LEG_MASK = {
  light: 0.55,
  heavyCharge: 0.9,
  heavy: 1,
  dodge: 1,
  parry: 0.4,
  hurt: 0.8,
  grabbed: 1,
  dead: 1,
};

/** Bind frame of a limb: X = bone direction, Y = pole (where the joint points). */
function bindFrame(dir, pole) {
  const x = dir.clone().normalize();
  const y = pole.clone().addScaledVector(x, -pole.dot(x)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  const q = quatFromBasis(new THREE.Quaternion(), x, y, z);
  return q.invert(); // store the inverse
}

/** Inverse bind basis for (primary, secondary) direction pairs. */
function bindPS(primary, secondary) {
  const x = primary.clone().normalize();
  const y = secondary.clone().addScaledVector(x, -secondary.dot(x)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return quatFromBasis(new THREE.Quaternion(), x, y, z).invert();
}

/** Writes rot = basis(primary, secondary⊥, primary×secondary⊥) * bindInv. */
function orientPS(out, primary, secondary, bindInv) {
  _k.copy(primary).normalize();
  _ed.copy(secondary).addScaledVector(_k, -_k.dot(secondary));
  if (_ed.lengthSq() < 1e-8) {
    _ed.set(0, 1, 0).addScaledVector(_k, -_k.y);
    if (_ed.lengthSq() < 1e-8) _ed.set(1, 0, 0).addScaledVector(_k, -_k.x);
  }
  _ed.normalize();
  _z.crossVectors(_k, _ed);
  quatFromBasis(out, _k, _ed, _z);
  return out.multiply(bindInv);
}

class ClothSpring {
  constructor(bone, parent, hang, outward, opts) {
    this.bone = bone;
    this.parent = parent;
    this.hang = hang.clone().normalize();
    this.outward = outward.clone().addScaledVector(this.hang, -outward.dot(this.hang)).normalize();
    this.flare = opts.flare ?? 0.1;
    this.gain = opts.gain ?? 0.1;
    this.max = opts.max ?? 0.8;
    this.k = opts.k ?? 55;
    this.c = opts.c ?? 7;
    this.flutter = opts.flutter ?? 0.05;
    this.seed = opts.seed ?? 0;
    this.rot = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.v = new THREE.Vector3(); // smoothed world velocity
    this.init = false;
  }
}

export class PlayerAnimator {
  constructor(model) {
    this.model = model;
    this.bones = model.bones;
    // bind local offsets
    this.bindLocal = [];
    this.parent = [];
    for (let i = 0; i < NB; i++) {
      const [, parent] = BONE_DEFS[i];
      this.parent.push(parent ? B[parent] : -1);
      this.bindLocal.push(this.bones[i].position.clone());
    }
    this.localQ = Array.from({ length: NB }, () => new THREE.Quaternion());
    this.localP = this.bindLocal.map((p) => p.clone());
    this.modelQ = Array.from({ length: NB }, () => new THREE.Quaternion());
    this.modelP = Array.from({ length: NB }, () => new THREE.Vector3());

    // limb constants
    this.limbs = {
      armR: this._limb('upperArmR', 'foreArmR', 'handR', 'clavR', new THREE.Vector3(0, 0, -1)),
      armL: this._limb('upperArmL', 'foreArmL', 'handL', 'clavL', new THREE.Vector3(0, 0, -1)),
      legR: this._limb('thighR', 'shinR', 'footR', 'pelvis', new THREE.Vector3(0, 0, 1)),
      legL: this._limb('thighL', 'shinL', 'footL', 'pelvis', new THREE.Vector3(0, 0, 1)),
    };
    this.knifeBindInv = bindPS(KNIFE_DIR_BIND, KNIFE_EDGE_BIND);
    this.handLBindInv = bindPS(HAND_L.a, HAND_L.n);
    this.fingerAxisL = new THREE.Vector3().crossVectors(HAND_L.a, HAND_L.n).normalize();
    // knife points relative to the hand bone (bind == hand frame)
    this.knifeBase = GRIP_OFFSET_R.clone().addScaledVector(KNIFE_DIR_BIND, KNIFE.bladeStart);
    this.knifeTip = GRIP_OFFSET_R.clone().addScaledVector(KNIFE_DIR_BIND, KNIFE.bladeEnd);
    this.knifeDirLocal = KNIFE_DIR_BIND.clone();

    // poses
    this.pTread = new Pose();
    this.pBreast = new Pose();
    this.pFlutter = new Pose();
    this.loco = new Pose();
    this.act = new Pose();
    this.target = new Pose();
    this.from = new Pose();
    this.base = new Pose(); // crossfaded pose before additive layers
    this.out = new Pose();
    this._actionKind = '';
    this._actionId = -1;
    this._fadeT = 1;
    this._fadeDur = 0.2;
    this._breath = 0;
    this._time = 0;
    this._first = true;

    // cloth springs
    this.springs = [];
    for (const [name, phi] of HEM_BONES) {
      const bi = B[name];
      const out = new THREE.Vector3(Math.sin(phi), 0, Math.cos(phi));
      const front = Math.abs(phi) < 0.6;
      this.springs.push(
        new ClothSpring(bi, this.parent[bi], new THREE.Vector3(0, -1, 0), out, {
          flare: front ? 0.07 : 0.04,
          gain: front ? 0.15 : 0.1,
          max: front ? 1.1 : 0.85,
          k: front ? 40 : 52,
          c: front ? 5 : 6.5,
          flutter: front ? 0.08 : 0.05,
          seed: bi,
        }),
      );
    }
    for (const [name, side] of [['lapelL', 1], ['lapelR', -1]]) {
      const bi = B[name];
      this.springs.push(
        new ClothSpring(bi, this.parent[bi], new THREE.Vector3(0, -1, 0.15), new THREE.Vector3(side * 0.6, 0, 1), {
          flare: 0.08,
          gain: 0.09,
          max: 0.55,
          k: 65,
          c: 7,
          flutter: 0.05,
          seed: bi,
        }),
      );
    }
    for (const [name, dir] of [['sleeveR', ARM_DIR_R], ['sleeveL', ARM_DIR_L]]) {
      const bi = B[name];
      this.springs.push(
        new ClothSpring(bi, this.parent[bi], dir, new THREE.Vector3(0, 0, 1), { flare: 0, gain: 0.05, max: 0.3, k: 90, c: 9, flutter: 0.035, seed: bi }),
      );
    }
  }

  _limb(upper, lower, end, parentName, bindPole) {
    const u = B[upper];
    const l = B[lower];
    const e = B[end];
    const dir = this.bindLocal[l].clone().normalize();
    return {
      upper: u,
      lower: l,
      end: e,
      parent: B[parentName],
      L1: this.bindLocal[l].length(),
      L2: this.bindLocal[e].length(),
      bindInv: bindFrame(dir, bindPole),
      axis: dir,
    };
  }

  // -------------------------------------------------------------------------
  /**
   * @param {number} dt
   * @param {object} d   animation descriptor written by Player (see Player._anim)
   * @param {THREE.Quaternion} objQuat  the player's world orientation
   * @param {THREE.Matrix4} rootWorld   model-root world matrix (for cloth)
   */
  update(dt, d, objQuat, rootWorld) {
    this._time += dt;
    const time = this._time;

    // 1. locomotion
    const wI = d.wIdle;
    const wB = d.wBreast;
    const wF = d.wFlutter;
    poseTread(this.pTread, d.tread, d.effort);
    applyGuard(this.pTread, d.guard);
    this.loco.copy(this.pTread);
    if (wB > 0.001) {
      poseBreast(this.pBreast, d.breast);
      this.loco.lerp(this.pBreast, wB / Math.max(1e-4, wI + wB));
    }
    if (wF > 0.001) {
      poseFlutter(this.pFlutter, d.flutter);
      this.loco.lerp(this.pFlutter, wF / Math.max(1e-4, wI + wB + wF));
    }

    // 2. action
    const kind = d.action;
    if (kind === 'none') {
      this.target.copy(this.loco);
    } else {
      const a = this.act;
      switch (kind) {
        case 'light':
          poseLight(a, d.combo, d.tau);
          break;
        case 'heavyCharge':
          poseHeavyCharge(a, d.charge / 1.5);
          break;
        case 'heavy':
          poseHeavy(a, d.tau);
          break;
        case 'dodge':
          poseDodge(a, d.dodgeU, d.dodgeBack);
          break;
        case 'parry':
          poseParry(a, d.parryU, d.parrySuccessU, d.parryWhiffU ?? -1, d.parryWhiffAmp ?? 1);
          break;
        case 'hurt':
          poseHurt(a, d.hurtU, d.hurtDir, d.hurtHeavy, time);
          break;
        case 'grabbed':
          poseGrabbed(a, time, d.stabU);
          break;
        case 'dead':
          poseDead(a, time);
          break;
        default:
          a.copy(this.loco);
      }
      this.target.copy(this.loco);
      this.target.lerpUpper(a, 1);
      this.target.lerpLower(a, LEG_MASK[kind] ?? 1);
    }

    // 3. crossfade on action change
    if (kind !== this._actionKind || d.actionId !== this._actionId) {
      // snapshot the blended pose WITHOUT the additive layers (they are
      // re-applied every frame below)
      if (!this._first) this.from.copy(this.base);
      else this.from.copy(this.target);
      this._actionKind = kind;
      this._actionId = d.actionId;
      this._fadeT = 0;
      this._fadeDur = FADE_IN[kind] ?? 0.15;
    }
    this._first = false;
    this._fadeT += dt;
    const f = this._fadeDur > 0 ? smoothstep(0, 1, this._fadeT / this._fadeDur) : 1;
    this.base.copy(this.from).lerp(this.target, f);

    // 4. additive layers
    const o = this.out.copy(this.base);
    this._breath += dt * (d.breathRate ?? 0.25) * Math.PI * 2;
    const br = Math.sin(this._breath);
    o.chest.x += 0.014 * br;
    o.spine.x += 0.006 * br;
    o.neck.x -= 0.008 * br;
    if (d.tremble > 0) {
      const tr = d.tremble;
      o.handR.x += noise1(time * 38, 3) * tr;
      o.handR.y += noise1(time * 41, 4) * tr;
      o.handR.z += noise1(time * 35, 5) * tr * 0.6;
      o.chest.y += noise1(time * 23, 6) * tr * 2;
      o.handL.x += noise1(time * 33, 7) * tr * 0.7;
    }
    if (d.lookWeight > 0) {
      o.head.y += clamp(d.lookYaw, -0.7, 0.7) * d.lookWeight * 0.65;
      o.neck.y += clamp(d.lookYaw, -0.7, 0.7) * d.lookWeight * 0.35;
      o.head.x += clamp(d.lookPitch, -0.5, 0.5) * d.lookWeight * 0.6;
      o.neck.x += clamp(d.lookPitch, -0.5, 0.5) * d.lookWeight * 0.3;
    }

    // 5. solve
    this._solve(o, d);
    this._cloth(dt, d, objQuat, rootWorld);
    this._write();
  }

  // -------------------------------------------------------------------------
  _fk(i) {
    const p = this.parent[i];
    if (p < 0) {
      this.modelQ[i].copy(this.localQ[i]);
      this.modelP[i].copy(this.localP[i]);
    } else {
      this.modelQ[i].multiplyQuaternions(this.modelQ[p], this.localQ[i]);
      this.modelP[i].copy(this.localP[i]).applyQuaternion(this.modelQ[p]).add(this.modelP[p]);
    }
  }

  _solve(o, d) {
    const LQ = this.localQ;
    // spine chain
    this.localP[B.pelvis].copy(this.bindLocal[B.pelvis]).add(o.rootPos);
    LQ[B.pelvis].setFromEuler(_e.set(o.rootRot.x, o.rootRot.y, o.rootRot.z));
    LQ[B.spine].setFromEuler(_e.set(o.spine.x, o.spine.y, o.spine.z));
    LQ[B.chest].setFromEuler(_e.set(o.chest.x, o.chest.y, o.chest.z));
    LQ[B.neck].setFromEuler(_e.set(o.neck.x, o.neck.y, o.neck.z));
    LQ[B.head].setFromEuler(_e.set(o.head.x, o.head.y, o.head.z));
    for (let i = 0; i < SPINE_CHAIN.length; i++) this._fk(SPINE_CHAIN[i]);

    // clavicles follow the hand targets (shrug when reaching up, protract forward)
    this._clavicle(B.clavR, o.handR, -1);
    this._clavicle(B.clavL, o.handL, 1);

    // arms
    const chestQ = this.modelQ[B.chest];
    const chestP = this.modelP[B.chest];
    _target.copy(o.handR).applyQuaternion(chestQ).add(chestP);
    _pole.copy(o.poleR).applyQuaternion(chestQ);
    this._solveLimb(this.limbs.armR, _target, _pole);
    _v.copy(o.knifeDir).applyQuaternion(chestQ);
    _v2.copy(o.knifeEdge).applyQuaternion(chestQ);
    orientPS(_qHand, _v, _v2, this.knifeBindInv);
    this._setHand(this.limbs.armR, _qHand);

    _target.copy(o.handL).applyQuaternion(chestQ).add(chestP);
    _pole.copy(o.poleL).applyQuaternion(chestQ);
    this._solveLimb(this.limbs.armL, _target, _pole);
    _v.copy(o.fingersL).applyQuaternion(chestQ);
    _v2.copy(o.palmL).applyQuaternion(chestQ);
    orientPS(_qHand, _v, _v2, this.handLBindInv);
    this._setHand(this.limbs.armL, _qHand);

    // fingers
    const curl = clamp(o.curlL, -0.2, 1.6);
    LQ[B.fingersL1].setFromAxisAngle(this.fingerAxisL, curl);
    LQ[B.fingersL2].setFromAxisAngle(this.fingerAxisL, curl * 1.25);
    LQ[B.thumbL].setFromAxisAngle(this.fingerAxisL, curl * 0.35);
    this._fk(B.fingersL1);
    this._fk(B.fingersL2);
    this._fk(B.thumbL);

    // legs
    const pelQ = this.modelQ[B.pelvis];
    const pelP = this.modelP[B.pelvis];
    _target.copy(o.footR).applyQuaternion(pelQ).add(pelP);
    _pole.copy(o.kneeR).applyQuaternion(pelQ);
    this._solveLimb(this.limbs.legR, _target, _pole);
    LQ[B.footR].setFromEuler(_e.set(o.flexR, -o.outR, 0));
    this._fk(B.footR);
    _target.copy(o.footL).applyQuaternion(pelQ).add(pelP);
    _pole.copy(o.kneeL).applyQuaternion(pelQ);
    this._solveLimb(this.limbs.legL, _target, _pole);
    LQ[B.footL].setFromEuler(_e.set(o.flexL, o.outL, 0));
    this._fk(B.footL);

    // sleeves follow their forearms until the cloth pass
    this._fk(B.sleeveR);
    this._fk(B.sleeveL);
  }

  _clavicle(bi, hand, side) {
    // hand target relative to the rest shoulder, chest frame
    const elev = clamp((hand.y - 0.1) / 0.4, -1, 1);
    const fwd = clamp(hand.z / 0.45, -1, 1);
    const raise = Math.max(0, elev) * 0.34 - Math.max(0, -elev) * 0.04;
    const prot = fwd * 0.2;
    // right clavicle: raise = −Z rotation, protract = +Y; left mirrors
    this.localQ[bi].setFromEuler(_e.set(0, side < 0 ? prot : -prot, side < 0 ? -raise : raise));
    this._fk(bi);
  }

  /** Analytic two-bone IK in model space. */
  _solveLimb(limb, target, pole) {
    const { upper, lower, parent, L1, L2, bindInv } = limb;
    // root position of the limb (FK of the upper bone from its parent)
    this._fkPos(upper);
    const root = this.modelP[upper];
    _d.subVectors(target, root);
    let dist = _d.length();
    const minD = Math.abs(L1 - L2) + 1e-3;
    const maxD = (L1 + L2) * 0.9995;
    if (dist < 1e-6) {
      _d.set(0, -1, 0);
      dist = minD;
    }
    _d.multiplyScalar(1 / dist);
    dist = clamp(dist, minD, maxD);
    _perp.copy(pole).addScaledVector(_d, -_d.dot(pole));
    if (_perp.lengthSq() < 1e-8) {
      _perp.set(0, 0, 1).addScaledVector(_d, -_d.z);
      if (_perp.lengthSq() < 1e-8) _perp.set(1, 0, 0).addScaledVector(_d, -_d.x);
    }
    _perp.normalize();
    const a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    _elbow.copy(root).addScaledVector(_d, a).addScaledVector(_perp, h);
    _wrist.copy(root).addScaledVector(_d, dist);
    _u1.subVectors(_elbow, root).normalize();
    _u2.subVectors(_wrist, _elbow).normalize();
    // pole direction for the upper bone, hinge axis shared by both segments
    _y.copy(_perp).addScaledVector(_u1, -_u1.dot(_perp));
    if (_y.lengthSq() < 1e-10) _y.copy(_perp);
    _y.normalize();
    _z.crossVectors(_u1, _y).normalize();
    // upper
    _v.crossVectors(_z, _u1);
    quatFromBasis(_q2, _u1, _v, _z).multiply(bindInv);
    this.modelQ[upper].copy(_q2);
    this.localQ[upper].copy(this.modelQ[parent]).invert().multiply(_q2);
    // lower
    _v.crossVectors(_z, _u2);
    quatFromBasis(_q3, _u2, _v, _z).multiply(bindInv);
    this.modelQ[lower].copy(_q3);
    this.localQ[lower].copy(_q2).invert().multiply(_q3);
    this.modelP[lower].copy(_elbow);
  }

  _fkPos(i) {
    const p = this.parent[i];
    this.modelP[i].copy(this.localP[i]).applyQuaternion(this.modelQ[p]).add(this.modelP[p]);
  }

  /** Sets the hand's model rotation, sharing ~half the wrist twist with the forearm. */
  _setHand(limb, handQ) {
    const { lower, end, axis } = limb;
    const foreQ = this.modelQ[lower];
    _q.copy(foreQ).invert().multiply(handQ); // hand local
    const tw = clamp(twistAngle(_q, axis), -2.6, 2.6);
    const share = clamp(tw * 0.55, -1.3, 1.3);
    _q2.setFromAxisAngle(axis, share);
    foreQ.multiply(_q2);
    this.localQ[lower].multiply(_q2);
    this.modelQ[end].copy(handQ);
    this.localQ[end].copy(foreQ).invert().multiply(handQ);
    this._fkPos(end);
  }

  // -------------------------------------------------------------------------
  _cloth(dt, d, objQuat, rootWorld) {
    const time = this._time;
    const speedish = d.speed ?? 0;
    for (let si = 0; si < this.springs.length; si++) {
      const s = this.springs[si];
      const bi = s.bone;
      const pi = s.parent;
      // current world position of the cloth bone
      _v.copy(this.localP[bi]).applyQuaternion(this.modelQ[pi]).add(this.modelP[pi]).applyMatrix4(rootWorld);
      if (!s.init || dt <= 0) {
        if (!s.init) {
          s.prev.copy(_v);
          s.init = true;
        }
      } else {
        _v2.subVectors(_v, s.prev).multiplyScalar(1 / dt);
        if (_v2.lengthSq() > 400) _v2.set(0, 0, 0); // teleport
        s.v.lerp(_v2, 1 - Math.exp(-dt * 12));
        s.prev.copy(_v);
      }
      // velocity in the parent's (bind-aligned) frame
      _q.copy(objQuat).multiply(this.modelQ[pi]).invert();
      _v3.copy(s.v).applyQuaternion(_q).negate(); // water relative to cloth
      // target rotation vector
      _d.crossVectors(s.hang, _v3).multiplyScalar(s.gain);
      const mag = _d.length();
      if (mag > 1e-6) _d.multiplyScalar(softClamp(mag, s.max) / mag);
      _perp.crossVectors(s.hang, s.outward).multiplyScalar(s.flare * (1 + 0.15 * Math.sin(time * 0.8 + s.seed)));
      _d.add(_perp);
      const fl = s.flutter * (0.6 + Math.min(1.5, speedish * 0.35));
      _v2.set(noise1(time * 2.3, s.seed * 3 + 1), noise1(time * 2.1, s.seed * 3 + 2), noise1(time * 2.6, s.seed * 3 + 3));
      _v2.addScaledVector(s.hang, -_v2.dot(s.hang)).multiplyScalar(fl);
      _d.add(_v2);
      // spring integrate (sub-stepped for stability)
      if (dt > 0) {
        const steps = dt > 1 / 50 ? 2 : 1;
        const h = Math.min(dt, 0.05) / steps;
        for (let k = 0; k < steps; k++) {
          _u1.subVectors(_d, s.rot).multiplyScalar(s.k).addScaledVector(s.vel, -s.c);
          s.vel.addScaledVector(_u1, h);
          s.rot.addScaledVector(s.vel, h);
        }
      }
      const ang = s.rot.length();
      if (ang > 1e-6) this.localQ[bi].setFromAxisAngle(_u2.copy(s.rot).multiplyScalar(1 / ang), ang);
      else this.localQ[bi].identity();
      this._fk(bi);
    }
  }

  _write() {
    for (let i = 0; i < NB; i++) this.bones[i].quaternion.copy(this.localQ[i]);
    this.bones[B.pelvis].position.copy(this.localP[B.pelvis]);
  }

  // -------------------------------------------------------------------------
  // Queries (world space). `rootWorld` = model-root matrixWorld.
  getKnifeSegment(rootWorld, extension, outBase, outTip) {
    const hq = this.modelQ[B.handR];
    const hp = this.modelP[B.handR];
    outBase.copy(this.knifeBase).applyQuaternion(hq).add(hp).applyMatrix4(rootWorld);
    outTip.copy(this.knifeTip).applyQuaternion(hq).add(hp).applyMatrix4(rootWorld);
    if (extension) {
      _v.subVectors(outTip, outBase).normalize();
      outTip.addScaledVector(_v, extension);
    }
  }

  getMouth(rootWorld, out) {
    return out.copy(MOUTH_OFFSET).applyQuaternion(this.modelQ[B.head]).add(this.modelP[B.head]).applyMatrix4(rootWorld);
  }

  getBonePos(name, rootWorld, out) {
    return out.copy(this.modelP[B[name]]).applyMatrix4(rootWorld);
  }

  resetCloth() {
    for (const s of this.springs) {
      s.init = false;
      s.rot.set(0, 0, 0);
      s.vel.set(0, 0, 0);
      s.v.set(0, 0, 0);
    }
    this._first = true;
  }
}

