// Runtime shark (implements the Enemy contract in docs/DESIGN.md).
//
// Model forward axis: local +Z (object3d.lookAt-compatible). `forward` is a
// world-space unit vector kept in sync with the object's orientation.
//
// Responsibilities: skinned rig instance + procedural pose (swimming
// undulation, threat posture, jaw/snout/upper-jaw protrusion, head yaw,
// pectoral drop, eye roll, grab thrash, death roll), inertial locomotion with
// a size-scaled turning radius (turnRate / turnPathRadius / insideTurnCircle
// let the AI reason about it; turns split into yaw and pitch, see
// turnToward), hurtboxes that follow the animated spine, attack volumes, grab
// holding, wake push (+ a camera rumble), wound trickles, the danger level and
// the death sequence (a corpse sheds its speed to water drag; the boss's
// drifts up toward the light for a few seconds before it sinks). Decisions
// live in SharkAI.js; the rig itself is built by buildSharkRig (shared with
// the shader warm-up).
import * as THREE from 'three';
import { WORLD } from '../core/config.js';
import { BONE, SPINE_BONES } from './SharkAnatomy.js';
import { SharkAI } from './SharkAI.js';
import { clamp, smoothstep } from './noise.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _mInv = new THREE.Matrix4();

const MAX_WOUNDS = 6;
/** Corpse speed decay (1/s): water drag on a body that stopped swimming. */
const CORPSE_DRAG = 1.3;
/** Peak rise speed (m/s) of the boss's corpse in its first seconds (only below −15 m). */
const BOSS_RISE = 1.4;

/**
 * Swimming turn: moves unit heading `f` toward unit direction `d` by at most
 * `maxAngle`, splitting the step between yaw (heading) and pitch. A shark
 * turns round by yawing; rotating along the great circle instead pitches the
 * body over a target that lies behind and below (or above) — a vertical loop
 * that dove the megalodon 20 m under 老公 before it could come back.
 */
export function turnToward(f, d, maxAngle) {
  const yaw = Math.atan2(f.x, f.z);
  const pitch = Math.asin(clamp(f.y, -1, 1));
  let dYaw = Math.atan2(d.x, d.z) - yaw;
  if (dYaw > Math.PI) dYaw -= TAU;
  else if (dYaw < -Math.PI) dYaw += TAU;
  let dPitch = Math.asin(clamp(d.y, -1, 1)) - pitch;
  const cp = Math.cos(pitch);
  const span = Math.hypot(dYaw * cp, dPitch);
  if (span < 1e-6) return f;
  if (span > maxAngle) {
    const k = maxAngle / span;
    dYaw *= k;
    dPitch *= k;
  }
  const y = yaw + dYaw;
  const p = pitch + dPitch;
  const c = Math.cos(p);
  return f.set(c * Math.sin(y), Math.sin(p), c * Math.cos(y));
}

/** Resets a pose-target object to the neutral cruising pose (in place). */
export function resetPose(p) {
  p.amp = 1;
  p.freqScale = 1;
  p.arch = 0;
  p.coil = 0;
  p.headPitch = 0;
  p.headYaw = 0;
  p.shake = 0;
  p.jaw = 0.04; // sharks cruise with the mouth slightly parted
  p.snout = 0;
  p.protrude = 0;
  p.pecDrop = 0;
  p.eyeRoll = 0;
  p.extraRoll = 0;
  // smoothing rates (1/s)
  p.jawOpenRate = 5;
  p.jawCloseRate = 6;
  p.coilRate = 6;
  p.archRate = 4;
  p.rollRate = 3;
  p.headRate = 4.5; // head yaw / pitch (a side-snap whips the head round much faster)
  return p;
}

function makePose() {
  return resetPose({});
}

/**
 * Builds the renderable rig for an asset bundle: the skinned body (skin +
 * mouth materials) bound to a fresh skeleton, the eyes on the head bone and
 * the instanced teeth on the jaw bones. Shared by Shark and the shader
 * warm-up in EnemyManager (which renders nothing, it only compiles programs).
 * `dispose()` frees the per-instance GPU data (never the shared bundle).
 */
export function buildSharkRig(a, quality) {
  const bones = a.bones.map((b) => {
    const bone = new THREE.Bone();
    bone.position.copy(b.position);
    return bone;
  });
  a.bones.forEach((b, k) => {
    if (b.parent >= 0) bones[b.parent].add(bones[k]);
  });
  const mesh = new THREE.SkinnedMesh(a.geometry, [a.materials.skin, a.materials.mouth]);
  mesh.add(bones[0]);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = quality !== 'low';
  mesh.receiveShadow = quality !== 'low';
  // Fixed generous bounds: computing them from the skinned pose is costly
  // and would be stale as soon as the tail moves.
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), a.boundingRadius);
  mesh.name = `${a.type}-body`;

  // Eyes: socket (fixed orientation, +Z outward) + rolling eyeball.
  const eyes = [];
  for (const e of a.eyes) {
    const socket = new THREE.Object3D();
    socket.position.copy(e.position);
    socket.quaternion.copy(e.quaternion);
    const eye = new THREE.Mesh(a.eyeGeometry, a.materials.eye);
    eye.castShadow = false;
    socket.add(eye);
    bones[BONE.head].add(socket);
    eyes.push(eye);
  }

  // Teeth: instanced serrated blades riding the upper/lower jaw bones. The
  // per-tooth colour darkens the back rows (they sit inside the mouth) and
  // varies the ivory a little so the rows do not read as a neat zipper.
  const col = new THREE.Color();
  const mkTeeth = (list, colors, bone) => {
    const im = new THREE.InstancedMesh(a.teeth.geometry, a.materials.teeth, list.length);
    for (let k = 0; k < list.length; k++) {
      im.setMatrixAt(k, list[k]);
      if (colors) im.setColorAt(k, col.fromArray(colors, k * 3));
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = false;
    im.computeBoundingSphere();
    bones[bone].add(im);
    return im;
  };
  const teethUpper = mkTeeth(a.teeth.upper, a.teeth.upperColors, BONE.upperJaw);
  const teethLower = mkTeeth(a.teeth.lower, a.teeth.lowerColors, BONE.jaw);

  return {
    mesh,
    bones,
    eyes,
    teethUpper,
    teethLower,
    dispose() {
      mesh.skeleton?.dispose();
      teethUpper.dispose();
      teethLower.dispose();
    },
  };
}

export class Shark {
  constructor(game, manager, type, assets) {
    this.game = game;
    this.manager = manager;
    this.assets = assets;
    const spec = (this.spec = assets.spec);
    this.type = spec.type;
    this.name = spec.name;
    this.isBoss = spec.isBoss;
    this.length = spec.length;
    this.maxHealth = spec.maxHealth;
    this.health = this.maxHealth;
    this.alive = true;
    this.state = 'circle';

    this.object3d = new THREE.Group();
    this.object3d.name = `shark-${type}`;
    this.position = this.object3d.position;
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(1, 0, 0); // local +X in world space
    this.up = new THREE.Vector3(0, 1, 0);
    this.speed = spec.stats.cruise;
    this.drift = new THREE.Vector3();
    this.yawRate = 0;
    this._lastHeading = 0;
    this._sinkVel = 0;
    this.vulnerable = false;
    this.freeze = false; // debug: skip AI + locomotion (pose still applies)
    this.freezeSwim = false; // debug: also stop the swim cycle

    const L = this.length;
    this._bottomMargin = 0.14 * L + 1.0;
    this._topMargin = 0.17 * L + 1.2;

    this._buildRig();

    this.hurtboxes = assets.hurtboxes.map((d) => ({ center: new THREE.Vector3(), radius: d.radius, part: d.part }));
    this._hbDefs = assets.hurtboxes;

    this._mouth = new THREE.Vector3();
    this._biteCenter = new THREE.Vector3();
    this._snoutTip = new THREE.Vector3();
    this._caudal = new THREE.Vector3();

    this.pose = makePose();
    this.pose.phase = Math.random() * TAU;
    this.pose.shakePhase = 0;
    this.pose.flinch = 0;
    this.pose.roll = 0;
    this.poseT = makePose();

    this.steer = {
      target: new THREE.Vector3(),
      speed: spec.stats.cruise,
      accel: spec.stats.accel,
      decel: spec.stats.decel,
      turnBoost: 1,
      maxPitch: spec.stats.maxPitch,
    };

    const atk = spec.attacks;
    const vol = (type2, a, extra) => ({
      id: 0,
      center: new THREE.Vector3(),
      radius: (a.radius ?? 0.1) * L,
      damage: a.damage,
      type: type2,
      canGrab: false,
      knockback: a.knockback,
      parryable: true,
      ...extra,
    });
    this._vols = {
      bite: vol('bite', atk.bite, { canGrab: true, parryable: true, grabDamage: atk.bite.grabDamage }),
      ram: vol('ram', atk.ram, { radius: atk.ram.radius * L + 0.3, parryable: true }),
      tail: vol('tail', atk.tail, { radius: atk.tail.radius * L + 0.4, parryable: false }),
      shockwave: atk.shockwave ? vol('shockwave', atk.shockwave, { radius: 2, parryable: false, maxRadius: atk.shockwave.maxRadius }) : null,
    };
    this.grabDamage = atk.bite.grabDamage;
    this._active = [];

    this.wounds = [];
    for (let k = 0; k < MAX_WOUNDS; k++) this.wounds.push({ bone: 0, local: new THREE.Vector3(), active: false });
    this._woundNext = 0;
    this._bleedTimer = 0;
    this._eyeBleed = 0;
    this._eyeBleedSide = 0;
    this._deathT = 0;
    this._deathRoll = Math.PI;
    this._settled = false;
    this._deathAnnounced = false;

    this.grabbedPlayer = null;
    this._grabT = 0;

    this.ai = new SharkAI(this);
    // CombatSystem's parry cue for our own bite / ram: its volume may go live
    // only a moment later (SharkAI STRIKE_LEAD).
    this._offStrike = game.events?.on?.('enemy:strike', (p) => {
      if (p?.enemy === this && this.alive) this.ai.onStrikeCue();
    });
    game.scene.add(this.object3d);
  }

  // ------------------------------------------------------------------ rig

  _buildRig() {
    const rig = buildSharkRig(this.assets, this.game.quality);
    this._rig = rig;
    this.bones = rig.bones;
    this.mesh = rig.mesh;
    this.eyes = rig.eyes;
    this.teethUpper = rig.teethUpper;
    this.teethLower = rig.teethLower;
    this.object3d.add(rig.mesh);
    this._upperJawRest = rig.bones[BONE.upperJaw].position.clone();
    this._throatRest = rig.bones[BONE.throat].position.clone();
  }

  /** Teleports the shark (spawn / debug). */
  placeAt(position, forward) {
    this.position.copy(position);
    if (forward) this.forward.copy(forward).normalize();
    this._lastHeading = Math.atan2(this.forward.x, this.forward.z);
    this.steer.target.copy(this.position).addScaledVector(this.forward, 10);
    this._orient(1);
    this._applyPose(0.016);
    this._finishFrame(0);
  }

  // ------------------------------------------------------------------ frame

  update(dt) {
    if (dt <= 0) return;
    if (this.freeze) {
      this._applyPose(dt);
      this._orient(dt);
      this._finishFrame(dt);
      return;
    }
    if (this.alive) this.ai.update(dt);
    else this._updateDeath(dt);
    this._locomotion(dt);
    this._applyPose(dt);
    this._finishFrame(dt);
  }

  _locomotion(dt) {
    const st = this.steer;
    if (this._settled) {
      this.speed = 0;
      this.velocity.set(0, 0, 0);
      return;
    }
    const ds = st.speed - this.speed;
    const a = ds > 0 ? st.accel : st.decel;
    this.speed += clamp(ds, -a * dt, a * dt);

    _dir.subVectors(st.target, this.position);
    if (_dir.lengthSq() < 1e-6) _dir.copy(this.forward);
    _dir.normalize();
    if (this.alive) this._avoidBounds(_dir);
    const mp = st.maxPitch;
    if (Math.abs(_dir.y) > mp) {
      const hl = Math.hypot(_dir.x, _dir.z);
      if (hl < 1e-4) _dir.set(this.forward.x, 0, this.forward.z).normalize();
      else {
        const sc = Math.sqrt(1 - mp * mp) / hl;
        _dir.x *= sc;
        _dir.z *= sc;
      }
      _dir.y = Math.sign(_dir.y) * mp;
      _dir.normalize();
    }
    turnToward(this.forward, _dir, this.turnRate() * dt);

    const heading = Math.atan2(this.forward.x, this.forward.z);
    let dh = heading - this._lastHeading;
    if (dh > Math.PI) dh -= TAU;
    else if (dh < -Math.PI) dh += TAU;
    this._lastHeading = heading;
    this.yawRate += (dh / dt - this.yawRate) * (1 - Math.exp(-dt * 6));

    this.drift.multiplyScalar(Math.exp(-dt * 1.6));
    this.velocity.copy(this.forward).multiplyScalar(this.speed).add(this.drift);
    if (!this.alive) this.velocity.y += this._sinkVel;
    this.position.addScaledVector(this.velocity, dt);
    this._clampBounds();
    this._orient(dt);
  }

  _floorAt(x, z) {
    const env = this.game.env;
    const h = env?.getSeabedHeight?.(x, z);
    return Number.isFinite(h) ? h : WORLD.floorY;
  }

  _avoidBounds(d) {
    const p = this.position;
    const L = this.length;
    const nx = p.x + this.forward.x * L * 0.5;
    const nz = p.z + this.forward.z * L * 0.5;
    const floor = Math.max(this._floorAt(p.x, p.z), this._floorAt(nx, nz));
    const minY = floor + this._bottomMargin;
    const maxY = WORLD.surfaceY - this._topMargin;
    if (p.y < minY + 3) d.y += (minY + 3 - p.y) * 0.3;
    if (p.y > maxY - 3) d.y -= (p.y - (maxY - 3)) * 0.3;
    const r = Math.hypot(p.x, p.z);
    const lim = WORLD.arenaRadius - L * 0.6 - 6;
    if (r > lim) {
      const k = (r - lim) * 0.08;
      d.x -= (p.x / r) * k;
      d.z -= (p.z / r) * k;
    }
    d.normalize();
  }

  _clampBounds() {
    const p = this.position;
    const floor = this._floorAt(p.x, p.z);
    if (this.alive) {
      const minY = floor + this._bottomMargin * 0.6;
      const maxY = WORLD.surfaceY - this._topMargin * 0.6;
      if (p.y < minY) p.y = minY;
      if (p.y > maxY) p.y = maxY;
    } else {
      const rest = floor + 0.075 * this.length;
      if (p.y <= rest) {
        p.y = rest;
        if (!this._settled) this._settle();
      }
    }
    const r = Math.hypot(p.x, p.z);
    const R = WORLD.arenaRadius;
    if (r > R) {
      p.x *= R / r;
      p.z *= R / r;
    }
  }

  _orient(dt) {
    const P = this.pose;
    const T = this.poseT;
    const bank = this.alive ? clamp(-this.yawRate * 0.55, -0.5, 0.5) : 0;
    P.roll += (bank + T.extraRoll - P.roll) * (1 - Math.exp(-dt * T.rollRate));
    _z.copy(this.forward);
    _x.crossVectors(UP, _z);
    if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
    _x.normalize();
    _y.crossVectors(_z, _x);
    _m.makeBasis(_x, _y, _z);
    this.object3d.quaternion.setFromRotationMatrix(_m);
    _q.setFromAxisAngle(Z_AXIS, P.roll);
    this.object3d.quaternion.multiply(_q);
    this.right.set(1, 0, 0).applyQuaternion(this.object3d.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.object3d.quaternion);
  }

  _applyPose(dt) {
    const P = this.pose;
    const T = this.poseT;
    const spec = this.spec;
    const L = this.length;
    const b = this.bones;
    const k = (rate) => 1 - Math.exp(-dt * rate);
    P.amp += (T.amp - P.amp) * k(2.5);
    P.freqScale += (T.freqScale - P.freqScale) * k(3);
    P.arch += (T.arch - P.arch) * k(T.archRate);
    P.coil += (T.coil - P.coil) * k(T.coilRate);
    P.headPitch += (T.headPitch - P.headPitch) * k(T.headRate * 0.9);
    P.headYaw += (T.headYaw - P.headYaw) * k(T.headRate * 1.1);
    P.shake += (T.shake - P.shake) * k(4);
    P.jaw += (T.jaw - P.jaw) * k(T.jaw > P.jaw ? T.jawOpenRate : T.jawCloseRate);
    P.snout += (T.snout - P.snout) * k(6);
    P.protrude += (T.protrude - P.protrude) * k(7);
    P.pecDrop += (T.pecDrop - P.pecDrop) * k(5);
    P.eyeRoll += (T.eyeRoll - P.eyeRoll) * k(T.eyeRoll > P.eyeRoll ? 14 : 2.5);
    P.flinch *= Math.exp(-dt * 4.5);

    if (!this.freezeSwim) {
      const freq = (spec.swim.baseFreq + spec.swim.freqPerSpeed * this.speed) * P.freqScale;
      P.phase += TAU * freq * dt;
      if (P.phase > 1e4) P.phase -= TAU * 1000;
      P.shakePhase += dt * TAU * 2.3;
    }

    const amp = spec.swim.amp * P.amp;
    const lam = spec.swim.wavelength;
    const bend = clamp(this.yawRate * 0.55, -0.6, 0.6);
    const spineS = spec.spineS;
    let prev = 0;
    let psiRoot = 0;
    const shakeS = Math.sin(P.shakePhase);
    for (let i = 0; i < SPINE_BONES.length; i++) {
      const s = spineS[i];
      const env = 0.03 + 0.62 * smoothstep(0.25, 1.0, s) ** 2;
      const tailW = smoothstep(0.3, 1.0, s);
      let psi = amp * env * Math.sin(P.phase - (TAU * s) / lam);
      psi -= bend * tailW * 0.9;
      psi += P.coil * tailW * 1.3;
      psi += P.flinch * Math.sin(Math.PI * s) * 0.8;
      psi -= P.shake * 0.35 * shakeS * tailW;
      const bone = b[SPINE_BONES[i]];
      bone.rotation.y = psi - prev;
      bone.rotation.x = i === 0 ? 0 : -P.arch * (i <= 6 ? 0.065 : 0.03);
      prev = psi;
      if (i === 0) psiRoot = psi;
    }
    const psiHead = amp * 0.05 * Math.sin(P.phase + 1.4) + bend * 0.3 + P.shake * 0.5 * shakeS + P.headYaw - P.flinch * 0.35;
    b[BONE.head].rotation.set(-(P.arch * 0.16 + P.headPitch), psiHead - psiRoot, P.shake * 0.14 * Math.sin(P.shakePhase * 0.5));
    b[BONE.snout].rotation.x = -P.snout * 0.2;
    b[BONE.jaw].rotation.x = P.jaw * spec.mouth.maxOpen;
    b[BONE.upperJaw].position.set(
      this._upperJawRest.x,
      this._upperJawRest.y - P.protrude * 0.011 * L,
      this._upperJawRest.z + P.protrude * 0.008 * L,
    );
    b[BONE.throat].position.set(this._throatRest.x, this._throatRest.y - P.jaw * spec.mouth.throatDrop * L, this._throatRest.z);
    const scull = 0.06 * Math.sin(P.phase * 0.5);
    const drop = P.pecDrop * 0.62;
    b[BONE.pecP].rotation.set(0, -P.pecDrop * 0.1, -drop + scull);
    b[BONE.pecN].rotation.set(0, P.pecDrop * 0.1, drop - scull);
    for (let i = 0; i < this.eyes.length; i++) this.eyes[i].rotation.y = -P.eyeRoll * 1.9;
  }

  _finishFrame(dt) {
    this.object3d.updateMatrixWorld(true);
    const defs = this._hbDefs;
    for (let i = 0; i < defs.length; i++) {
      this.hurtboxes[i].center.copy(defs[i].local).applyMatrix4(this.bones[defs[i].bone].matrixWorld);
    }
    const pts = this.assets.points;
    const head = this.bones[BONE.head].matrixWorld;
    this._mouth.copy(pts.grab).applyMatrix4(head);
    this._biteCenter.copy(pts.bite).applyMatrix4(head);
    this._snoutTip.copy(pts.snout).applyMatrix4(head);
    this._caudal.copy(pts.caudal).applyMatrix4(this.bones[BONE.sp8].matrixWorld);

    const v = this._vols;
    v.bite.center.copy(this._biteCenter);
    v.ram.center.copy(this._snoutTip).addScaledVector(this.forward, -0.04 * this.length);
    v.tail.center.copy(this._caudal);

    if (this.grabbedPlayer) {
      this.grabbedPlayer.position.copy(this._mouth);
      this.grabbedPlayer.velocity?.set(0, 0, 0);
    }
    if (dt > 0) {
      if (this.alive) this._wake(dt);
      this._bleed(dt);
    }
  }

  // ------------------------------------------------------------------ AI-facing helpers

  /** Neutral pose targets; SharkAI calls this every frame before layering its state's pose. */
  resetPoseTargets() {
    return resetPose(this.poseT);
  }

  /** Sets the locomotion intent for this frame. */
  setSteer(target, speed, turnBoost = 1, accel = this.spec.stats.accel, decel = this.spec.stats.decel, maxPitch = this.spec.stats.maxPitch) {
    const st = this.steer;
    st.target.copy(target);
    st.speed = speed;
    st.turnBoost = turnBoost;
    st.accel = accel;
    st.decel = decel;
    st.maxPitch = maxPitch;
  }

  /** Yaw/pitch rate limit (rad/s) at the current speed: size-scaled turning radius × turn boost. */
  turnRate(boost = this.steer.turnBoost) {
    const stats = this.spec.stats;
    const rate = (Math.max(this.speed, stats.minTurnSpeed) / (stats.turnRadius * this.length)) * boost;
    return Math.min(rate, stats.maxTurnRate * Math.max(1, boost));
  }

  /** Radius (m) of the circle the shark swims at its current speed and steer. */
  turnPathRadius() {
    return this.speed / Math.max(1e-3, this.turnRate());
  }

  /**
   * True if `p` lies inside the circle the shark would swim turning toward it
   * at its current speed with `turnBoost` — i.e. it cannot be reached by
   * turning alone (the shark must slow down or swim off and come back).
   */
  insideTurnCircle(p, turnBoost) {
    const R = this.speed / Math.max(1e-3, this.turnRate(turnBoost));
    _v.subVectors(p, this.position);
    const along = _v.dot(this.forward);
    const side = _v.dot(this.right);
    const vert = _v.dot(this.up);
    // Centre of the turn toward p's side (horizontal-ish plane of the body).
    const lat = Math.hypot(side, vert);
    return along * along + (lat - R) * (lat - R) < R * R;
  }

  // ------------------------------------------------------------------ attack volumes (used by SharkAI)

  activateVolume(name, id) {
    const vol = this._vols[name];
    if (!vol) return null;
    vol.id = id;
    if (!this._active.includes(vol)) this._active.push(vol);
    return vol;
  }

  deactivateVolume(name) {
    const vol = this._vols[name];
    const i = this._active.indexOf(vol);
    if (i >= 0) this._active.splice(i, 1);
  }

  clearVolumes() {
    this._active.length = 0;
  }

  getVolume(name) {
    return this._vols[name];
  }

  // ------------------------------------------------------------------ Enemy contract

  getAttackVolumes() {
    if (!this.alive || this.game.state !== 'playing') return EMPTY;
    return this._active;
  }

  /**
   * The parryable strike under way (bite / ram), for CombatSystem's strike
   * cue: `{ id, type, eta, snap, point }` — the attack volume id it will use
   * and the seconds until it can touch 老公; a side-snap (head whip) has
   * `snap: true` and `point`, the predicted jaw contact (world Vector3, else
   * null) — or null. The volume itself goes live only a moment after the cue,
   * so the cue always leads contact. Reused object. `ai.snapping` covers the
   * whole side-snap (from its choice, through the wind-up, to the whip).
   */
  getStrikeCue() {
    if (!this.alive || this.game.state !== 'playing') return null;
    return this.ai.strikeCue();
  }

  getMouthPosition() {
    return this._mouth;
  }

  takeHit({ damage = 0, part = 'body', point = null, direction = null, attackType = 'light' } = {}) {
    if (!this.alive) return { damage: 0, killed: false };
    let dmg = damage;
    if (this.vulnerable) dmg *= 1.3;
    dmg = Math.max(0, Math.round(dmg));
    this.health = Math.max(0, this.health - dmg);
    const pt = point ?? this.position;

    // The hit's blood burst is CombatSystem's (one burst per blow); the shark
    // only remembers the wound so it keeps trickling as the body moves.
    this._addWound(pt);

    // Flinch away from the blow (lateral body jerk).
    _v.subVectors(pt, this.position);
    const side = _v.dot(this.right) >= 0 ? 1 : -1;
    const strength = clamp(dmg / (this.isBoss ? 60 : 25), 0.2, 1) * (attackType === 'heavy' ? 1.4 : 1);
    this.pose.flinch = clamp(this.pose.flinch + side * strength * 0.6, -1.2, 1.2);
    if (direction && !this.isBoss) this.drift.addScaledVector(direction, Math.min(2.5, dmg * 0.06));
    if (part === 'eye') {
      this._eyeBleed = Math.max(this._eyeBleed, 2.5);
      this._eyeBleedSide = _v.dot(this.right) >= 0 ? 0 : 1;
      this.pose.eyeRoll = 1;
    }

    const killed = this.health <= 0;
    if (killed) this._die();
    else this.ai.onHit({ damage: dmg, part, attackType });
    return { damage: dmg, killed };
  }

  onParried() {
    if (!this.alive) return;
    this.ai.onParried();
  }

  startGrab(player) {
    if (!this.alive) return;
    this.grabbedPlayer = player ?? this.game.player;
    this._grabT = 0;
    this.clearVolumes();
    this.ai.onGrab();
  }

  releaseGrab(success = false) {
    const player = this.grabbedPlayer;
    if (!player && this.ai.state !== 'grab') return;
    this.grabbedPlayer = null;
    if (this.alive) {
      if (success) {
        this._eyeBleed = Math.max(this._eyeBleed, 3.5);
        this.pose.flinch = clamp(this.pose.flinch + (Math.random() < 0.5 ? -1 : 1) * 0.9, -1.2, 1.2);
        this.ai.onGrabEscape();
      } else if (player) {
        // Spit the player out hard.
        const k = this.isBoss ? 15 : 11;
        player.velocity?.addScaledVector(this.forward, k);
        if (player.velocity) player.velocity.y += 2.5;
        this.ai.onGrabRelease();
      } else {
        this.ai.onGrabRelease();
      }
    }
    if (player && player.grabbedBy === this) player.setGrabbed?.(null);
  }

  /**
   * 0..1 threat for game.danger (vignette, heartbeat, music). Proximity alone
   * tops out at 0.65 so there is headroom: a committed approach reads 0.7–0.8,
   * a wind-up 0.95 and only the attack itself (or a grab) reaches 1.
   */
  getDangerLevel() {
    if (!this.alive) return 0;
    const s = this.ai.state;
    if (s === 'attack' || s === 'grab') return 1;
    if (s === 'telegraph') return 0.95;
    const pp = this.game.player.position;
    const d = Math.min(this.position.distanceTo(pp), this._mouth.distanceTo(pp));
    const prox = 0.1 + 0.55 * Math.pow(clamp(1 - (d - 4) / 28, 0, 1), 1.7);
    let lvl = prox;
    if (s === 'approach' || s === 'flank') lvl = Math.min(0.8, Math.max(prox + 0.1, 0.7));
    else if (s === 'roar') lvl = Math.max(prox, 0.9);
    else if (s === 'stagger') lvl = Math.min(prox, 0.4);
    if (this.isBoss) lvl = Math.max(lvl, 0.35);
    return clamp(lvl, 0, 1);
  }

  dispose() {
    if (this.grabbedPlayer) {
      const p = this.grabbedPlayer;
      this.grabbedPlayer = null;
      if (p.grabbedBy === this) p.setGrabbed?.(null);
    }
    this.manager?.releaseToken?.(this);
    this._offStrike?.();
    this._offStrike = null;
    this.object3d.removeFromParent();
    this._rig.dispose();
  }

  // ------------------------------------------------------------------ helpers

  /** Squared distance from `p` to the body axis (head→tail), plus the closest point. */
  closestBodyPoint(p, out) {
    // Sample a few spine joints (already world-updated).
    let best = Infinity;
    const idx = BODY_SAMPLES;
    for (let i = 0; i < idx.length; i++) {
      _v2.setFromMatrixPosition(this.bones[idx[i]].matrixWorld);
      const d = _v2.distanceToSquared(p);
      if (d < best) {
        best = d;
        out.copy(_v2);
      }
    }
    const dm = this._mouth.distanceToSquared(p);
    if (dm < best) {
      best = dm;
      out.copy(this._mouth);
    }
    return best;
  }

  _wake(dt) {
    const player = this.game.player;
    if (!player || player.alive === false || player.grabbedBy || this.grabbedPlayer) return;
    if (this.speed < 2.5) return;
    // The displacement is felt alongside and behind the body. Nothing is
    // pushed out of the jaws' path: no bow wave while winding up / lunging,
    // and none ahead of the mouth (or every committed bite would whiff).
    const st = this.ai.state;
    if (st === 'telegraph' || st === 'attack') return;
    _v.subVectors(player.position, this._mouth);
    if (_v.dot(this.forward) > 0) return;
    const cfg = this.spec.ai;
    const R = cfg.wakeRadius * this.length;
    const d2 = this.closestBodyPoint(player.position, _v3);
    if (d2 > R * R) return;
    const d = Math.sqrt(d2);
    // Linear falloff: the megalodon's displacement is felt well off its flank.
    const f = (1 - d / R) * this.speed * cfg.wakeStrength;
    _v.subVectors(player.position, _v3);
    if (_v.lengthSq() < 1e-6) _v.copy(this.right);
    _v.normalize();
    player.velocity?.addScaledVector(this.forward, f * 0.7 * dt).addScaledVector(_v, f * 0.6 * dt);
    if (this.isBoss || d < 2.5) {
      // A sustained rumble (max-combined, not stacked) so the wake never eats
      // the trauma headroom of attacks and roars.
      const rig = this.game.cameraRig;
      const amt = Math.min(0.5, f * (this.isBoss ? 0.035 : 0.05));
      if (rig?.addRumble) rig.addRumble(amt, 0.35);
      else rig?.addTrauma?.(Math.min(0.5, f * dt * (this.isBoss ? 0.12 : 0.05)));
    }
  }

  _addWound(point) {
    // Anchor the wound to the closest hurtbox bone so it travels with the body.
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.hurtboxes.length; i++) {
      const d = this.hurtboxes[i].center.distanceToSquared(point);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const bone = this._hbDefs[best].bone;
    const w = this.wounds[this._woundNext];
    this._woundNext = (this._woundNext + 1) % MAX_WOUNDS;
    _mInv.copy(this.bones[bone].matrixWorld).invert();
    w.bone = bone;
    w.local.copy(point).applyMatrix4(_mInv);
    w.active = true;
  }

  _woundWorld(w, out) {
    return out.copy(w.local).applyMatrix4(this.bones[w.bone].matrixWorld);
  }

  _bleed(dt) {
    const vfx = this.game.vfx;
    if (!vfx?.spawnBlood) return;
    this._bleedTimer -= dt;
    const frac = this.health / this.maxHealth;
    if (this._eyeBleed > 0) {
      this._eyeBleed -= dt;
      if (this._bleedTimer <= 0) {
        const eye = this.hurtboxes[this._eyeBleedSide] ?? this.hurtboxes[0];
        vfx.spawnBlood(eye.center, this.forward, 0.35);
      }
    }
    let rate = 0;
    if (!this.alive) rate = this._deathT < 14 ? 0.22 : 0;
    else if (this.isBoss && this.ai.phase >= 3) rate = 0.25;
    else if (frac < 0.3) rate = 0.45;
    if (rate > 0 && this._bleedTimer <= 0) {
      let amount = 0.3;
      if (!this.alive) amount = 0.6 * (1 - this._deathT / 14);
      // Pick a wound (or the gills) to trickle from.
      let n = 0;
      for (let i = 0; i < MAX_WOUNDS; i++) if (this.wounds[i].active) n++;
      if (n > 0) {
        let pick = (Math.random() * n) | 0;
        for (let i = 0; i < MAX_WOUNDS; i++) {
          if (!this.wounds[i].active) continue;
          if (pick-- === 0) {
            this._woundWorld(this.wounds[i], _v);
            break;
          }
        }
      } else _v.copy(this.hurtboxes[2]?.center ?? this.position);
      vfx.spawnBlood(_v, this.up, Math.max(0.1, amount) * (this.isBoss ? 1.6 : 1));
      this._bleedTimer = rate;
    } else if (this._bleedTimer <= 0) {
      this._bleedTimer = this._eyeBleed > 0 ? 0.18 : 0.3;
    }
  }

  // ------------------------------------------------------------------ death

  _die() {
    this.alive = false;
    this.health = 0;
    this.vulnerable = false;
    this.clearVolumes();
    if (this.grabbedPlayer) {
      const p = this.grabbedPlayer;
      this.grabbedPlayer = null;
      if (p.grabbedBy === this) p.setGrabbed?.(null);
    }
    this.ai.onDeath();
    this.state = 'dying';
    this._deathT = 0;
    this._deathRoll = (Math.random() < 0.5 ? -1 : 1) * Math.PI;
    this._sinkVel = 0;
    this._bleedTimer = 0;
    this.game.vfx?.spawnBlood?.(this._mouth, this.up, this.isBoss ? 3 : 2);
  }

  _updateDeath(dt) {
    this._deathT += dt;
    const t = this._deathT;
    const T = this.poseT;
    resetPose(T);
    // A few dying tail spasms, then stillness.
    T.amp = 0.9 * Math.exp(-t * 0.8);
    T.freqScale = 1.5;
    T.jaw = 0.45;
    T.jawOpenRate = 1.5;
    T.eyeRoll = 1;
    T.pecDrop = 0.35;
    T.protrude = 0.25;
    T.extraRoll = this._deathRoll * smoothstep(0.4, 5.0, t);
    T.rollRate = 1.4;
    if (this._settled) return;
    // Water drag on a limp body: a kill at speed coasts a few metres, not
    // 40 m out of the victory shot.
    this.speed *= Math.exp(-CORPSE_DRAG * dt);
    // The boss rolls belly-up drifting UP toward the light for its first
    // seconds (killed deep in the dark, the payoff must stay lit), then sinks.
    const sinkMax = this.isBoss ? 1.8 : 1.35;
    const rise = this.isBoss ? BOSS_RISE * smoothstep(-15, -25, this.position.y) * (1 - smoothstep(4, 7, t)) : 0;
    const sinkTarget = rise > 0 ? rise : -sinkMax;
    this._sinkVel += (sinkTarget - this._sinkVel) * (1 - Math.exp(-dt * 0.5));
    const st = this.steer;
    st.target.copy(this.position).addScaledVector(this.forward, 10);
    st.target.y -= 2.5;
    st.speed = 0;
    st.decel = 0.7;
    st.accel = 1;
    st.turnBoost = 0.25;
    st.maxPitch = 0.35;
  }

  _settle() {
    this._settled = true;
    this.state = 'dead';
    this._sinkVel = 0;
    this.speed = 0;
    this.drift.set(0, 0, 0);
    _v.copy(this.position);
    _v.y = this._floorAt(_v.x, _v.z);
    this.game.vfx?.spawnImpact?.(_v, UP, { strength: this.isBoss ? 3 : 1.5 });
    this.game.vfx?.spawnBubbles?.(this.position, this.isBoss ? 40 : 18, { speed: 1.2, size: 1 });
  }
}

const EMPTY = Object.freeze([]);
const BODY_SAMPLES = [BONE.head, BONE.root, BONE.sp2, BONE.sp4, BONE.sp6, BONE.sp8];
