// Player — 老公. Implements the Player contract in docs/DESIGN.md.
//
// Model forward axis: the body's chest faces local +Z, the head is local +Y
// (so an upright, idle 老公 with identity rotation faces +Z). `forward()`
// returns a world-space unit vector: the chest direction when upright, the
// head/travel direction when swimming prone.
//
// Structure:
//   PlayerModel     procedural skinned mesh + knife (src/player/PlayerModel.js)
//   PlayerAnimator  layered procedural animation + IK + cloth springs
//   Player          input → state machine → water physics → orientation →
//                   animation descriptor → combat hooks / events / bubbles
//
// Lock-on: forward input toward the target swims (breaststroke) to close in;
// strafing / backing off treads in a guard (also raised while treading when
// a shark is near or committing, see GUARD_NEAR). Parry → punish: a light
// attack started, or a heavy charge begun, within RIPOSTE_WINDOW of
// `player:parry {success}` is a riposte — a homing dash at the parried
// enemy's eye/gills/head that strikes once in reach (`player:attack
// {riposte:true}`, attack.riposte). Parry (like dodge) cancels a heavy
// charge (its stamina stays spent) and any attack outside its active frames.
// A parry whose window closes on nothing is a whiff (`player:parry
// {whiff:true}`): it costs stamina, a short no-parry recovery, and spam
// fatigue that shortens later windows once misses repeat (see PARRY_WHIFF);
// one unfatigued miss may be retried at once (see PARRY_RETRY); a successful
// parry clears all of it.
import * as THREE from 'three';
import { PLAYER, WORLD } from '../core/config.js';
import { PlayerModel } from './PlayerModel.js';
import { PlayerAnimator } from './PlayerAnimator.js';
import { HURTBOX_MODEL } from './rig.js';
import { clamp, damp, smoothstep, saturate, quatFromUpFront, TAU, gauss } from './math.js';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

// ---- combat tuning ---------------------------------------------------------
const LIGHT = [
  { windup: 0.13, active: 0.11, recovery: 0.25, damage: 10, knockback: 1.6, lunge: 3.2 },
  { windup: 0.1, active: 0.11, recovery: 0.27, damage: 12, knockback: 1.8, lunge: 3.2 },
  { windup: 0.2, active: 0.13, recovery: 0.42, damage: 18, knockback: 3.5, lunge: 4.6 },
];
const HEAVY = {
  windup: 0.06,
  active: 0.2,
  recovery: 0.44,
  levels: [0.4, 0.9, 1.5], // seconds to reach charge level 1 / 2 / 3
  damage: [26, 26, 40, 60],
  knockback: [4, 4, 6, 9],
};
const GRAB_STAB = { windup: 0.05, active: 0.08, recovery: 0.12, damage: 5 };
const REACH = { light: 0.5, heavy: 0.9, grabStab: 0.35 };
const RADIUS = { light: 0.28, heavy: 0.38, grabStab: 0.3 };
const COMBO_GRACE = 0.32;
const BUFFER_TIME = 0.28;
const PARRY_TOTAL = 0.4; // block animation timeline (s); see poseParry
// Parry whiffs cost something, so mashing parry is not a free defence — the
// whiff costs, not a long PLAYER.parryCooldown, hold spam back. A window that
// closes without a parry spends PLAYER.parryWhiffStamina, pauses stamina
// regen and starts a short whiff recovery (no new parry; attack / heavy /
// dodge cancel it). Every whiff also adds 1 to a spam fatigue f (capped at
// PARRY_FATIGUE_MAX) that drains at PARRY_FATIGUE_DECAY per second. One
// recent miss is forgiven — only fatigue above PARRY_FATIGUE_GRACE shortens
// a window: parryWindow / (1 + PARRY_FATIGUE_K · max(0, f − GRACE)). So a
// panicked early press followed by the real one on the strike cue still gets
// the full window, while repeated misses close it fast (≈ 0.12 s at f 1.5,
// 0.075 s at f 2); a masher sits near f 2.8 (≈ 0.05 s), and a fixed rhythm
// stays unfatigued only at ≥ 1 / DECAY = 2 s per press. Measured with the
// parry-spam bots (scripts/core-parry-spam.mjs): the round-2 fatigue (no
// grace, K 0.75, drain 1/s) let a masher outlive an idle player up to
// 1.5–1.8× once the cooldown dropped to 0.45–0.6 s, and a press every 1.3 s
// kept full windows (≈ 1.3–1.4×) at any cooldown; with these constants and the
// 0.6 s cooldown every bot stays ≈ 1.0–1.25×. (A recovery growing 0.15 s per
// fatigue made no measurable difference: at ≈ 0.05 s windows the 0.5 m parry
// reach dominates, and only the masher's press period — the cooldown — moves it.)
const PARRY_WHIFF = 0.15; // s of whiff recovery after the window closes
const PARRY_WHIFF_STAMINA = 8; // default for PLAYER.parryWhiffStamina
const PARRY_WHIFF_REGEN_DELAY = 0.4; // s stamina regen pauses after a whiff
const PARRY_FATIGUE_GRACE = 1; // fatigue a window ignores (one recent whiff)
const PARRY_FATIGUE_K = 3;
const PARRY_FATIGUE_DECAY = 0.5; // per second
const PARRY_FATIGUE_MAX = 3;
// Retry after a lone panicked miss: the first press after a whiff skips the
// cooldown and the whiff recovery while fatigue is still ≤ PARRY_RETRY (one
// whiff from rest), and a press made inside the closing window is carried
// into that retry instead of being dropped. Without it a press 0.1–0.55 s
// before a great white's telegraph ended always ate the bite: the window
// closed before the jaws arrived, and the real press on the strike cue fell
// into the whiff recovery or the cooldown. A second miss (fatigue ≈ 2) gets
// no retry, so mashing still collapses into the short fatigued windows.
const PARRY_RETRY = PARRY_FATIGUE_GRACE;
const AIM_RANGE = 7;
const AIM_CONE = 0.3; // cos of the soft-aim cone half-angle (~72°)
const POST_GRAB_GRACE = 0.6;
const TREMBLE = [0, 0.0025, 0.005, 0.011]; // hand tremble (m) per charge level
// Riposte: a light attack started, or a heavy charge begun, within this much
// game time after a successful parry homes in on the parried enemy's
// eye/gills/head and dashes at it (parry → punish).
const RIPOSTE_WINDOW = 0.6;
const RIPOSTE_RANGE = 6; // m from the chest to the vital hurtbox's surface
// The riposte is a homing dash: the cocked windup is held (up to RIPOSTE_DASH
// extra seconds) until the vital is within RIPOSTE_STRIKE of the chest, then
// the blade goes live. A light slash only reaches ~1 m in front of the chest,
// and a parried bite leaves the head 2.5–3 m away after the push-back.
const RIPOSTE_DASH = 0.35;
const RIPOSTE_STRIKE = 1.1;
// A heavy riposte is released later (≥ 0.4 s of charge) with the shark
// drifting off in its stagger, so it may dash longer; it strikes from a little
// further out because its thrust lunges on top (see _beginActive). Without
// the hold a heavy charged on the parry went live 2.3–2.5 m short and never
// landed (0/8 per species in the original timing trials).
const RIPOSTE_DASH_HEAVY = 0.45;
const RIPOSTE_STRIKE_HEAVY = 1.3;
const VITAL_BIAS = { eye: 0.25, gills: 0.1, head: 0 }; // aim preference (m) among vitals
// Locked-on movement: input pointing at the target (cos of the angle) switches
// treading to the breaststroke so you can close in; hysteresis avoids flicker.
const CLOSE_ENTER = 0.5;
const CLOSE_EXIT = 0.35;
// Closing in on a locked target is an urgent, harder breaststroke than the
// cruise: ≈ 4.7 m/s instead of 4.2, faster than a circling great white (3.5)
// or tiger (3.9), about level with the megalodon's circle (4.8).
const CLOSE_POWER = 1.12; // × PLAYER.swimSpeed
const CLOSE_CADENCE = 1.15; // × stroke rate
// Knife-ready guard while treading: raised when locked on, when any live
// enemy's body or jaws come within GUARD_NEAR (dropped again past GUARD_FAR),
// or when game.danger reaches GUARD_DANGER (a shark approaching, flanking or
// winding up is ≥ 0.7). game.danger alone is not enough: its proximity term
// tops out at 0.65 and passes 0.45 only within ~10 m (Shark.getDangerLevel).
const GUARD_NEAR = 15;
const GUARD_FAR = 18;
const GUARD_DANGER = 0.45;

// ---- water physics ---------------------------------------------------------
const DRAG_LIN = 0.9;
const DRAG_QUAD = 0.11;
const thrustFor = (v) => DRAG_LIN * v + DRAG_QUAD * v * v; // steady-state thrust
const BREAST_RATE = 0.95; // strokes per second at cruise
const FLUTTER_RATE = 2.2;
const TREAD_RATE = 0.62;

// Breaststroke propulsion profile: arm pull, then the big kick, then glide.
const breastRaw = (p) => 0.28 + 1.1 * gauss(p, 0.27, 0.07) + 2.5 * gauss(p, 0.67, 0.05);
const BREAST_AVG = (() => {
  let s = 0;
  for (let i = 0; i < 200; i++) s += breastRaw(i / 200);
  return s / 200;
})();
const breastProfile = (p) => breastRaw(p) / BREAST_AVG;

// ---- temps -----------------------------------------------------------------
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _moveH = new THREE.Vector3();
const _h = new THREE.Vector3();
const _d = new THREE.Vector3();
const _f = new THREE.Vector3();
const _u = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _bub = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _fallbackBasis = {
  forward: new THREE.Vector3(0, 0, -1),
  right: new THREE.Vector3(1, 0, 0),
  up: new THREE.Vector3(0, 1, 0),
};

export class Player {
  constructor(game) {
    this.game = game;
    this.object3d = new THREE.Group();
    this.object3d.name = 'player';
    this.position = this.object3d.position;
    this.velocity = new THREE.Vector3();
    this.radius = PLAYER.radius;
    this.maxHealth = PLAYER.maxHealth;
    this.maxStamina = PLAYER.maxStamina;
    this.health = this.maxHealth;
    this.stamina = this.maxStamina;
    this.alive = true;
    this.state = 'swim';
    this.hurtbox = { center: new THREE.Vector3(), radius: 0.58 };
    this.grabbedBy = null;

    // model + animation
    this.model = new PlayerModel(game);
    this.object3d.add(this.model.root);
    this.model.root.updateMatrix();
    this.animator = new PlayerAnimator(this.model);
    this._rootWorld = new THREE.Matrix4();
    game.scene.add(this.object3d);

    // facing / orientation
    this._facing = new THREE.Vector3(0, 0, -1);
    this._heading = new THREE.Vector3(0, 0, -1); // horizontal facing used for upright modes
    this._moveDir = new THREE.Vector3(0, 0, -1);
    this._aimDir = new THREE.Vector3(0, 0, -1);
    this._aimPoint = new THREE.Vector3();
    this._aimTarget = null;
    this._targetQuat = new THREE.Quaternion();
    this._prone = 0;
    this._sprintW = 0;
    this._bank = 0;
    this._lean = 0;
    this._prevHeadingAngle = 0;

    // locomotion
    this._mode = 'idle'; // idle | swim | tread | sprint
    this._closing = false; // locked on and swimming at the target
    this._sprint = false;
    this._phase = { tread: 0, breast: 0.85, flutter: 0 };
    this._effort = 0;
    this._guard = 0;
    this._threatNear = false; // a live enemy within GUARD_NEAR (hysteresis to GUARD_FAR)

    // combat state
    this._attack = {
      id: 0,
      type: 'light',
      damage: 0,
      base: new THREE.Vector3(),
      tip: new THREE.Vector3(),
      radius: RADIUS.light,
      // (extra) how far `tip` is extended past the real blade tip along the
      // blade (m): the visible tip is tip − reach·normalize(tip − base).
      reach: REACH.light,
      knockback: 0,
      hitEnemies: new Set(),
      combo: 0,
      level: 0,
      riposte: false, // (extra) light swing started / heavy charged inside the post-parry window
    };
    this._attackActive = false;
    this._attackSeq = 0;
    this._atkKind = 'light';
    this._combo = 0;
    this._nextCombo = 0;
    this._comboGrace = 0;
    this._phaseName = 'windup';
    this._phaseT = 0;
    this._charge = 0;
    this._chargeLevel = 0;
    this._releaseQueued = false;
    this._heavyLevel = 1;
    this._dodgeT = 0;
    this._dodgeDir = new THREE.Vector3();
    this._dodgeBack = false;
    this._dodgeSide = false;
    this._dodgeRoll = 1;
    this._parryT = 0;
    this._parryCooldown = 0;
    this._parrySuccessT = -1;
    this._parryWin = PLAYER.parryWindow; // this parry's window (shortened by spam fatigue)
    this._parryWhiffed = false; // this parry's window closed without a parry
    this._parryLock = 0; // whiff recovery left: no new parry
    this._parryFatigue = 0;
    this._parryRetry = false; // the last parry whiffed: one retry may skip cooldown / lock (PARRY_RETRY)
    this._hurtT = 0;
    this._hurtDur = 0.35;
    this._hurtHeavy = false;
    this._hurtDir = new THREE.Vector3(0, 0, -1);
    this._grace = 0;
    this._stabT = -1;
    this._stabCount = 0;
    this._deadT = 0;
    this._staminaDelay = 0;
    this._buf = { attack: 0, heavy: 0, dodge: 0, parry: 0 };
    this._actionId = 0;
    this._riposteUntil = -Infinity; // game.time.elapsed deadline
    this._riposteEnemy = null;
    this._riposte = false; // the current swing / heavy charge is a riposte
    this._riposteSurf = Infinity; // its vital's surface distance from the chest (m)

    // breathing / bubbles
    this._breathT = 2.5;
    this._exhale = 0; // puffs left
    this._exhaleT = 0;
    this._prevBreast = 0;
    this._prevFlutter = 0;

    // look-at
    this._look = { yaw: 0, pitch: 0, weight: 0 };

    this._anim = {
      tread: 0,
      breast: 0,
      flutter: 0,
      wIdle: 1,
      wBreast: 0,
      wFlutter: 0,
      effort: 0,
      guard: 0,
      speed: 0,
      action: 'none',
      actionId: 0,
      combo: 0,
      tau: 0,
      charge: 0,
      dodgeU: 0,
      dodgeBack: false,
      parryU: 0,
      parrySuccessU: -1,
      parryWhiffU: -1, // 0..1 through the whiff recovery, else −1
      parryWhiffAmp: 0, // how off-balance the whiff leaves him (grows with fatigue)
      hurtU: 0,
      hurtDir: new THREE.Vector3(0, 0, -1),
      hurtHeavy: false,
      stabU: -1,
      tremble: 0,
      breathRate: 0.25,
      lookYaw: 0,
      lookPitch: 0,
      lookWeight: 0,
    };

    game.events.on('player:parry', (e) => {
      if (!e?.success) return;
      if (this.state === 'parry') {
        // a clean parry is free: no cooldown, no whiff, fatigue forgiven
        this._parrySuccessT = 0;
        this._parryCooldown = 0;
        this._parryLock = 0;
        this._parryFatigue = 0;
        this._parryRetry = false;
        this.stamina = Math.min(this.maxStamina, this.stamina + 12);
        this._actionId++;
      }
      // open the riposte window on the parried enemy
      if (e.enemy && this.alive) {
        this._riposteEnemy = e.enemy;
        this._riposteUntil = (game.time?.elapsed ?? 0) + RIPOSTE_WINDOW;
      }
    });

    this.reset();
  }

  // ===========================================================================
  // Contract API
  // ===========================================================================
  reset() {
    this.position.fromArray(WORLD.playerSpawn);
    this.velocity.set(0, 0, 0);
    this.health = this.maxHealth;
    this.stamina = this.maxStamina;
    this.alive = true;
    this.state = 'swim';
    this.grabbedBy = null;
    this._attackActive = false;
    this._combo = 0;
    this._nextCombo = 0;
    this._comboGrace = 0;
    this._grace = 0;
    this._parryCooldown = 0;
    this._parrySuccessT = -1;
    this._parryLock = 0;
    this._parryFatigue = 0;
    this._parryRetry = false;
    this._threatNear = false;
    this._stabT = -1;
    this._deadT = 0;
    this._sprint = false;
    this._closing = false;
    this._riposteUntil = -Infinity;
    this._riposteEnemy = null;
    this._riposte = false;
    this._prone = 0;
    this._bank = 0;
    this._lean = 0;
    for (const k in this._buf) this._buf[k] = 0;
    // face the arena centre
    _v.set(-this.position.x, 0, -this.position.z);
    if (_v.lengthSq() < 1e-4) _v.set(0, 0, -1);
    _v.normalize();
    this._heading.copy(_v);
    this._facing.copy(_v);
    this._moveDir.copy(_v);
    this._aimDir.copy(_v);
    quatFromUpFront(this.object3d.quaternion, UP, _v);
    this._targetQuat.copy(this.object3d.quaternion);
    this._actionId++;
    this.animator?.resetCloth();
  }

  forward() {
    return this._facing;
  }

  isInvulnerable() {
    const g = this.game;
    if (g.debug?.god) return true;
    if (g.state !== 'playing') return true;
    if (!this.alive) return true;
    if (this.state === 'dodge' && this._dodgeT < PLAYER.dodgeIFrames) return true;
    if (this._grace > 0) return true;
    return false;
  }

  isParrying() {
    return this.state === 'parry' && this._parryT <= this._parryWin;
  }

  getActiveAttack() {
    return this._attackActive ? this._attack : null;
  }

  takeHit({ damage = 10, sourcePosition = null, knockback = 4, heavy = false } = {}) {
    if (!this.alive || this.isInvulnerable()) return false;
    this.health = Math.max(0, this.health - damage);
    // push direction (source → player)
    if (sourcePosition) _v.subVectors(this.position, sourcePosition);
    else _v.copy(this._facing).negate();
    if (_v.lengthSq() < 1e-6) _v.copy(this._facing).negate();
    _v.normalize();
    if (this.state !== 'grabbed') this.velocity.addScaledVector(_v, knockback ?? 4);
    _qInv.copy(this.object3d.quaternion).invert();
    this._hurtDir.copy(_v).applyQuaternion(_qInv);
    this.game.events.emit('player:hit', { damage, health: this.health, sourcePosition, heavy });
    this._puffMouth(this.game.quality === 'low' ? 6 : 12, 1.3, 0.026);
    if (this.health <= 0) {
      this._die();
      return true;
    }
    const armored = this.state === 'attack' && this._atkKind === 'heavy' && this._phaseName === 'active' && !heavy;
    if (this.state !== 'grabbed' && !armored) {
      this._endAttack();
      this.state = 'hurt';
      this._hurtT = 0;
      this._hurtHeavy = !!heavy;
      this._hurtDur = heavy ? 0.62 : 0.36;
      this._sprint = false;
      this._actionId++;
    }
    return true;
  }

  setGrabbed(enemy) {
    if (enemy) {
      if (!this.alive) return;
      this.grabbedBy = enemy;
      this._endAttack();
      this.state = 'grabbed';
      this.velocity.set(0, 0, 0);
      this._stabT = -1;
      this._stabCount = 0;
      this._sprint = false;
      this._mode = 'idle';
      this._actionId++;
    } else {
      const prev = this.grabbedBy;
      this.grabbedBy = null;
      this._stabT = -1;
      this._attackActive = false;
      if (this.alive) {
        this.state = 'swim';
        this._actionId++;
        this._grace = POST_GRAB_GRACE;
        if (prev?.position) {
          // push clear of the jaws on top of whatever the enemy already gave us
          // (a shark spitting 老公 out sets his velocity before releasing)
          _v.subVectors(this.position, prev.position);
          if (_v.lengthSq() < 1e-6) _v.copy(this._facing).negate();
          this.velocity.addScaledVector(_v.normalize(), 6.5);
        }
        this._puffBody(this.game.quality === 'low' ? 8 : 16, 1.4, 0.03);
      }
    }
  }

  heal(amount) {
    if (!this.alive) return;
    this.health = Math.min(this.maxHealth, this.health + Math.max(0, amount || 0));
  }

  // ===========================================================================
  // Frame update
  // ===========================================================================
  update(dt) {
    const game = this.game;
    const playing = game.state === 'playing';
    dt = Math.max(0, dt);

    // timers
    this._parryCooldown = Math.max(0, this._parryCooldown - dt);
    this._parryLock = Math.max(0, this._parryLock - dt);
    this._parryFatigue = Math.max(0, this._parryFatigue - dt * PARRY_FATIGUE_DECAY);
    this._grace = Math.max(0, this._grace - dt);
    this._comboGrace = Math.max(0, this._comboGrace - dt);
    this._staminaDelay = Math.max(0, this._staminaDelay - dt);
    for (const k in this._buf) this._buf[k] = Math.max(0, this._buf[k] - dt);

    const basis = game.cameraRig?.getMoveBasis?.() ?? _fallbackBasis;
    const input = game.input;
    const canAct = playing && this.alive;

    // ---- read input -----------------------------------------------------------
    _wish.set(0, 0, 0);
    _moveH.set(0, 0, 0);
    let vert = 0;
    if (canAct && this.state !== 'grabbed') {
      const fwd = input.axis('forward', 'back');
      const str = input.axis('right', 'left');
      vert = input.axis('up', 'down');
      _moveH.addScaledVector(basis.forward, fwd).addScaledVector(basis.right, str);
      _wish.copy(_moveH);
      _wish.y += vert;
      if (_wish.lengthSq() > 1) _wish.normalize();
      if (input.pressed('attack')) this._buf.attack = BUFFER_TIME;
      if (input.pressed('heavy')) this._buf.heavy = BUFFER_TIME;
      if (input.pressed('dodge')) this._buf.dodge = BUFFER_TIME;
      if (input.pressed('parry')) this._buf.parry = BUFFER_TIME;
    }
    const moving = _wish.lengthSq() > 0.01;

    // ---- state machine --------------------------------------------------------
    if (!this.alive) {
      this._updateDead(dt);
    } else if (this.state === 'grabbed') {
      this._updateGrabbed(dt, canAct);
    } else {
      if (canAct) this._updateActions(dt, basis, moving);
      else if (this.state !== 'swim') this._forceSwim();
      this._updateLocomotion(dt, basis, moving, vert, canAct);
    }

    // ---- stamina ----------------------------------------------------------------
    const regenBlocked = this.state === 'heavyCharge' || this.state === 'dodge' || this._sprint || this._staminaDelay > 0;
    if (!regenBlocked && this.alive) {
      const rate = PLAYER.staminaRegen * (this.state === 'hurt' || this.state === 'grabbed' ? 0.4 : 1);
      this.stamina = Math.min(this.maxStamina, this.stamina + rate * dt);
    }

    // ---- arena -----------------------------------------------------------------
    this._constrain(dt);

    // ---- orientation ----------------------------------------------------------
    this._updateOrientation(dt, basis, moving);

    // ---- animation -----------------------------------------------------------
    this.object3d.updateMatrix();
    this.object3d.updateWorldMatrix(true, false);
    this._rootWorld.multiplyMatrices(this.object3d.matrixWorld, this.model.root.matrix);
    this._updateLook(dt);
    this._fillAnim();
    this.animator.update(dt, this._anim, this.object3d.quaternion, this._rootWorld);
    this.model.updateLight();

    // ---- combat hooks ------------------------------------------------------------
    if (this._attackActive) {
      const a = this._attack;
      a.reach = REACH[a.type] ?? 0.5;
      this.animator.getKnifeSegment(this._rootWorld, a.reach, a.base, a.tip);
    }
    this.hurtbox.center.copy(HURTBOX_MODEL).applyMatrix4(this._rootWorld);

    // ---- bubbles -----------------------------------------------------------------
    this._updateBubbles(dt, moving);
  }

  // ===========================================================================
  // Actions
  // ===========================================================================
  _updateActions(dt, basis, moving) {
    const b = this._buf;
    const input = this.game.input;
    switch (this.state) {
      case 'swim': {
        if (b.dodge && this._tryDodge(basis)) break;
        if (b.parry && this._tryParry()) break;
        if (b.heavy && this._tryCharge(basis)) break;
        if (b.attack) this._startLight(this._comboGrace > 0 ? this._nextCombo : 0, basis);
        break;
      }
      case 'attack': {
        this._phaseT += dt;
        this._advanceAttack(basis);
        if (this.state !== 'attack') break;
        const ph = this._phaseName;
        // defensive cancels outside the active frames: dodge or parry out of a
        // wind-up (incl. a riposte's homing hold) or a recovery — a parry
        // pressed mid-swing is buffered into the recovery, not dropped
        if (ph !== 'active') {
          if (b.dodge && this._tryDodge(basis)) break;
          if (b.parry && this._tryParry()) break;
        }
        if (this._atkKind === 'light' && ph === 'recovery') {
          if (b.heavy && this._tryCharge(basis)) break;
          if (b.attack && this._combo < 2 && this._phaseT >= 0.03) {
            this._startLight(this._combo + 1, basis);
            break;
          }
        }
        break;
      }
      case 'heavyCharge': {
        this._charge += dt;
        const lv = this._charge >= HEAVY.levels[2] ? 3 : this._charge >= HEAVY.levels[1] ? 2 : this._charge >= HEAVY.levels[0] ? 1 : 0;
        if (lv > this._chargeLevel) {
          this._chargeLevel = lv;
          this.game.events.emit('player:heavyCharge', { level: lv });
          if (lv === 3) this._puffBody(this.game.quality === 'low' ? 4 : 8, 0.6, 0.016);
        }
        this._trackAim(basis, true);
        if (!input.isDown('heavy')) this._releaseQueued = true;
        if (b.dodge && this._tryDodge(basis)) break;
        if (b.parry && this._tryParry()) break; // drops the charge; its stamina stays spent
        if (this._releaseQueued && this._charge >= HEAVY.levels[0]) this._releaseHeavy(basis);
        break;
      }
      case 'dodge': {
        this._dodgeT += dt;
        if (this._dodgeT >= PLAYER.dodgeDuration) {
          this.state = 'swim';
          this._actionId++;
          this._sprint = input.isDown('dodge') && moving;
          if (b.attack) this._startLight(0, basis);
        } else if (this._dodgeT > PLAYER.dodgeDuration * 0.7 && b.attack) {
          this._startLight(0, basis);
        }
        break;
      }
      case 'parry': {
        this._parryT += dt;
        if (this._parrySuccessT >= 0) {
          this._parrySuccessT += dt;
          // riposte: a successful parry can be cancelled straight into an attack
          if (this._parrySuccessT > 0.08) {
            if (b.attack) {
              this._startLight(0, basis);
              break;
            }
            if (b.heavy && this._tryCharge(basis)) break;
            if (b.dodge && this._tryDodge(basis)) break;
          }
          if (this._parrySuccessT > 0.42) this._toSwim();
        } else if (this._parryT > this._parryWin) {
          // Combat checked isParrying() for the last time last frame (it runs
          // after the player): the window closed on nothing.
          if (!this._parryWhiffed) this._whiff();
          // whiff recovery: a press now (or one made inside the window that
          // just closed) restarts the window if this was a lone, unfatigued
          // miss (PARRY_RETRY); otherwise it is dropped, not buffered into a
          // parry the moment the recovery ends (see _parryLock). Any other
          // action cancels the recovery.
          if (b.parry && this._tryParry()) break;
          b.parry = 0;
          if (b.attack) {
            this._startLight(0, basis);
            break;
          }
          if (b.heavy && this._tryCharge(basis)) break;
          if (b.dodge && this._tryDodge(basis)) break;
          if (this._parryT >= this._parryWin + PARRY_WHIFF) this._toSwim();
        }
        break;
      }
      case 'hurt': {
        this._hurtT += dt;
        if (this._hurtT >= this._hurtDur) this._toSwim();
        else if (this._hurtT > this._hurtDur * 0.6 && b.dodge) this._tryDodge(basis);
        break;
      }
      default:
        break;
    }
  }

  _toSwim() {
    this.state = 'swim';
    this._actionId++;
  }

  _forceSwim() {
    this._endAttack();
    this.state = 'swim';
    this._actionId++;
  }

  _endAttack() {
    this._attackActive = false;
    this._releaseQueued = false;
    if (this.state === 'attack' || this.state === 'heavyCharge') {
      this._comboGrace = 0;
    }
  }

  _startLight(index, basis) {
    this._buf.attack = 0;
    this.state = 'attack';
    this._atkKind = 'light';
    this._combo = index;
    this._phaseName = 'windup';
    this._phaseT = 0;
    this._attackActive = false;
    this._sprint = false;
    this._actionId++;
    this._riposte = this._acquireRiposte();
    if (!this._riposte) this._acquireTarget(basis);
    this._trackAim(basis, false);
  }

  /**
   * Riposte dash speed (m/s) from the vital's surface distance: full 7 m/s
   * until ~1.7 m out, easing to 2.5 m/s at striking range. (A one-off
   * clamp((d − 1)·3.2, 2, 7) lunge at the strike left the blade ~0.9 m short
   * of a parried megalodon's head even with the shark held still.)
   */
  _riposteSpeed() {
    return clamp((this._riposteSurf - 0.3) * 5, 2.5, 7);
  }

  /**
   * Inside the post-parry window: aim this light swing / heavy charge at the
   * parried enemy's nearest eye / gills / head (within RIPOSTE_RANGE).
   * Returns true when it is a riposte (sets _aimTarget/_aimPoint).
   */
  _acquireRiposte() {
    const e = this._riposteEnemy;
    if (!e) return false;
    if (e.alive === false || (this.game.time?.elapsed ?? 0) > this._riposteUntil) {
      this._riposteEnemy = null;
      return false;
    }
    this._chestWorld(_chest);
    const d = this._vitalHurtbox(e, _chest, this._aimPoint);
    if (!(d <= RIPOSTE_RANGE)) return false;
    this._aimTarget = e;
    this._riposteSurf = d;
    return true;
  }

  _tryCharge(basis) {
    this._buf.heavy = 0;
    if (this.stamina < PLAYER.heavyCost) return false;
    this.stamina -= PLAYER.heavyCost;
    this._staminaDelay = 0.5;
    this.state = 'heavyCharge';
    this._atkKind = 'heavy';
    this._charge = 0;
    this._chargeLevel = 0;
    this._releaseQueued = !this.game.input.isDown('heavy');
    this._attackActive = false;
    this._sprint = false;
    this._actionId++;
    // a charge begun inside the post-parry window aims at the parried
    // enemy's vital and is released as a homing heavy riposte
    this._riposte = this._acquireRiposte();
    if (!this._riposte) this._acquireTarget(basis);
    this._trackAim(basis, false);
    this.game.events.emit('player:heavyCharge', { level: 0 });
    return true;
  }

  _releaseHeavy(basis) {
    this._heavyLevel = Math.max(1, this._chargeLevel);
    this.state = 'attack';
    this._atkKind = 'heavy';
    this._phaseName = 'windup';
    this._phaseT = 0;
    this._releaseQueued = false;
    this._actionId++;
    this._trackAim(basis, true);
    // a riposte charge stays one only while its target lives and its vital
    // is still within dash range (a long charge lets a shark drift off)
    const t = this._aimTarget;
    if (this._riposte && (!t || t.alive === false || !(this._riposteSurf <= RIPOSTE_RANGE))) this._riposte = false;
  }

  /** Moves the current attack through windup → active → recovery. */
  _advanceAttack(basis) {
    const heavy = this._atkKind === 'heavy';
    const t = heavy ? HEAVY : LIGHT[this._combo];
    const riposte = this._riposte;
    if (this._phaseName === 'windup' || (this._phaseName === 'active' && riposte && !heavy)) {
      this._trackAim(basis, true); // a light riposte keeps homing while the blade is live
    }
    if (this._phaseName === 'windup' && this._phaseT >= t.windup) {
      // a riposte holds the cocked blade while it dashes in (see RIPOSTE_DASH)
      const strike = heavy ? RIPOSTE_STRIKE_HEAVY : RIPOSTE_STRIKE;
      const dash = heavy ? RIPOSTE_DASH_HEAVY : RIPOSTE_DASH;
      const hold = riposte && this._riposteSurf > strike && this._phaseT < t.windup + dash;
      if (!hold) {
        this._phaseT = riposte ? 0 : this._phaseT - t.windup;
        this._phaseName = 'active';
        this._beginActive();
      }
    }
    if (this._phaseName === 'active' && this._phaseT >= t.active) {
      this._phaseT -= t.active;
      this._phaseName = 'recovery';
      this._attackActive = false;
    }
    if (this._phaseName === 'recovery' && this._phaseT >= t.recovery) {
      this._attackActive = false;
      if (!heavy) {
        this._nextCombo = this._combo < 2 ? this._combo + 1 : 0;
        this._comboGrace = this._combo < 2 ? COMBO_GRACE : 0;
      }
      this.state = 'swim';
      this._actionId++;
    }
  }

  _beginActive() {
    const a = this._attack;
    const heavy = this._atkKind === 'heavy';
    a.id = ++this._attackSeq;
    a.type = heavy ? 'heavy' : 'light';
    a.hitEnemies.clear();
    a.radius = RADIUS[a.type];
    if (heavy) {
      const lv = this._heavyLevel;
      a.damage = HEAVY.damage[lv];
      a.knockback = HEAVY.knockback[lv];
      a.combo = lv;
      a.level = lv;
    } else {
      const c = LIGHT[this._combo];
      a.damage = c.damage;
      a.knockback = c.knockback;
      a.combo = this._combo + 1;
      a.level = 0;
    }
    a.riposte = this._riposte;
    this._attackActive = true;
    // initialise the segment so it is valid this very frame
    a.reach = REACH[a.type] ?? 0.5;
    this.animator.getKnifeSegment(this._rootWorld, a.reach, a.base, a.tip);

    // lunge toward the target (water-damped, so it reads as a committed push)
    const dist = this._aimTarget ? this._aimPoint.distanceTo(this.position) : Infinity;
    let lunge;
    if (heavy) {
      // (a heavy riposte arrives here off its homing dash and thrusts on top)
      const lv = this._heavyLevel;
      lunge = Number.isFinite(dist) ? clamp((dist - 1.2) * 3.2, 3.5, 9 + 2 * lv) : 7.5 + 1.8 * lv;
      if (a.riposte) this.game.events.emit('player:attack', { type: 'heavy', combo: lv, level: lv, riposte: true });
      else this.game.events.emit('player:attack', { type: 'heavy', combo: lv, level: lv });
      _bub.copy(a.tip);
      this.game.vfx?.spawnBubbles?.(_bub, this.game.quality === 'low' ? 5 : 10, { speed: 2.2, size: 0.02 });
    } else if (a.riposte) {
      // riposte: no impulse — the homing dash (see _updateLocomotion) already
      // carries the knife into the opening the parry made
      this.game.events.emit('player:attack', { type: 'light', combo: this._combo + 1, riposte: true });
      return;
    } else {
      const c = LIGHT[this._combo];
      lunge = Number.isFinite(dist) ? clamp((dist - 1.5) * 1.9, 0.6, c.lunge) : 1.6;
      this.game.events.emit('player:attack', { type: 'light', combo: this._combo + 1 });
    }
    this.velocity.multiplyScalar(0.35).addScaledVector(this._aimDir, lunge);
  }

  _tryDodge(basis) {
    this._buf.dodge = 0;
    if (this.stamina < PLAYER.dodgeCost) return false;
    this.stamina -= PLAYER.dodgeCost;
    this._staminaDelay = 0.55;
    this._endAttack();
    // direction: input (camera-relative, incl. vertical) or straight back
    if (_wish.lengthSq() > 0.04) this._dodgeDir.copy(_wish).normalize();
    else this._dodgeDir.copy(this._heading).negate();
    _v.copy(this._heading);
    this._dodgeBack = this._dodgeDir.dot(_v) < -0.55;
    this._dodgeSide = !this._dodgeBack && Math.abs(this._dodgeDir.dot(_v)) < 0.5 && Math.abs(this._dodgeDir.y) < 0.7;
    // roll the way the dodge goes (right dodge → clockwise seen from behind)
    _v2.crossVectors(_v, this._dodgeDir);
    this._dodgeRoll = _v2.y > 0.05 ? 1 : _v2.y < -0.05 ? -1 : Math.random() < 0.5 ? 1 : -1;
    this._dodgeT = 0;
    this.state = 'dodge';
    this._sprint = false;
    this._actionId++;
    this.velocity.copy(this._dodgeDir).multiplyScalar(PLAYER.dodgeSpeed);
    this.game.events.emit('player:dodge', { direction: this._dodgeDir.clone() });
    this._puffBody(this.game.quality === 'low' ? 8 : 18, 1.7, 0.03);
    this._puffMouth(this.game.quality === 'low' ? 3 : 6, 1.0, 0.02);
    return true;
  }

  _tryParry() {
    this._buf.parry = 0; // a press during the cooldown / whiff recovery is dropped, not buffered
    // the first press after a lone, unfatigued whiff is a retry (PARRY_RETRY)
    const retry = this._parryRetry && this._parryFatigue <= PARRY_RETRY + 1e-6;
    if (!retry && (this._parryCooldown > 0 || this._parryLock > 0)) return false;
    this._parryRetry = false;
    this._parryLock = 0;
    this._endAttack();
    this.state = 'parry';
    this._parryT = 0;
    this._parrySuccessT = -1;
    this._parryWhiffed = false;
    this._parryWin = PLAYER.parryWindow / (1 + PARRY_FATIGUE_K * Math.max(0, this._parryFatigue - PARRY_FATIGUE_GRACE));
    this._parryCooldown = PLAYER.parryCooldown;
    this._sprint = false;
    this._actionId++;
    this._acquireTarget(this.game.cameraRig?.getMoveBasis?.() ?? _fallbackBasis);
    this.game.events.emit('player:parry', { attempt: true });
    return true;
  }

  /** The parry window closed without a parry: pay for it (see PARRY_WHIFF). */
  _whiff() {
    this._parryWhiffed = true;
    this.stamina = Math.max(0, this.stamina - (PLAYER.parryWhiffStamina ?? PARRY_WHIFF_STAMINA));
    this._staminaDelay = Math.max(this._staminaDelay, PARRY_WHIFF_REGEN_DELAY);
    this._parryLock = PARRY_WHIFF;
    this._parryFatigue = Math.min(PARRY_FATIGUE_MAX, this._parryFatigue + 1);
    this._parryRetry = true; // honoured only while fatigue ≤ PARRY_RETRY (see _tryParry)
    this.game.events.emit('player:parry', { whiff: true });
  }

  _die() {
    this.alive = false;
    this._endAttack();
    this.state = 'dead';
    this.grabbedBy = null;
    this._sprint = false;
    this._mode = 'idle';
    this._deadT = 0;
    this._actionId++;
    this.velocity.multiplyScalar(0.3);
    this.game.events.emit('player:death', {});
    this._puffMouth(this.game.quality === 'low' ? 14 : 30, 1.0, 0.03);
  }

  // ===========================================================================
  // Aim assist
  // ===========================================================================
  _acquireTarget(basis) {
    const g = this.game;
    this._chestWorld(_chest);
    const lock = g.cameraRig?.lockTarget;
    let best = null;
    if (lock && lock.alive !== false) {
      best = lock;
    } else {
      // cone axis: where the player is steering, else where the camera looks
      _v3.copy(_wish.lengthSq() > 0.04 ? _wish : basis.forward).normalize();
      const list = g.enemies?.enemies;
      let bestScore = Infinity;
      if (Array.isArray(list)) {
        for (const e of list) {
          if (!e || e.alive === false || !e.position) continue;
          const d = this._closestHurtbox(e, _chest, _v2);
          if (d > AIM_RANGE) continue;
          _v.subVectors(_v2, _chest).normalize();
          const dot = _v.dot(_v3);
          if (dot < AIM_CONE) continue;
          const score = d * (1.6 - dot * 0.6);
          if (score < bestScore) {
            bestScore = score;
            best = e;
          }
        }
      } else {
        const e = g.enemies?.getNearest?.(this.position, AIM_RANGE);
        if (e) best = e;
      }
    }
    this._aimTarget = best;
    if (!best) {
      this._aimDir.copy(basis.forward).normalize();
    }
  }

  /** Distance from p to the target's best hurtbox (head/eye/gills favoured). */
  _closestHurtbox(e, p, out) {
    let best = Infinity;
    const hbs = e.hurtboxes;
    if (Array.isArray(hbs) && hbs.length) {
      for (let i = 0; i < hbs.length; i++) {
        const hb = hbs[i];
        if (!hb?.center) continue;
        let d = Math.max(0, hb.center.distanceTo(p) - (hb.radius ?? 0) * 0.6);
        if (hb.part === 'eye' || hb.part === 'gills' || hb.part === 'head') d -= 0.35;
        if (d < best) {
          best = d;
          out.copy(hb.center);
        }
      }
    }
    if (!Number.isFinite(best)) {
      out.copy(e.position);
      best = e.position.distanceTo(p);
    }
    return Math.max(0, best);
  }

  /**
   * Surface distance from p to the target's nearest eye/gills/head hurtbox
   * (eyes slightly preferred); writes its centre to out. Infinity if none.
   */
  _vitalHurtbox(e, p, out) {
    let bestScore = Infinity;
    let bestD = Infinity;
    const hbs = e.hurtboxes;
    if (!Array.isArray(hbs)) return bestD;
    for (let i = 0; i < hbs.length; i++) {
      const hb = hbs[i];
      const bias = hb?.center ? VITAL_BIAS[hb.part] : undefined;
      if (bias === undefined) continue;
      const d = Math.max(0, hb.center.distanceTo(p) - (hb.radius ?? 0));
      if (d - bias < bestScore) {
        bestScore = d - bias;
        bestD = d;
        out.copy(hb.center);
      }
    }
    return bestD;
  }

  _trackAim(basis, smooth) {
    const t = this._aimTarget;
    if (t && t.alive !== false && t.position) {
      this._chestWorld(_chest);
      let vital = Infinity;
      if (this._riposte) vital = this._vitalHurtbox(t, _chest, this._aimPoint);
      if (vital < Infinity) this._riposteSurf = vital;
      else this._closestHurtbox(t, _chest, this._aimPoint);
      _v.subVectors(this._aimPoint, _chest);
      if (_v.lengthSq() > 1e-6) {
        _v.normalize();
        if (smooth) this._aimDir.lerp(_v, 0.35).normalize();
        else this._aimDir.copy(_v);
      }
    } else if (!smooth) {
      this._aimDir.copy(basis.forward).normalize();
    }
  }

  /** Upper-torso world position (the animated hurtbox centre). */
  _chestWorld(out) {
    return out.copy(this.hurtbox.center.lengthSq() > 0 ? this.hurtbox.center : this.position);
  }

  // ===========================================================================
  // Locomotion & physics
  // ===========================================================================
  _updateLocomotion(dt, basis, moving, vert, canAct) {
    const input = this.game.input;
    const lock = this.game.cameraRig?.lockTarget;
    const locked = !!(lock && lock.alive !== false);
    const horiz = _moveH.lengthSq() > 0.01;

    // sprint: hold dodge after a dash while moving
    if (this._sprint && (!canAct || !input.isDown('dodge') || !moving || this.state !== 'swim')) this._sprint = false;
    if (canAct && this.state === 'swim' && !this._sprint && moving && input.isDown('dodge') && this._buf.dodge === 0 && this.stamina < PLAYER.dodgeCost) {
      // too tired to dash: still allow the sprint kick
      this._sprint = true;
    }

    // Locked on: steering at the target swims (breaststroke) so you can close
    // in on a circling shark; strafing and backing off keep the treading guard.
    let closing = false;
    if (locked && moving && horiz && this.state === 'swim') {
      this._chestWorld(_chest);
      this._closestHurtbox(lock, _chest, _v3);
      _v3.sub(_chest);
      if (_v3.lengthSq() > 1e-6) {
        const dot = _v3.normalize().dot(_v.copy(_wish).normalize());
        closing = dot > (this._closing ? CLOSE_EXIT : CLOSE_ENTER);
      }
    }

    let mode = 'idle';
    if (this.state === 'swim') {
      if (this._sprint) mode = 'sprint';
      else if (moving && horiz && (!locked || closing)) mode = 'swim';
      else if (moving) mode = 'tread';
    }
    const ph = this._phase;
    if (closing && !this._closing && this._mode !== 'swim' && (ph.breast >= 0.75 || ph.breast <= 0.02)) {
      // Pushing off toward the target: start on the arm pull instead of
      // drifting through the glide first. The breast pose is still faded out
      // here (prone ≈ 0), so the phase jump is not visible.
      ph.breast = 0.1;
    }
    this._closing = closing;
    this._mode = mode;
    if (moving) {
      _v.copy(_wish).normalize();
      this._moveDir.lerp(_v, 1 - Math.exp(-dt * 8)).normalize();
    }

    // stroke clocks
    this._effort = damp(this._effort, mode === 'tread' ? 1 : mode === 'idle' ? 0 : 0.5, 3, dt);
    ph.tread = (ph.tread + dt * TREAD_RATE * (1 + this._effort * 0.7)) % 1;
    if (mode === 'swim') ph.breast = (ph.breast + dt * BREAST_RATE * (0.75 + 0.25 * _wish.length()) * (closing ? CLOSE_CADENCE : 1)) % 1;
    else if (ph.breast < 0.8 && ph.breast > 0.02) ph.breast = Math.min(0.8, ph.breast + dt * BREAST_RATE); // finish into the glide
    ph.flutter = (ph.flutter + dt * FLUTTER_RATE * (mode === 'sprint' ? 1 : 0.4)) % 1;

    // thrust
    let thrust = 0;
    let scale = 1;
    switch (this.state) {
      case 'attack':
        scale = this._atkKind === 'heavy' ? 0.1 : 0.35;
        break;
      case 'heavyCharge':
        scale = 0.25;
        break;
      case 'parry':
        scale = 0.3;
        break;
      case 'hurt':
        scale = 0;
        break;
      case 'dodge':
        scale = 0;
        break;
      default:
        scale = 1;
    }
    if (moving && scale > 0) {
      if (mode === 'sprint') thrust = thrustFor(PLAYER.sprintSpeed) * (1 + 0.22 * Math.sin(ph.flutter * TAU * 2));
      else if (mode === 'swim') thrust = thrustFor(PLAYER.swimSpeed * (closing ? CLOSE_POWER : 1)) * breastProfile(ph.breast);
      else thrust = thrustFor(PLAYER.swimSpeed * 0.72) * (1 + 0.2 * Math.sin(ph.tread * TAU * 2));
      this.velocity.addScaledVector(_wish, thrust * scale * dt);
    }

    if (this.state === 'dodge') {
      // scripted burst: fast out, decaying into a glide
      const u = clamp(this._dodgeT / PLAYER.dodgeDuration, 0, 1);
      const sp = PLAYER.dodgeSpeed * Math.pow(1 - u, 1.25) + PLAYER.swimSpeed * 0.45 * u;
      _v.copy(this._dodgeDir).multiplyScalar(sp);
      this.velocity.lerp(_v, 1 - Math.exp(-dt * 30));
    } else if (
      this.state === 'attack' &&
      this._riposte &&
      this._aimTarget &&
      (this._phaseName === 'windup' || (this._phaseName === 'active' && this._atkKind === 'light'))
    ) {
      // riposte: a homing dash at the vital through windup (and, for a light
      // swing, active; a heavy thrusts with its own lunge), easing off as it
      // closes (beats the parry's push-back and the shark's reel)
      _v.copy(this._aimDir).multiplyScalar(this._riposteSpeed());
      this.velocity.lerp(_v, 1 - Math.exp(-dt * 12));
    } else {
      // water drag (linear + quadratic): inertia, no flying
      const sp = this.velocity.length();
      this.velocity.multiplyScalar(Math.exp(-(DRAG_LIN + DRAG_QUAD * sp) * dt));
      // sideways slip is damped harder while stroking (steering bite)
      if (moving && thrust > 0) {
        _v.copy(_wish).normalize();
        const along = this.velocity.dot(_v);
        _v2.copy(this.velocity).addScaledVector(_v, -along);
        this.velocity.addScaledVector(_v2, -(1 - Math.exp(-dt * 1.6)));
      } else if (!moving && this.state === 'swim') {
        // treading water: sculling hands and kicks arrest the drift
        this.velocity.multiplyScalar(Math.exp(-dt * 1.1));
        this.velocity.y *= Math.exp(-dt * 1.2);
      }
    }
    if (this.velocity.lengthSq() > 18 * 18) this.velocity.setLength(18);
    this.position.addScaledVector(this.velocity, dt);

    // guard stance when locked on / threatened (see GUARD_NEAR)
    this._threatNear = this._enemyWithin(this._threatNear ? GUARD_FAR : GUARD_NEAR);
    const threatened = locked || this._threatNear || (this.game.danger ?? 0) >= GUARD_DANGER;
    this._guard = damp(this._guard, threatened ? 1 : 0, 3, dt);
  }

  /** True when a live enemy's body centre or jaws is within `r` metres. */
  _enemyWithin(r) {
    const list = this.game.enemies?.enemies;
    if (!Array.isArray(list)) return false;
    const r2 = r * r;
    const p = this.position;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.alive === false || !e.position) continue;
      if (e.position.distanceToSquared(p) <= r2) return true;
      const m = e.getMouthPosition?.();
      if (m && m.distanceToSquared(p) <= r2) return true;
    }
    return false;
  }

  _constrain(dt) {
    const p = this.position;
    const v = this.velocity;
    const top = WORLD.surfaceY - 1.2;
    if (p.y > top - 0.8) v.y -= (p.y - (top - 0.8)) * 7 * dt;
    if (p.y > top) {
      p.y = top;
      if (v.y > 0) v.y = 0;
    }
    const env = this.game.env;
    let floorH = WORLD.floorY;
    try {
      const h = env?.getSeabedHeight?.(p.x, p.z);
      if (Number.isFinite(h)) floorH = h;
    } catch {
      /* keep nominal floor */
    }
    const floor = floorH + (this.alive ? 0.7 : 0.28);
    if (p.y < floor + 0.5 && this.alive) v.y += (floor + 0.5 - p.y) * 7 * dt;
    if (p.y < floor) {
      p.y = floor;
      if (v.y < 0) v.y = 0;
    }
    const R = WORLD.arenaRadius;
    const r = Math.hypot(p.x, p.z);
    if (r > R - 4 && r > 1e-6) {
      const push = (r - (R - 4)) * 2.5 * dt;
      v.x -= (p.x / r) * push;
      v.z -= (p.z / r) * push;
      if (r > R + 2) {
        const k = (R + 2) / r;
        p.x *= k;
        p.z *= k;
      }
    }
    this._floorH = floorH;
  }

  // ===========================================================================
  // Orientation
  // ===========================================================================
  _updateOrientation(dt, basis, moving) {
    const q = this.object3d.quaternion;
    let rate = 5;
    let proneTarget = 0;
    let sprintTarget = 0;
    const lock = this.game.cameraRig?.lockTarget;
    const locked = !!(lock && lock.alive !== false && lock.position);

    // horizontal heading for upright modes
    _h.copy(basis.forward);
    _h.y = 0;
    if (_h.lengthSq() < 1e-6) _h.copy(this._heading);
    _h.normalize();

    switch (this.state) {
      case 'swim': {
        if (this._mode === 'swim' || this._mode === 'sprint') {
          // prone along the travel direction (flattened near the seabed/surface)
          _d.copy(this._moveDir);
          const clearance = this.position.y - ((this._floorH ?? WORLD.floorY) + 0.7);
          if (clearance < 1.6 && _d.y < 0) _d.y *= smoothstep(0, 1.6, clearance);
          const roof = WORLD.surfaceY - 1.2 - this.position.y;
          if (roof < 1.2 && _d.y > 0) _d.y *= smoothstep(0, 1.2, roof);
          if (_d.lengthSq() < 1e-6) _d.copy(_h);
          _d.normalize();
          _v.set(_d.x, 0, _d.z);
          if (_v.lengthSq() > 0.02) this._heading.lerp(_v.normalize(), 1 - Math.exp(-dt * 6)).normalize();
          const sp = this.velocity.length();
          proneTarget = clamp(0.4 + sp / 3.2, 0, 1);
          sprintTarget = this._mode === 'sprint' ? 1 : 0;
          this._composeSwim(this._targetQuat, _d, this._heading, this._prone);
          rate = 4.5;
        } else {
          // treading: face the lock target, else turn with the camera
          if (locked) {
            _v.subVectors(lock.position, this.position);
            _v.y = 0;
            if (_v.lengthSq() > 1e-4) this._heading.lerp(_v.normalize(), 1 - Math.exp(-dt * 6)).normalize();
          } else {
            const k = this._mode === 'tread' ? 5 : 2.2;
            this._heading.lerp(_h, 1 - Math.exp(-dt * k)).normalize();
          }
          _u.copy(UP).addScaledVector(this._heading, 0.12);
          quatFromUpFront(this._targetQuat, _u, this._heading);
          rate = 3.5;
        }
        break;
      }
      case 'attack':
      case 'heavyCharge':
      case 'parry': {
        const heavyLunge = this.state === 'attack' && this._atkKind === 'heavy' && this._phaseName !== 'windup';
        const leanTarget = heavyLunge ? 0.95 : this.state === 'heavyCharge' ? 0.15 : 0.32;
        this._lean = damp(this._lean, leanTarget, heavyLunge ? 10 : 6, dt);
        this._composeCombat(this._targetQuat, this._aimDir, this._lean);
        _v.set(this._aimDir.x, 0, this._aimDir.z);
        if (_v.lengthSq() > 0.02) this._heading.lerp(_v.normalize(), 1 - Math.exp(-dt * 10)).normalize();
        rate = this.state === 'parry' ? 9 : 12;
        break;
      }
      case 'dodge': {
        const u = clamp(this._dodgeT / PLAYER.dodgeDuration, 0, 1);
        if (this._dodgeBack) {
          // push back feet-first, chest still toward the threat, tipping back
          _d.copy(this._heading);
          this._composeCombat(this._targetQuat, _d, -0.55 * Math.sin(Math.PI * u));
        } else if (this._dodgeSide) {
          // sideways burst: body tips toward the dodge and corkscrews once,
          // chest coming back around to the threat
          _v3.copy(this._dodgeDir).addScaledVector(this._heading, -this._dodgeDir.dot(this._heading));
          if (_v3.lengthSq() < 1e-6) _v3.copy(this._dodgeDir);
          _v3.normalize();
          const tip = 1.05 * Math.sin(Math.PI * Math.min(1, u * 1.15));
          _u.copy(UP).multiplyScalar(Math.cos(tip)).addScaledVector(_v3, Math.sin(tip));
          quatFromUpFront(this._targetQuat, _u, this._heading);
          const twist = TAU * this._dodgeRoll * (u * u * (3 - 2 * u));
          _q.setFromAxisAngle(UP, twist);
          this._targetQuat.multiply(_q);
        } else {
          // dive along the dodge direction with a corkscrew twist
          proneTarget = 1;
          this._composeSwim(this._targetQuat, this._dodgeDir, this._heading, 1);
          const twist = TAU * this._dodgeRoll * (u * u * (3 - 2 * u));
          _q.setFromAxisAngle(UP, twist);
          this._targetQuat.multiply(_q);
        }
        rate = 22;
        break;
      }
      case 'hurt':
        rate = 2.5;
        break;
      case 'grabbed': {
        const e = this.grabbedBy;
        if (e) {
          this._grabFocus(e, _d);
          _d.sub(this.position);
          if (_d.lengthSq() > 1e-6) {
            _d.normalize();
            this._aimDir.copy(_d);
            this._composeCombat(this._targetQuat, _d, 0.25);
          }
        }
        rate = 10;
        break;
      }
      case 'dead': {
        // go limp: slowly roll face-down and drift
        _d.copy(this._heading);
        _d.y = -0.25;
        _d.normalize();
        this._composeSwim(this._targetQuat, _d, this._heading, 1);
        _q.setFromAxisAngle(UP, Math.sin(this._deadT * 0.3) * 0.4);
        this._targetQuat.multiply(_q);
        rate = 0.7;
        break;
      }
      default:
        break;
    }

    this._prone = damp(this._prone, proneTarget, this.state === 'dodge' ? 14 : 2.6, dt);
    this._sprintW = damp(this._sprintW, sprintTarget, 4, dt);
    if (this.state !== 'attack' && this.state !== 'heavyCharge' && this.state !== 'grabbed') this._lean = damp(this._lean, 0, 4, dt);

    // banking into turns while swimming
    const ang = Math.atan2(this._heading.x, this._heading.z);
    let dAng = ang - this._prevHeadingAngle;
    if (dAng > Math.PI) dAng -= TAU;
    if (dAng < -Math.PI) dAng += TAU;
    this._prevHeadingAngle = ang;
    const yawRate = dt > 0 ? dAng / dt : 0;
    this._bank = damp(this._bank, clamp(-yawRate * 0.28, -0.6, 0.6) * this._prone, 4, dt);
    if (Math.abs(this._bank) > 1e-4 && (this.state === 'swim' || this.state === 'dead')) {
      _q.setFromAxisAngle(UP, this._bank);
      this._targetQuat.multiply(_q);
    }

    q.slerp(this._targetQuat, 1 - Math.exp(-dt * rate));

    // facing: chest when upright, head when prone
    _f.set(0, 0, 1).applyQuaternion(q);
    _u.set(0, 1, 0).applyQuaternion(q);
    if (this.state === 'attack' || this.state === 'heavyCharge' || this.state === 'parry' || this.state === 'grabbed') {
      this._facing.copy(this._aimDir);
    } else {
      this._facing.copy(_f).multiplyScalar(1 - this._prone).addScaledVector(_u, this._prone);
    }
    if (this._facing.lengthSq() < 1e-8) this._facing.copy(_f);
    this._facing.normalize();
  }

  /** Prone orientation: head along d, chest toward the seabed (or forward when vertical). */
  _composeSwim(out, d, heading, prone) {
    _v.copy(DOWN).addScaledVector(d, -d.dot(DOWN));
    _v2.copy(heading).addScaledVector(d, -d.dot(heading));
    _v.addScaledVector(_v2, 0.3);
    if (_v.lengthSq() < 1e-6) _v.copy(_v2);
    if (_v.lengthSq() < 1e-6) _v.set(0, 0, 1).addScaledVector(d, -d.z);
    quatFromUpFront(_q2, d, _v.normalize());
    // upright version facing the heading
    _u.copy(UP).addScaledVector(heading, 0.12);
    quatFromUpFront(out, _u, heading);
    out.slerp(_q2, clamp(prone, 0, 1));
    return out;
  }

  /** Chest toward `a`, body leaning in by `lean` radians. */
  _composeCombat(out, a, lean) {
    _v.copy(UP).addScaledVector(a, -a.dot(UP));
    if (_v.lengthSq() < 0.06) {
      _v2.set(0, 1, 0).applyQuaternion(this.object3d.quaternion);
      _v.copy(_v2).addScaledVector(a, -a.dot(_v2));
    }
    if (_v.lengthSq() < 1e-6) _v.set(0, 0, 1).addScaledVector(a, -a.z);
    _v.normalize();
    const c = Math.cos(lean);
    const s = Math.sin(lean);
    _u.copy(_v).multiplyScalar(c).addScaledVector(a, s);
    return quatFromUpFront(out, _u, a);
  }

  _grabFocus(e, out) {
    // look at (and stab toward) the eye if the enemy exposes one
    const hbs = e.hurtboxes;
    if (Array.isArray(hbs)) {
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < hbs.length; i++) {
        const hb = hbs[i];
        if (hb?.part !== 'eye' || !hb.center) continue;
        const d = hb.center.distanceToSquared(this.position);
        if (d < bestD) {
          bestD = d;
          best = hb;
        }
      }
      if (best) return out.copy(best.center);
    }
    if (e.forward && e.position) return out.copy(e.position).addScaledVector(e.forward, (e.length ?? 4) * 0.3);
    return out.copy(e.position ?? this.position);
  }

  // ===========================================================================
  // Grabbed / dead
  // ===========================================================================
  _updateGrabbed(dt, canAct) {
    const e = this.grabbedBy;
    if (!e || e.alive === false) {
      this.setGrabbed(null);
      return;
    }
    let mouth = null;
    try {
      mouth = e.getMouthPosition?.();
    } catch {
      mouth = null;
    }
    _v.copy(mouth ?? e.position ?? this.position);
    this.position.lerp(_v, 1 - Math.exp(-dt * 14));
    this.velocity.set(0, 0, 0);

    if (canAct && this.game.input.pressed('attack') && (this._stabT < 0 || this._stabT > 0.11)) {
      this._stabT = 0;
      this._stabCount++;
      this._attackActive = false;
      this.game.events.emit('player:attack', { type: 'grabStab', combo: this._stabCount });
    }
    if (this._stabT >= 0) {
      const prev = this._stabT;
      this._stabT += dt;
      const s = GRAB_STAB;
      if (prev < s.windup && this._stabT >= s.windup) {
        const a = this._attack;
        a.id = ++this._attackSeq;
        a.type = 'grabStab';
        a.damage = s.damage;
        a.knockback = 0;
        a.radius = RADIUS.grabStab;
        a.reach = REACH.grabStab;
        a.combo = this._stabCount;
        a.level = 0;
        a.riposte = false;
        a.hitEnemies.clear();
        this._attackActive = true;
      }
      if (this._stabT >= s.windup + s.active) this._attackActive = false;
      if (this._stabT >= s.windup + s.active && prev < s.windup + s.active) {
        this.animator.getKnifeSegment(this._rootWorld, 0, _v2, _bub);
        this.game.vfx?.spawnBubbles?.(_bub, this.game.quality === 'low' ? 2 : 5, { speed: 1.2, size: 0.016 });
      }
      if (this._stabT >= s.windup + s.active + s.recovery) this._stabT = -1;
    }
  }

  _updateDead(dt) {
    this._deadT += dt;
    // limp drift: slow sinking with gentle sway
    const sink = -0.38;
    this.velocity.y += (sink - this.velocity.y) * (1 - Math.exp(-dt * 0.8));
    this.velocity.x *= Math.exp(-dt * 1.2);
    this.velocity.z *= Math.exp(-dt * 1.2);
    this.position.addScaledVector(this.velocity, dt);
  }

  // ===========================================================================
  // Animation descriptor + look-at
  // ===========================================================================
  _updateLook(dt) {
    const g = this.game;
    let target = null;
    const lock = g.cameraRig?.lockTarget;
    if (lock && lock.alive !== false && lock.position) target = lock.position;
    else {
      const list = g.enemies?.enemies;
      if (Array.isArray(list)) {
        let best = 28 * 28;
        for (let i = 0; i < list.length; i++) {
          const e = list[i];
          if (!e || e.alive === false || !e.position) continue;
          const d = e.position.distanceToSquared(this.position);
          if (d < best) {
            best = d;
            target = e.position;
          }
        }
      }
    }
    let yaw = 0;
    let pitch = 0;
    let w = 0;
    if (target) {
      _qInv.copy(this.object3d.quaternion).invert();
      _v.subVectors(target, this.position).applyQuaternion(_qInv);
      // in prone the "look forward" axis is +Y; upright it's +Z
      const lz = _v.z * (1 - this._prone) + _v.y * this._prone;
      const ly = _v.y * (1 - this._prone) - _v.z * this._prone;
      yaw = Math.atan2(_v.x, Math.max(0.05, lz));
      pitch = -Math.atan2(ly, Math.hypot(_v.x, lz));
      w = this.state === 'swim' ? 1 - 0.55 * this._prone : this.state === 'hurt' ? 0 : 0.25;
      if (Math.abs(yaw) > 1.6) w *= 0.3; // behind: don't snap the neck
    }
    if (!this.alive) w = 0;
    const L = this._look;
    L.yaw = damp(L.yaw, yaw, 5, dt);
    L.pitch = damp(L.pitch, pitch, 5, dt);
    L.weight = damp(L.weight, w, 3, dt);
  }

  _fillAnim() {
    const a = this._anim;
    const p = this._phase;
    a.tread = p.tread;
    a.breast = p.breast;
    a.flutter = p.flutter;
    const prone = this._prone;
    a.wIdle = 1 - prone;
    a.wFlutter = prone * this._sprintW;
    a.wBreast = prone * (1 - this._sprintW);
    a.effort = this._effort;
    a.guard = this._guard * (1 - prone);
    a.speed = this.velocity.length();
    a.actionId = this._actionId;
    a.tremble = 0;
    a.stabU = -1;
    a.breathRate = 0.22 + 0.25 * (this.game.danger ?? 0) + (this.state === 'grabbed' ? 0.5 : 0);
    a.lookYaw = this._look.yaw;
    a.lookPitch = this._look.pitch;
    a.lookWeight = this._look.weight;
    switch (this.state) {
      case 'attack': {
        const heavy = this._atkKind === 'heavy';
        const t = heavy ? HEAVY : LIGHT[this._combo];
        const ph = this._phaseName;
        a.action = heavy ? 'heavy' : 'light';
        a.combo = this._combo;
        a.tau = ph === 'windup' ? saturate(this._phaseT / t.windup) : ph === 'active' ? 1 + saturate(this._phaseT / t.active) : 2 + saturate(this._phaseT / t.recovery);
        break;
      }
      case 'heavyCharge':
        a.action = 'heavyCharge';
        a.charge = this._charge;
        a.tremble = TREMBLE[this._chargeLevel];
        break;
      case 'dodge':
        a.action = 'dodge';
        a.dodgeU = clamp(this._dodgeT / PLAYER.dodgeDuration, 0, 1);
        a.dodgeBack = this._dodgeBack;
        break;
      case 'parry':
        a.action = 'parry';
        a.parryU = clamp(this._parryT / PARRY_TOTAL, 0, 1);
        a.parrySuccessU = this._parrySuccessT >= 0 ? clamp(this._parrySuccessT / 0.42, 0, 1) : -1;
        a.parryWhiffU = this._parryWhiffed ? clamp((this._parryT - this._parryWin) / PARRY_WHIFF, 0, 1) : -1;
        // the more he has been flailing, the further a miss throws him off
        // balance (fatigue is ≈ 1 after a lone whiff, up to 3 when mashing)
        a.parryWhiffAmp = 0.6 + 0.4 * clamp((this._parryFatigue - 1) / 2, 0, 1);
        break;
      case 'hurt':
        a.action = 'hurt';
        a.hurtU = clamp(this._hurtT / this._hurtDur, 0, 1);
        a.hurtDir.copy(this._hurtDir);
        a.hurtHeavy = this._hurtHeavy;
        break;
      case 'grabbed':
        a.action = 'grabbed';
        a.stabU = this._stabT >= 0 ? clamp(this._stabT / (GRAB_STAB.windup + GRAB_STAB.active + GRAB_STAB.recovery), 0, 1) : -1;
        break;
      case 'dead':
        a.action = 'dead';
        break;
      default:
        a.action = 'none';
    }
  }

  // ===========================================================================
  // Bubbles
  // ===========================================================================
  _updateBubbles(dt, moving) {
    const vfx = this.game.vfx;
    if (!vfx?.spawnBubbles || dt <= 0) return;
    const low = this.game.quality === 'low';
    // periodic exhale from the mouth; faster when danger is high
    if (this.alive) {
      this._breathT -= dt;
      if (this._breathT <= 0) {
        const danger = this.game.danger ?? 0;
        this._breathT = (3.2 + Math.random() * 2.2) * (1 - 0.45 * danger) * (this.state === 'grabbed' ? 0.4 : 1);
        this._exhale = low ? 2 : 3;
        this._exhaleT = 0;
      }
      if (this._exhale > 0) {
        this._exhaleT -= dt;
        if (this._exhaleT <= 0) {
          this._exhale--;
          this._exhaleT = 0.14;
          this._puffMouth(low ? 2 : 4, 0.7, 0.017);
        }
      }
    }
    // kick puffs
    const ph = this._phase;
    if (moving && this._mode === 'swim' && this._prevBreast < 0.68 && ph.breast >= 0.68) {
      this.animator.getBonePos('footR', this._rootWorld, _bub).lerp(this.animator.getBonePos('footL', this._rootWorld, _v3), 0.5);
      vfx.spawnBubbles(_bub, low ? 2 : 4, { speed: 0.45, size: 0.014 });
    }
    if (this._mode === 'sprint') {
      const f0 = (this._prevFlutter * 2) % 1;
      const f1 = (ph.flutter * 2) % 1;
      if (f1 < f0) {
        this.animator.getBonePos(Math.random() < 0.5 ? 'footR' : 'footL', this._rootWorld, _bub);
        vfx.spawnBubbles(_bub, low ? 1 : 2, { speed: 0.5, size: 0.012 });
      }
    }
    this._prevBreast = ph.breast;
    this._prevFlutter = ph.flutter;
  }

  _puffMouth(count, speed, size) {
    const vfx = this.game.vfx;
    if (!vfx?.spawnBubbles) return;
    this.animator.getMouth(this._rootWorld, _bub);
    vfx.spawnBubbles(_bub, count, { speed, size });
  }

  _puffBody(count, speed, size) {
    const vfx = this.game.vfx;
    if (!vfx?.spawnBubbles) return;
    _bub.copy(this.position);
    vfx.spawnBubbles(_bub, count, { speed, size });
  }
}
