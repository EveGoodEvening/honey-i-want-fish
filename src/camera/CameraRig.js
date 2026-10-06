// CameraRig — see docs/DESIGN.md "CameraRig".
//
// Third-person over-the-right-shoulder follow camera with mouse look,
// lock-on, seabed/surface/body collision, trauma shake, FOV kicks and an
// underwater sway; plus cinematic cameras for title / intro / death /
// victory chosen from game.state, blended smoothly on every change.
//
// Conventions: yaw = 0 looks down -Z; positive pitch looks up. The camera's
// look direction is the move-basis forward (shake excluded) plus a small
// view-only threat-framing orbit (≤ 0.14 rad yaw — 0.42 while the lock target
// itself winds up / lunges — and 0.08 rad pitch): when a shark telegraphs /
// lunges (or the lock target is close), the rig widens the shoulder offset,
// raises the pivot and orbits so the attacker's mouth sits toward ~62 % of the
// screen width instead of hiding behind 老公.
//
// Lock-on turns the rig toward the target's body centre with a gain that
// fades with its horizontal range and a capped turn rate (LOCK_YAW_RATE): a
// shark brushing past within a few metres, or passing overhead where its
// bearing spins, holds the yaw instead of whip-panning the view. 老公's death
// drops the lock, so the dying beat is a steady follow shot. A locked
// megalodon biting / ramming from close range is the exception: the lock
// then turns the rig itself until its jaws sit at ~60 % of the width (the
// view-only orbit alone is too small for a 16 m body seen broadside); its
// sideways head-snap at prey beside its gills is framed from the side, the
// boom run out and the lens opened up (see JAW_SNAP_*).
//
// Megalodon framing: a moderate pull-back (BOSS_DIST) with a low camera
// looking up, a telephoto FOV that narrows as the boss closes in, a dolly-in
// and push-in over its bite / ram telegraph, push-in kicks (never FOV
// widening) on roars, and a rumble when the huge body passes close. Its body
// never pulls the camera in closer than BOSS_COLLIDE_MIN, and when the view
// tilts up (at it, overhead) near the seabed the boom is raised rather than
// pulled in to 老公's back; there the low boss camera drop is skipped, and a
// boom the seabed still shortens narrows the shoulder offset and the threat
// orbit so 老公 stays inside the left half of the frame.
//
// In the breather before the boss (after the tiger wave's wave:clear) the
// view levels out toward the horizon once the lock drops — where the sperm
// whale passes — unless the player is steering it with the mouse.
//
// Mode changes blend position (lerp), orientation (slerp) and FOV from the
// pose at the change over BLEND[from>to] seconds.
import * as THREE from 'three';
import { WORLD, WAVES } from '../core/config.js';
import { CameraShake } from './CameraShake.js';
import {
  titlePose, introPose, deadPose, initDeadPose, victoryPose, findTitleFocus, findDeadBoss, INTRO_DIVE_AT, DEAD_KILLER_RANGE,
} from './cinematics.js';
import { raySphereEntry } from '../combat/hitTests.js';

const MOUSE_SENS = 0.0022; // rad per pixel
const PITCH_LIMIT = 1.35;
const BASE_DIST = 3.8;
const BOSS_DIST = 5.6;
const BOSS_TELE_DIST = 3.8; // dolly-in target over a boss bite / ram telegraph
const BOSS_TELE_KICK = -11; // degrees of FOV push-in over that telegraph (jaws ≥ 30 % of the frame height)
const BOSS_TELE_RANGE = 20;
const BOSS_TELEPHOTO = 7; // degrees narrower FOV as the boss closes in (30 m → 8 m)
const SHOULDER = 0.55;
const PIVOT_UP = 0.45;
// threat framing (see header)
const THREAT_SHOULDER = 1.15;
const THREAT_PIVOT_UP = 0.85;
const THREAT_YAW = 0.14;
const THREAT_YAW_LOCK = 0.42; // … while the lock target itself telegraphs / attacks (see _aimThreat)
const THREAT_PITCH = 0.08;
const THREAT_SCREEN_X = 0.24; // NDC x the threat is framed at (62 % of the width)
const THREAT_RANGE = 20; // pick range for a committed attacker (no lock)
const THREAT_NEAR = 15; // a threat this close raises the framing even when idle
const THREAT_MEMORY = 1.0; // seconds an enemy:telegraph keeps its sender the threat
const MIN_DIST = 0.6;
const BOSS_COLLIDE_MIN = 3; // the megalodon's body never pulls the camera closer (see _collide)
const BOOM_NEED = 3.2; // boom length the seabed lift tries to keep (m) …
const BOOM_LIFT_MAX = 0.6; // … raising the boom by at most this (rad) …
const BOOM_LIFT_RATE = 2; // … at up to this many rad/s
const BOOM_EASE = 2.5; // 1/s: the boom length the shoulder / orbit narrowing follows (see _boomEase)
const BOSS_DROP = 0.7; // the low boss camera sits this far below the shoulder (m) …
const BOSS_DROP_CLEAR = [1.2, 3.2]; // … faded out as the pivot comes this close to the seabed (m)
const LOCK_RANGE = 60;
const LOCK_BREAK = 75;
// lock tracking (see _trackLock)
const LOCK_GAIN = 6; // 1/s at range …
const LOCK_GAIN_H = [2, 8]; // … faded in over this horizontal distance to the target (m) …
const LOCK_GAIN_H_COMMITTED = [1.2, 5]; // … this one while it winds up / attacks
const LOCK_HOLD_NEAR = 4; // the lock yaw holds while the target is closer than this (m) …
const LOCK_HOLD_ELEV = [0.85, 1.05]; // … or (nearly) overhead / underneath (rad of elevation)
const LOCK_YAW_RATE = 3; // rad/s the lock may turn the rig at most …
const LOCK_PITCH_RATE = 1.6; // … and tilt it
// A locked boss winding up / lunging a bite or ram frames its jaws, fully once
// its mouth is within JAW_RANGE[1] of 老公 (faded in from JAW_RANGE[0], m) …
const JAW_RANGE = [16, 10];
const JAW_SCREEN_X = 0.2; // … at this NDC x (60 % of the width) …
const JAW_YAW_MAX = 1.3; // … turning the rig by at most this past its current yaw (rad) …
const JAW_YAW_RATE = 3.5; // … at up to this many rad/s …
const JAW_PITCH_RATE = 2.4; // … and tilting it at up to this many
// A locked boss side-snap (a head whip at prey tucked in beside its gills,
// usually ~3 m under it) is framed fully from its telegraph on, whatever the
// mouth distance: the look leans across the head (broadside, never head-on
// under the overhanging snout) and tilts to where the jaws will close (see
// _trackLock / _jawAim). The shot opens up at JAW_SNAP_OPEN 1/s: the boom
// runs out to JAW_SNAP_DIST instead of dollying in, the lens stays near
// shoulder height (boom pitch ≤ JAW_SNAP_BOOM rad: lifted rather than swung
// down under 老公), and the telephoto and the telegraph push-in drop out.
const JAW_SNAP_SIDE = 1.5; // m the look leans toward 老公's flank of the boss
const JAW_SNAP_DIST = 8;
const JAW_SNAP_BOOM = 0.12;
const JAW_SNAP_OPEN = 6;
// boss breather: level the view toward the horizon (see header)
const LEVEL_PITCH = 0.05;
const LEVEL_RATE = 2; // 1/s (≈95 % in 1.5 s)
const LEVEL_MOUSE = 0.6; // px of mouse movement in a frame that hands the view back to the player

const MODE_OF = {
  boot: 'title',
  title: 'title',
  intro: 'intro',
  playing: 'follow',
  transition: 'follow',
  dead: 'dead',
  victory: 'victory',
};

const BLEND = {
  'title>intro': 2.2,
  'intro>follow': 1.0,
  'title>follow': 1.4,
  'follow>dead': 1.1,
  'dead>follow': 1.1,
  'follow>victory': 1.3,
  'dead>title': 2.0,
  'victory>title': 2.0,
  'follow>title': 2.0,
};

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _shoulder = new THREE.Vector3();
const _back = new THREE.Vector3();
const _bd = new THREE.Vector3();
const _look = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _qTo = new THREE.Quaternion();
const _vTo = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _ndc = new THREE.Vector3();
const _tw = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _hp = new THREE.Vector3(); // a side-snapping boss's head pivot (see _jawAim)

function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

function damp(k, dt) {
  return 1 - Math.exp(-k * dt);
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Horizontal screen angle (rad, + = right) of a point at bearing `phi` and
 * range `R` from the pivot, seen from a camera `dist` behind the pivot and
 * `shoulder` to its right, after orbiting the rig left by `beta`.
 */
function frameAngle(R, phi, beta, dist, shoulder) {
  return Math.atan2(R * Math.sin(phi + beta) - shoulder, R * Math.cos(phi + beta) + dist);
}

export class CameraRig {
  constructor(game) {
    this.game = game;
    this.camera = game.camera;
    this.baseFov = game.camera.fov || 62;

    this._yaw = 0;
    this._pitch = -0.12;
    this._yawT = 0;
    this._pitchT = -0.12;
    this.lockTarget = null;
    this._lockOffYaw = 0;
    this._lockOffPitch = 0;

    this.shake = new CameraShake();
    this._basis = { forward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) };

    // follow state
    this._pivot = new THREE.Vector3();
    this._pivotReady = false;
    this._dist = BASE_DIST;
    this._distCol = BASE_DIST;
    this._boomLen = BASE_DIST; // boom length actually used last frame (after collision) …
    // … eased (BOOM_EASE): what narrows the shoulder / threat orbit on a short
    // boom. The raw length would feed back — a narrower shoulder moves the boom
    // origin, which changes the collision, which changes the length — and
    // flicker the view between two framings every frame.
    this._boomEase = BASE_DIST;
    this._boomLift = 0; // rad the boom is raised over the seabed (see _updateFollow)
    this._jawSnap = 0; // 0..1 jaw weight of a locked boss side-snap this frame (see _trackLock)
    this._jawOpen = 0; // 0..1 smoothed: the lens opening for it (see JAW_SNAP_*)
    this._level = false; // boss breather: level the view (see header)
    this._boss = 0;
    this._bossClose = 0; // 0..1 telephoto as the megalodon closes in
    this._dolly = 0; // 0..1 boss-telegraph dolly-in
    this._dollyRate = 1; // per second; + while winding up, release over 1 s
    this._dollyTarget = 0;
    this._dollyEnemy = null;
    this._grab = 0;
    this._charge = 0; // smoothed heavy-charge level (push-in while winding up)
    this._chargeTarget = 0;
    this._chargeLevel = 0; // last player:heavyCharge level / 3

    // threat framing
    this._threatK = 0;
    this._threatYaw = 0; // unscaled yaw orbit wanted for the current threat
    this._lockOrbitMax = THREAT_YAW_LOCK; // orbit limit while the lock target attacks (see _aimThreat)
    this._teleEnemy = null; // sender of the last enemy:telegraph …
    this._teleAt = -Infinity; // … and when (real seconds)
    this._time = 0; // real seconds
    this._followPos = new THREE.Vector3();
    this._followLook = new THREE.Vector3();
    this._followQuat = new THREE.Quaternion();
    this._followFov = this.baseFov;

    // mode + blending
    this._mode = null;
    this._modeT = 0;
    this._ctx = {
      focus: new THREE.Vector3(),
      hasFocus: false,
      side: new THREE.Vector3(1, 0, 0),
      back: new THREE.Vector3(0, 0, 1),
      radius: 4,
      elev: 0.2,
      azimuth: 0,
      height: 1,
      diveAt: INTRO_DIVE_AT, // intro: modeT of the dive cue
      killer: null, // dead: the shark that killed 老公 (framed with him)
      killerLook: new THREE.Vector3(), // dead: smoothed killer position
      killerW: 0, // dead: 0..1 how much the killer is framed (smoothed, by distance)
      az: 0, // dead: current camera azimuth around the body
      deadSide: 1, // dead: which side of the body→killer line the camera swings to
      corpse: null, // victory: the dead megalodon
      vicReady: false, // victory: camera bearing / elevation picked (see victoryPose) …
      vicAz: 0, // … bearing from 老公 (rad, atan2(x, z)) …
      vicElev: 0.2, // … elevation (rad) …
      vicAzS: 0, // … both eased toward after a re-pick
      vicElevS: 0.2,
      vicB0: new THREE.Vector3(), // corpse centroid when the shot was picked
      vicT: 0, // last victoryPose time (s)
      vicNext: 0, // earliest re-pick time (s)
      entryPos: new THREE.Vector3(), // camera position when the mode started
    };
    this._blendFromPos = new THREE.Vector3();
    this._blendFromQuat = new THREE.Quaternion();
    this._blendFromFov = this.baseFov;
    this._blendT = 0;
    this._blendDur = 0;

    // pose before shake
    this._pos = new THREE.Vector3().copy(game.camera.position);
    this._quat = new THREE.Quaternion().copy(game.camera.quaternion);
    this._fov = this.baseFov;

    this._bind(game.events);
  }

  // ---------------------------------------------------------------------------
  // Contract API
  // ---------------------------------------------------------------------------

  get yaw() {
    return this._yaw;
  }

  set yaw(v) {
    this._yaw = v;
    this._yawT = v;
  }

  get pitch() {
    return this._pitch;
  }

  set pitch(v) {
    const p = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, v));
    this._pitch = p;
    this._pitchT = p;
  }

  /** forward = camera look direction incl. pitch; right = horizontal right; up = world up. */
  getMoveBasis() {
    const b = this._basis;
    const cp = Math.cos(this._pitch);
    b.forward.set(-Math.sin(this._yaw) * cp, Math.sin(this._pitch), -Math.cos(this._yaw) * cp);
    b.right.set(Math.cos(this._yaw), 0, -Math.sin(this._yaw));
    b.up.set(0, 1, 0);
    return b;
  }

  addTrauma(amount) {
    this.shake.addTrauma(amount);
  }

  kickFov(deltaDegrees, duration = 0.4, attack = 0.08) {
    this.shake.kickFov(deltaDegrees, duration, attack);
  }

  /** (extra) sustained shake that fades over `duration` (roars, near passes). */
  addRumble(amount, duration = 1) {
    this.shake.addRumble(amount, duration);
  }

  /** Lock onto the enemy nearest the screen centre (within 60 m), or release. */
  toggleLock() {
    if (this.lockTarget) {
      this.lockTarget = null;
      return null;
    }
    const game = this.game;
    const enemies = game.enemies?.enemies;
    const player = game.player;
    // no new lock during the dying beat (player:death dropped the old one)
    if (!enemies || !player || player.alive === false) return null;
    const cam = this.camera;
    cam.updateMatrixWorld();
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e?.alive) continue;
      const d = e.position.distanceTo(player.position);
      if (d > LOCK_RANGE) continue;
      _ndc.copy(e.position).project(cam);
      const onScreen = _ndc.z < 1 && Math.abs(_ndc.x) < 1.1 && Math.abs(_ndc.y) < 1.1;
      // on-screen enemies always win; otherwise fall back to the nearest
      const score = onScreen ? Math.hypot(_ndc.x, _ndc.y) + d * 0.004 : 10 + d / LOCK_RANGE;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    this.lockTarget = best;
    this._lockOffYaw = 0;
    this._lockOffPitch = 0;
    return best;
  }

  // ---------------------------------------------------------------------------

  _bind(events) {
    events.on('player:hit', ({ damage = 10, heavy = false } = {}) => {
      this.addTrauma(Math.min(0.8, 0.18 + damage / 45 + (heavy ? 0.2 : 0)));
      this.kickFov(-2, 0.3, 0.04);
    });
    // Heavy charge: a slow, monotonic push-in held for as long as the charge
    // is (levels 0..3 arrive at 0 / 0.4 / 0.9 / 1.5 s; see _updateFollow).
    events.on('player:heavyCharge', ({ level = 0 } = {}) => {
      this._chargeLevel = Math.max(0, Math.min(1, level / 3));
    });
    events.on('player:dodge', () => {
      this.kickFov(6, 0.45, 0.06);
      this.addTrauma(0.05);
    });
    events.on('player:attack', ({ type } = {}) => {
      if (type === 'heavy') {
        this._chargeLevel = 0;
        this._chargeTarget = 0;
        this.kickFov(4, 0.38, 0.05);
      }
      else this.addTrauma(0.025);
    });
    // Roar: a push-in, never a widening — the megalodon must not shrink at
    // its most threatening moment.
    events.on('enemy:roar', ({ enemy } = {}) => {
      this.addTrauma(0.3 + 0.1 * (enemy?.ai?.phase ?? 1));
      this.addRumble(0.3, 2.0);
      this.kickFov(-6, 1.2, 0.3);
    });
    events.on('enemy:telegraph', ({ enemy, type, duration } = {}) => {
      const p = this.game.player;
      if (!enemy?.position || !p) return;
      const d = enemy.position.distanceTo(p.position);
      if (d > 35) return;
      this._teleEnemy = enemy;
      this._teleAt = this._time;
      const dur = duration ?? 0.6;
      if (enemy.isBoss && d < BOSS_TELE_RANGE + (enemy.length ?? 16) * 0.25 && (type === 'bite' || type === 'ram')) {
        // dolly in over the wind-up and narrow the lens: the jaws fill the frame
        this._dollyEnemy = enemy;
        this._dollyTarget = 1;
        this._dollyRate = 1 / Math.max(0.2, dur);
        this.kickFov(BOSS_TELE_KICK, dur + 0.5, dur * 0.95); // peaks as the jaws launch
      } else {
        // a slow push-in while the attack winds up: tension
        this.kickFov(enemy.isBoss || d <= 20 ? -4 : -2.5, dur + 0.35, dur * 0.8);
      }
    });
    events.on('enemy:attack', ({ enemy } = {}) => {
      const p = this.game.player;
      if (!enemy?.position || !p) return;
      if (enemy === this._dollyEnemy) this._releaseDolly();
      const range = 10 + (enemy.length ?? 5);
      const d = enemy.position.distanceTo(p.position);
      if (d < range) this.addTrauma((enemy.isBoss ? 0.35 : 0.3) * (1 - d / range));
    });
    events.on('grab:start', () => this.kickFov(-6, 0.8, 0.1));
    // the intro's dive starts on the Director's cue (keeps picture and sound in sync)
    events.on('cinematic', ({ name } = {}) => {
      if (name === 'dive' && this._mode === 'intro') this._ctx.diveAt = this._modeT;
    });
    events.on('player:death', () => {
      this.addTrauma(0.5);
      // The dying beat (follow mode until 'dead') holds a steady shot: a lock
      // kept on a shark circling the body 3–4 m away would spin the view.
      this.lockTarget = null;
      // remember who did it (the shark that landed the last hit, else the
      // nearest): the death camera frames the killer too
      const g = this.game;
      const p = g.player?.position;
      const by = g.enemies?.lastHitBy;
      this._ctx.killer = !p ? null
        : by?.alive && by.position && by.position.distanceTo(p) < 45 ? by
          : g.enemies?.getNearest?.(p, 45) ?? null;
    });
    events.on('enemy:death', ({ enemy } = {}) => {
      if (enemy?.isBoss) this.addRumble(0.3, 2.5);
    });
    // the breather before the boss wave: level the view for the whale pass
    events.on('wave:clear', ({ index } = {}) => {
      if (Number.isInteger(index) && WAVES[index + 1]?.boss) this._level = true;
    });
    events.on('wave:start', () => {
      this._level = false;
    });
  }

  update(dt) {
    const game = this.game;
    const state = game.state;
    if (state === 'paused') return; // freeze

    const realDt = game.time.realDt || 1 / 60;
    this._time += realDt;
    const mode = MODE_OF[state] ?? 'follow';
    if (mode !== this._mode) this._enterMode(mode);
    this._modeT += realDt;

    if (mode === 'follow') {
      if (state === 'playing' && game.input.pressed('lock')) this.toggleLock();
      this._updateFollow(realDt, true);
      this._pos.copy(this._followPos);
      this._quat.copy(this._followQuat);
      this._fov = this._followFov;
    } else if (mode === 'intro') {
      this._updateFollow(realDt, false);
      const fov = introPose(game, this._modeT, this._ctx, this._followPos, this._followLook, this._pos, _look);
      this._lookQuat(this._pos, _look, this._quat);
      this._fov = fov;
    } else {
      let fov;
      if (mode === 'title') fov = titlePose(game, this._modeT, this._ctx, this._pos, _look);
      else if (mode === 'dead') {
        const killer = this._ctx.killer;
        if (killer?.position) this._ctx.killerLook.lerp(killer.position, damp(2, realDt));
        fov = deadPose(game, this._modeT, this._ctx, this._pos, _look, realDt);
      }
      else fov = victoryPose(game, this._modeT, this._ctx, this._pos, _look);
      this._keepInWater(this._pos);
      this._lookQuat(this._pos, _look, this._quat);
      this._fov = fov;
    }

    // blend from the pose we had when the mode changed
    if (this._blendT < this._blendDur) {
      this._blendT += realDt;
      const k = Math.min(1, this._blendT / this._blendDur);
      const e = k * k * (3 - 2 * k);
      // The targets are this frame's mode pose, which is also the output: copy
      // them first. three's slerpQuaternions(qa, qb) is copy(qa).slerp(qb), so
      // with qb === this it would return qa every frame (no rotation during the
      // blend, then a one-frame snap when it ends).
      _vTo.copy(this._pos);
      _qTo.copy(this._quat);
      this._pos.lerpVectors(this._blendFromPos, _vTo, e);
      this._quat.slerpQuaternions(this._blendFromQuat, _qTo, e);
      this._fov = this._blendFromFov + (this._fov - this._blendFromFov) * e;
    }

    this._applyShake(realDt, mode);
  }

  // ---------------------------------------------------------------------------
  // Modes
  // ---------------------------------------------------------------------------

  _enterMode(mode) {
    const game = this.game;
    const prev = this._mode;
    const cam = this.camera;
    this._mode = mode;
    this._modeT = 0;

    // blend from the current (un-shaken) pose
    this._blendFromPos.copy(prev ? this._pos : cam.position);
    this._blendFromQuat.copy(prev ? this._quat : cam.quaternion);
    this._blendFromFov = prev ? this._fov : cam.fov;
    this._blendT = 0;
    this._blendDur = prev ? BLEND[`${prev}>${mode}`] ?? 1.2 : 0;

    if (mode !== 'follow') {
      this.lockTarget = null;
      this._level = false;
    }
    const ctx = this._ctx;
    const p = game.player?.position;

    if (mode === 'title') {
      ctx.hasFocus = findTitleFocus(game.env, ctx.focus);
    } else if (mode === 'intro' || (mode === 'follow' && prev !== 'intro')) {
      // start behind 老公's facing
      this._faceBehindPlayer();
      this._pivotReady = false;
      this._dist = BASE_DIST;
      this._distCol = BASE_DIST;
      this._resetFraming();
      ctx.side.set(Math.cos(this._yaw), 0, -Math.sin(this._yaw));
      ctx.back.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
      // re-synced by the Director's {name:'dive'} cinematic event
      ctx.diveAt = INTRO_DIVE_AT;
    } else if ((mode === 'dead' || mode === 'victory') && p) {
      _v.subVectors(this._pos, p);
      const len = Math.max(0.5, _v.length());
      ctx.radius = Math.min(10, len);
      ctx.elev = Math.asin(Math.max(-1, Math.min(1, _v.y / len)));
      ctx.azimuth = Math.atan2(_v.x, _v.z);
      ctx.height = _v.y;
      if (mode === 'dead') {
        // the shark that did it (player:death normally caught it already); one
        // that has swum off beyond framing range gives way to a nearer shark
        let k = ctx.killer;
        if (!k?.alive || !game.enemies?.enemies?.includes(k)) k = null;
        if (!k || k.position.distanceTo(p) > DEAD_KILLER_RANGE) k = game.enemies?.getNearest?.(p, DEAD_KILLER_RANGE) ?? k;
        ctx.killer = k;
        if (k) ctx.killerLook.copy(k.position);
        initDeadPose(game, ctx);
      } else {
        ctx.corpse = findDeadBoss(game);
        ctx.vicReady = false;
        ctx.entryPos.copy(this._blendFromPos);
      }
    }
  }

  _resetFraming() {
    this._threatK = 0;
    this._threatYaw = 0;
    this._teleEnemy = null;
    this._dolly = 0;
    this._releaseDolly();
    this._charge = 0;
    this._chargeLevel = 0;
    this._chargeTarget = 0;
    this._bossClose = 0;
    this._boomLift = 0;
    this._boomLen = BASE_DIST;
    this._boomEase = BASE_DIST;
    this._level = false;
    this._jawSnap = 0;
    this._jawOpen = 0;
  }

  _faceBehindPlayer() {
    const f = this.game.player?.forward?.();
    if (f && (f.x * f.x + f.z * f.z) > 1e-4) this.yaw = Math.atan2(-f.x, -f.z);
    this.pitch = -0.12;
  }

  _updateFollow(dt, allowInput) {
    const game = this.game;
    const player = game.player;
    const input = game.input;

    // ---- look input ----
    const target = this._validateLock();
    if (allowInput) {
      const dx = input.mouseDX * MOUSE_SENS;
      const dy = input.mouseDY * MOUSE_SENS;
      // the player steering the view ends the breather's levelling
      if (this._level && Math.abs(input.mouseDX) + Math.abs(input.mouseDY) > LEVEL_MOUSE) this._level = false;
      if (target) {
        // while locked the mouse only nudges the framing a little
        this._lockOffYaw = Math.max(-0.5, Math.min(0.5, this._lockOffYaw - dx * 0.6));
        this._lockOffPitch = Math.max(-0.4, Math.min(0.4, this._lockOffPitch - dy * 0.6));
      } else {
        this._yawT -= dx;
        this._pitchT = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this._pitchT - dy));
      }
    }
    this._lockOffYaw *= Math.exp(-dt * 1.5);
    this._lockOffPitch *= Math.exp(-dt * 1.5);

    // ---- threat framing weight (see header) ----
    const threat = this._pickThreat(target, player);
    let wantK = 0;
    if (threat) {
      const st = threat.ai?.state;
      const tp = threat.getMouthPosition?.() ?? threat.position;
      const d = Math.min(tp.distanceTo(player.position), threat.position.distanceTo(player.position));
      wantK = st === 'telegraph' || st === 'attack' || d < THREAT_NEAR ? 1 : 0;
    }
    this._threatK += (wantK - this._threatK) * damp(wantK > this._threatK ? 6 : 2, dt);
    const K = this._threatK;

    // ---- pivot ----
    const pivotUp = PIVOT_UP + (THREAT_PIVOT_UP - PIVOT_UP) * K;
    _v.set(player.position.x, player.position.y + pivotUp, player.position.z);
    if (!this._pivotReady || this._pivot.distanceToSquared(_v) > 64) {
      this._pivot.copy(_v);
      this._pivotReady = true;
    } else {
      this._pivot.lerp(_v, damp(14, dt));
    }

    // ---- lock-on tracking: frame 老公 in front, the target beyond ----
    this._jawSnap = 0;
    if (target) this._trackLock(target, K, dt);
    else if (this._level) this._pitchT += (LEVEL_PITCH - this._pitchT) * damp(LEVEL_RATE, dt);
    this._jawOpen += (this._jawSnap - this._jawOpen) * damp(JAW_SNAP_OPEN, dt);
    const open = this._jawOpen;

    // keep angles bounded, then smooth toward the targets
    if (Math.abs(this._yawT) > Math.PI * 16) {
      const wrap = Math.round(this._yawT / (Math.PI * 2)) * Math.PI * 2;
      this._yawT -= wrap;
      this._yaw -= wrap;
    }
    this._yaw += (this._yawT - this._yaw) * damp(24, dt);
    this._pitch += (this._pitchT - this._pitch) * damp(24, dt);

    // ---- megalodon: pull back a little, drop low, telephoto as it closes ----
    const boss = game.enemies?.getBoss?.();
    let bossT = 0;
    let closeT = 0;
    if (boss?.alive && boss.position) {
      const d = Math.max(0, boss.position.distanceTo(player.position) - (boss.length ?? 16) * 0.25);
      bossT = Math.min(1, Math.max(0, (48 - d) / 30));
      closeT = smoothstep(30, 8, d);
      // a huge body passing close makes the water itself shudder
      const spd = boss.velocity?.length?.() ?? boss.speed ?? 0;
      if (d < 18 && spd > 2.5) this.shake.addRumble(0.35 * (1 - d / 18) * Math.min(1, (spd - 2.5) / 4), 0.4);
    }
    this._boss += (bossT - this._boss) * damp(1.2, dt);
    this._bossClose += (closeT - this._bossClose) * damp(1.2, dt);
    this._updateDolly(dt, boss);

    this._grab += ((game.combat?.grab ? 1 : 0) - this._grab) * damp(3, dt);
    // heavy charge: hold the push-in for the whole wind-up, deepen per level
    this._chargeTarget = player.state === 'heavyCharge' ? Math.max(0.15, this._chargeLevel) : 0;
    this._charge += (this._chargeTarget - this._charge) * damp(this._chargeTarget > this._charge ? 3 : 12, dt);
    const danger = game.danger || 0;
    let desired = BASE_DIST + 0.9 * danger;
    desired += (BOSS_DIST - desired) * this._boss;
    desired += 1.3 * this._grab;
    this._dist += (desired - this._dist) * damp(1.6, dt);
    const dolly = this._dolly * this._dolly * (3 - 2 * this._dolly);
    let dist = this._dist + (Math.min(this._dist, BOSS_TELE_DIST) - this._dist) * dolly;
    dist += (Math.max(this._dist, JAW_SNAP_DIST) - dist) * open;

    // ---- threat orbit: put the attacker's mouth at ~62 % of the width ----
    // A boom the seabed keeps short would put a full shoulder offset (and the
    // orbit swinging the view past 老公) at the frame edge: narrow both, so he
    // stays inside the left half.
    const shoulder = Math.min(SHOULDER + (THREAT_SHOULDER - SHOULDER) * K, 0.45 * this._boomEase);
    if (threat) this._aimThreat(threat, dist, shoulder, dt);
    else this._threatYaw *= Math.exp(-dt * 2);
    // (a framed side-snap aims the rig itself: no second orbit on top)
    const yaw = this._yaw + this._threatYaw * K * smoothstep(1.2, 3.0, this._boomEase) * (1 - open);
    // the boss framing looks up at it instead of down
    const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this._pitch - THREAT_PITCH * K * (1 - this._boss)));

    // ---- placement ----
    _right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    _shoulder.copy(this._pivot).addScaledVector(_right, shoulder);
    // lower angle with the boss near: drop the camera so it looks up at it —
    // not when 老公 is down by the seabed (the drop would put the lens in it)
    const bed = game.env?.getSeabedHeight ? game.env.getSeabedHeight(this._pivot.x, this._pivot.z) : -Infinity;
    _shoulder.y -= BOSS_DROP * this._boss * smoothstep(BOSS_DROP_CLEAR[0], BOSS_DROP_CLEAR[1], this._pivot.y - bed) * (1 - open);
    // Looking up (at the megalodon overhead) points the boom down behind 老公,
    // and near the seabed that would drag the lens in to his back: raise the
    // boom instead (by the least that keeps BOOM_NEED free), tilting the view
    // down by half as much so he stays in frame.
    const need = Math.min(dist, BOOM_NEED);
    let wantLift = 0;
    const free0 = pitch > -0.3 ? this._boomFree(_shoulder, yaw, pitch, dist) : dist;
    if (free0 < need) {
      const freeMax = this._boomFree(_shoulder, yaw, pitch - BOOM_LIFT_MAX, dist);
      if (freeMax < need) wantLift = freeMax > free0 + 0.3 ? BOOM_LIFT_MAX : 0;
      else {
        let lo = 0;
        let hi = BOOM_LIFT_MAX;
        for (let i = 0; i < 5; i++) {
          const mid = (lo + hi) * 0.5;
          if (this._boomFree(_shoulder, yaw, pitch - mid, dist) >= need) hi = mid;
          else lo = mid;
        }
        wantLift = hi;
      }
    }
    // a framed side-snap overhead: keep the lens up near shoulder height
    if (open > 0) wantLift =Math.max(wantLift, open * clamp(pitch - JAW_SNAP_BOOM, 0, BOOM_LIFT_MAX));
    // (rate-capped: the view tilts by half the lift, so a fast rise is a whip pan)
    const liftStep = (wantLift - this._boomLift) * damp(wantLift > this._boomLift ? 10 : 1.5, dt);
    this._boomLift += clamp(liftStep, -BOOM_LIFT_RATE * dt, BOOM_LIFT_RATE * dt);
    const boomPitch = pitch - this._boomLift;
    const viewPitch = pitch - this._boomLift * 0.5;
    const cb = Math.cos(boomPitch);
    _back.set(Math.sin(yaw) * cb, -Math.sin(boomPitch), Math.cos(yaw) * cb);
    const free = this._collide(_shoulder, _back, dist);
    this._distCol += (free - this._distCol) * damp(free < this._distCol ? 18 : 2.5, dt);
    // pull-in is immediate (never sit inside geometry); easing back out is slow
    this._boomLen = Math.min(this._distCol, free);
    this._boomEase += (this._boomLen - this._boomEase) * damp(BOOM_EASE, dt);
    this._followPos.copy(_shoulder).addScaledVector(_back, this._boomLen);
    this._keepInWater(this._followPos);

    const cp = Math.cos(viewPitch);
    _fwd.set(-Math.sin(yaw) * cp, Math.sin(viewPitch), -Math.cos(yaw) * cp);
    _euler.set(viewPitch + 0.06 * this._boss, yaw, 0, 'YXZ');
    this._followQuat.setFromEuler(_euler);
    this._followLook.copy(this._followPos).addScaledVector(_fwd, 10);
    this._followFov = this.baseFov - BOSS_TELEPHOTO * this._bossClose * (1 - open) - 1.5 * danger * (1 - this._boss)
      - 2 * this._grab - 3.5 * this._charge;
  }

  /**
   * Lock-on: turn the rig's yaw / pitch targets toward the lock target's body
   * centre (老公 in front, the shark beyond). The gain fades in with the
   * target's horizontal distance and each step is rate-capped, and the yaw
   * holds while the target is within LOCK_HOLD_NEAR or (nearly) straight
   * above / below — there its bearing swings by radians per second (a shark
   * swimming off right after a grab, the megalodon passing overhead) and
   * following it would whip the view round just as the next threat needs
   * reading. A target winding up / attacking is not held (only rate-capped):
   * it must stay framed. A locked megalodon biting / ramming from close range
   * turns the rig until its jaws sit at JAW_SCREEN_X (see _jawWeight).
   */
  _trackLock(target, K, dt) {
    _w.subVectors(target.position, this._pivot);
    const h = Math.hypot(_w.x, _w.z);
    const d3 = _w.length();
    const elev = Math.atan2(_w.y, h);
    let dYaw = Math.atan2(-_w.x, -_w.z) + this._lockOffYaw;
    let dPitch = clamp(elev - 0.1 + this._lockOffPitch, -1.0, 0.95);
    // A close shark winding up / lunging is not swimming past: keep it framed
    // (the rate cap still bounds the turn).
    const st = target.ai?.state;
    const committed = st === 'telegraph' || st === 'attack';
    const reach = committed ? smoothstep(LOCK_GAIN_H_COMMITTED[0], LOCK_GAIN_H_COMMITTED[1], h) : smoothstep(LOCK_GAIN_H[0], LOCK_GAIN_H[1], h);
    const hold = committed ? 0 : Math.max(
      1 - smoothstep(LOCK_HOLD_NEAR, LOCK_HOLD_NEAR + 1.5, d3),
      smoothstep(LOCK_HOLD_ELEV[0], LOCK_HOLD_ELEV[1], Math.abs(elev)),
    );
    let gainY = LOCK_GAIN * reach * (1 - hold);
    let gainP = LOCK_GAIN * reach;
    let rateY = LOCK_YAW_RATE;
    let rateP = LOCK_PITCH_RATE;
    const jaw = this._jawWeight(target);
    if (jaw > 0) {
      // Aim at the jaws instead (see _jawAim): yaw so they land at
      // JAW_SCREEN_X (solved against the current rig), pitch at their
      // elevation seen from the lens (the body centre is often above 老公
      // while the head snaps in level).
      const snap = this._snapping(target);
      const aim = this._jawAim(target, snap, _aim);
      if (snap) {
        // A side-snap: look from 老公 across at the head pivot, leaning toward
        // the flank he is on — broadside to the head. The prey sits beside
        // the gills, so the body-centre lock (or centring the jaws) would
        // look at the boss head-on, its cocked snout hanging over the lens
        // (measured: the reticle off screen at a third of the close snaps).
        this._jawSnap = jaw;
        const r = target.right;
        _tw.subVectors(this._pivot, _hp);
        const side = _tw.x * r.x + _tw.y * r.y + _tw.z * r.z >= 0 ? JAW_SNAP_SIDE : -JAW_SNAP_SIDE;
        const hx = -_tw.x - r.x * side;
        const hz = -_tw.z - r.z * side;
        const off = clamp(wrapAngle(Math.atan2(-hx, -hz) - this._yaw), -JAW_YAW_MAX, JAW_YAW_MAX);
        dYaw += wrapAngle(this._yaw + off - dYaw) * jaw;
      } else {
        const shoulder = Math.min(SHOULDER + (THREAT_SHOULDER - SHOULDER) * K, 0.45 * this._boomEase);
        const orbit = this._frameOrbit(aim, this._boomLen, shoulder, JAW_SCREEN_X, JAW_YAW_MAX);
        dYaw += wrapAngle(this._yaw + orbit - dYaw) * jaw;
      }
      _tw.subVectors(aim, this._followPos);
      // view pitch = rig pitch − half the boom lift (+ the boss tilt; see placement)
      const mPitch = clamp(Math.atan2(_tw.y, Math.hypot(_tw.x, _tw.z)) + this._boomLift * 0.5 - 0.06 * this._boss, -1.0, 0.95);
      dPitch += (mPitch - dPitch) * jaw;
      gainY += (LOCK_GAIN - gainY) * jaw;
      gainP += (LOCK_GAIN - gainP) * jaw;
      rateY += (JAW_YAW_RATE - rateY) * jaw;
      rateP += (JAW_PITCH_RATE - rateP) * jaw;
    }
    const stepY = clamp(wrapAngle(dYaw - this._yawT) * damp(gainY, dt), -rateY * dt, rateY * dt);
    this._yawT += stepY;
    const stepP = clamp((dPitch - this._pitchT) * damp(gainP, dt), -rateP * dt, rateP * dt);
    this._pitchT += stepP;
  }

  /**
   * 0..1: how much a locked megalodon's jaws drive the lock — while it winds
   * up / lunges a bite or ram with its mouth within JAW_RANGE of 老公 (a
   * side-snap: fully). Its body centre sits 6–8 m behind the jaws, so a close
   * bite seen broadside keeps the head (and the reticle) off the frame edge
   * otherwise.
   */
  _jawWeight(target) {
    if (!target.isBoss || typeof target.getMouthPosition !== 'function') return 0;
    const ai = target.ai;
    const st = ai?.state;
    if (st !== 'telegraph' && st !== 'attack') return 0;
    if (ai.kind !== 'bite' && ai.kind !== 'ram') return 0;
    // a side-snap: fully, from its telegraph on (prey beside the jaws by definition)
    if (ai.kind === 'bite' && this._snapping(target)) return 1;
    const md = target.getMouthPosition().distanceTo(this.game.player.position);
    return smoothstep(JAW_RANGE[0], JAW_RANGE[1], md);
  }

  /** Is the boss's bite a sideways head-snap (SharkAI `snapping`; `_snap` until that getter exists)? */
  _snapping(target) {
    const ai = target.ai;
    return !!(ai?.snapping ?? ai?._snap);
  }

  /**
   * Where the jaws are framed → out. A lunging bite / ram: between the mouth
   * and the head (where the lock reticle sits). A side-snap: where the jaws
   * will close — midway between the head pivot and 老公's chest (or the
   * strike's forecast contact point, when the cue carries one) — which holds
   * still while the head cocks away and whips back, and keeps both the head
   * and him in frame.
   */
  _jawAim(target, snap, out) {
    if (snap) {
      // head pivot → _hp (where the head bone turns: spec headS along the body)
      const spec = target.spec;
      const k = spec && Number.isFinite(spec.sOrigin) && Number.isFinite(spec.headS) ? spec.sOrigin - spec.headS : 0.18;
      const player = this.game.player;
      const contact = target.getStrikeCue?.()?.contact;
      _hp.copy(target.position).addScaledVector(target.forward, k * (target.length ?? 16));
      return out.copy(_hp).lerp(contact?.isVector3 ? contact : player.hurtbox?.center ?? player.position, 0.5);
    }
    out.copy(target.getMouthPosition());
    const hbs = target.hurtboxes;
    if (hbs) {
      for (let i = 0; i < hbs.length; i++) {
        if (hbs[i].part === 'head') {
          out.lerp(hbs[i].center, 0.5);
          break;
        }
      }
    }
    return out;
  }

  /**
   * Yaw orbit (rad, + = left, relative to the current rig yaw, within ±lim)
   * that puts world point `tp` at NDC x `ndcX` for a camera `dist` behind the
   * pivot and `shoulder` to its right (a few Newton steps on frameAngle).
   */
  _frameOrbit(tp, dist, shoulder, ndcX, lim) {
    const yaw = this._yaw;
    _tw.subVectors(tp, this._pivot);
    const a = -_tw.x * Math.sin(yaw) - _tw.z * Math.cos(yaw); // along the view
    const b = _tw.x * Math.cos(yaw) - _tw.z * Math.sin(yaw); // to the right
    const R = Math.hypot(a, b);
    if (R < 0.3) return 0;
    const hd = dist * Math.cos(this._pitch);
    const phi = Math.atan2(b, a);
    const cam = this.camera;
    const tanH = Math.tan((cam.fov * Math.PI) / 360) * (cam.aspect || 16 / 9);
    const goal = Math.atan(ndcX * tanH);
    let beta = 0;
    for (let i = 0; i < 4; i++) {
      const f = frameAngle(R, phi, beta, hd, shoulder) - goal;
      const df = (frameAngle(R, phi, beta + 0.02, hd, shoulder) - frameAngle(R, phi, beta - 0.02, hd, shoulder)) / 0.04;
      if (Math.abs(df) < 1e-3) break;
      beta = clamp(beta - wrapAngle(f) / df, -lim, lim);
    }
    return beta;
  }

  /**
   * The enemy to keep framed: the lock target, else the nearest enemy
   * committed to an attack (telegraph / attack) within range, else the sender
   * of the last enemy:telegraph for a moment.
   */
  _pickThreat(lockTarget, player) {
    if (lockTarget) return lockTarget;
    const enemies = this.game.enemies?.enemies;
    if (!enemies) return null;
    let best = null;
    let bestD = THREAT_RANGE;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e?.alive || !e.position) continue;
      const st = e.ai?.state;
      if (st !== 'telegraph' && st !== 'attack') continue;
      const d = e.position.distanceTo(player.position);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (best) return best;
    const t = this._teleEnemy;
    if (t?.alive && this._time - this._teleAt < THREAT_MEMORY && enemies.includes(t)) return t;
    return null;
  }

  /**
   * Smoothly aim the threat orbit (this._threatYaw, unscaled by the framing
   * weight) so the threat's mouth lands at THREAT_SCREEN_X. Solved against the
   * un-orbited rig, so the orbit never feeds back into its own target.
   */
  _aimThreat(threat, dist, shoulder, dt) {
    const tp = threat.getMouthPosition?.() ?? threat.position;
    const yaw = this._yaw;
    _tw.subVectors(tp, this._pivot);
    const a = -_tw.x * Math.sin(yaw) - _tw.z * Math.cos(yaw); // along the view
    const b = _tw.x * Math.cos(yaw) - _tw.z * Math.sin(yaw); // to the right
    const R = Math.hypot(a, b);
    // Lock-on aims the rig straight down the attacker's line of approach (its
    // body centre beyond 老公), the worst case for hiding the jaws behind him:
    // while the lock target itself winds up / lunges the orbit may go wider.
    const st = threat.ai?.state;
    const lim = threat === this.lockTarget && (st === 'telegraph' || st === 'attack') ? this._lockOrbitMax : THREAT_YAW;
    let want = 0;
    if (R > 0.5) {
      const hd = dist * Math.cos(this._pitch);
      const phi = Math.atan2(b, a);
      const cam = this.camera;
      const tanH = Math.tan((cam.fov * Math.PI) / 360) * (cam.aspect || 16 / 9);
      const goal = Math.atan(THREAT_SCREEN_X * tanH);
      const t0 = frameAngle(R, phi, 0, hd, shoulder);
      const t1 = frameAngle(R, phi, lim, hd, shoulder);
      const slope = (t1 - t0) / lim;
      if (Math.abs(slope) > 1e-3) want = Math.max(-lim, Math.min(lim, (goal - t0) / slope));
      // only for threats ahead of the camera: turning 8° does not help one behind
      want *= smoothstep(-0.2, 0.5, a / R);
    }
    this._threatYaw += (want - this._threatYaw) * damp(4, dt);
  }

  /** Boss telegraph dolly: wind in over the telegraph, ease out over 1 s. */
  _updateDolly(dt, boss) {
    const e = this._dollyEnemy;
    if (e) {
      const st = e.ai?.state;
      // cancelled (staggered, killed, wave over) → let go
      if (!e.alive || e !== boss || (st && st !== 'telegraph' && st !== 'attack')) this._releaseDolly();
    }
    const step = this._dollyRate * dt;
    if (this._dolly < this._dollyTarget) this._dolly = Math.min(this._dollyTarget, this._dolly + step);
    else this._dolly = Math.max(this._dollyTarget, this._dolly - step);
  }

  _releaseDolly() {
    this._dollyEnemy = null;
    this._dollyTarget = 0;
    this._dollyRate = 1; // back out over 1 s
  }

  _validateLock() {
    const t = this.lockTarget;
    if (!t) return null;
    const game = this.game;
    const enemies = game.enemies?.enemies;
    if (!t.alive || !enemies || !enemies.includes(t) || t.position.distanceTo(game.player.position) > LOCK_BREAK) {
      this.lockTarget = null;
      return null;
    }
    return t;
  }

  /** Free boom length behind `origin` at boom pitch `p` (rad), against the seabed only. */
  _boomFree(origin, yaw, p, dist) {
    const c = Math.cos(p);
    _bd.set(Math.sin(yaw) * c, -Math.sin(p), Math.cos(yaw) * c);
    return this._seabedFree(origin, _bd, dist);
  }

  /** Free distance along `dir` from `origin`, up to `dist`, against the seabed. */
  _seabedFree(origin, dir, dist) {
    const env = this.game.env;
    if (!env?.getSeabedHeight) return dist;
    const steps = 8;
    let prevT = 0;
    for (let i = 1; i <= steps; i++) {
      const t = (dist * i) / steps;
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      const z = origin.z + dir.z * t;
      if (y < env.getSeabedHeight(x, z) + 0.5) {
        let lo = prevT;
        let hi = t;
        for (let j = 0; j < 4; j++) {
          const mid = (lo + hi) * 0.5;
          const mx = origin.x + dir.x * mid;
          const my = origin.y + dir.y * mid;
          const mz = origin.z + dir.z * mid;
          if (my < env.getSeabedHeight(mx, mz) + 0.5) hi = mid;
          else lo = mid;
        }
        return lo;
      }
      prevT = t;
    }
    return dist;
  }

  /** Free distance along `dir` from `origin`, up to `dist`, against seabed, surface and shark bodies. */
  _collide(origin, dir, dist) {
    const game = this.game;
    let best = this._seabedFree(origin, dir, dist);
    const ceil = WORLD.surfaceY - 0.25;
    if (dir.y > 1e-4) {
      const ts = (ceil - origin.y) / dir.y;
      if (ts < best) best = Math.max(0, ts);
    }
    // never park the camera inside a shark: if the camera point would be in a
    // body sphere, pull in to where the ray enters it. The megalodon may pull
    // it in only to BOSS_COLLIDE_MIN: its body sweeping past would otherwise
    // drag the lens right behind 老公's head, filling the frame and hiding its
    // own tail-whip wind-up — a brief near-plane clip of the passing body is
    // the lesser evil.
    const enemies = game.enemies?.enemies;
    if (enemies) {
      for (let e = 0; e < enemies.length; e++) {
        const en = enemies[e];
        const hbs = en?.hurtboxes;
        if (!hbs) continue;
        const minT = en.isBoss ? BOSS_COLLIDE_MIN : 0;
        if (minT >= best) continue;
        for (let h = 0; h < hbs.length; h++) {
          const hb = hbs[h];
          if (hb.radius < 0.5 || hb.part === 'eye') continue;
          const r = hb.radius + 0.3;
          _w.copy(origin).addScaledVector(dir, best);
          if (_w.distanceToSquared(hb.center) >= r * r) continue;
          const t = raySphereEntry(origin, dir, hb.center, r);
          if (t >= 0 && t < best) best = Math.max(t, minT);
        }
      }
    }
    return Math.max(MIN_DIST, best);
  }

  _keepInWater(pos) {
    const env = this.game.env;
    const floor = env?.getSeabedHeight ? env.getSeabedHeight(pos.x, pos.z) + 0.5 : -Infinity;
    const ceil = WORLD.surfaceY - 0.25;
    if (pos.y < floor) pos.y = floor;
    if (pos.y > ceil) pos.y = ceil;
  }

  _lookQuat(pos, target, out) {
    _m.lookAt(pos, target, _up);
    return out.setFromRotationMatrix(_m);
  }

  _applyShake(realDt, mode) {
    const game = this.game;
    const cam = this.camera;
    const shake = this.shake;
    shake.floor = game.combat?.grab ? 0.32 : 0;
    let sway = 0.8;
    if (mode === 'follow') {
      const v = game.player?.velocity;
      const speed = v ? v.length() : 0;
      sway = 1 - Math.min(0.6, speed / 8);
    }
    shake.update(realDt, sway);

    _euler.set(shake.pitch, shake.yaw, shake.roll, 'YXZ');
    _q.setFromEuler(_euler);
    cam.quaternion.copy(this._quat).multiply(_q);
    _v.set(shake.x, shake.y, shake.z).applyQuaternion(this._quat);
    cam.position.copy(this._pos).add(_v);
    // shake must not poke the lens out of the water
    const ceil = WORLD.surfaceY - 0.12;
    if (cam.position.y > ceil) cam.position.y = ceil;

    // a framed side-snap drops the push-in kicks (see JAW_SNAP_*)
    const kick = shake.fov < 0 && mode === 'follow' ? shake.fov * (1 - this._jawOpen) : shake.fov;
    const fov = Math.max(30, Math.min(100, this._fov + kick));
    if (Math.abs(cam.fov - fov) > 1e-3) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }
}
