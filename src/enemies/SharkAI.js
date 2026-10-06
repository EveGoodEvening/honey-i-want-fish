// Shark behaviour: tension first, then commitment.
//
//   circle ──(feint)──▶ feint ──▶ circle            silhouettes at the edge of
//      │                                            visibility, spiral tightening
//      │                                            late (aggression²), wary of a
//      │                                            diver swimming in on it; now
//      │                                            and then a murk swing out to
//      │                                            WIDE_R between attacks
//      └─(commit)─▶ approach ─▶ telegraph ─▶ attack ─▶ recover ─▶ circle
//                    │  ▲          ▲   (bite / ram / tail / shockwave)
//                    └──┘ brake-and-pivot / drive-by when 老公 is inside the
//                         turning circle (no orbiting stalemate); the boss
//                         side-snaps (head whip, no lunge) at prey tucked in
//                         beside its head; a tail whip mid-approach resumes it
//   flank (tiger pincer) ──────────┘   (armed only once the leader attacks)
//   any attack ─(parried)─▶ stagger ─▶ recover      (the boss holds still: punish window)
//   bite ─(combat grab)─▶ grab ─▶ reel (player stabbed free) | recover (spat out)
//   face-tanked (COUNTER_HITS knife hits, 老公 at the head or tail; not the
//              boss) ─▶ an immediate counter: short bite wind-up, side-snap or
//              tail slap — and while it is being carved up its bites rip
//              (harder, a shove, no grab) instead of holding
//   tail slap / ram that drew blood from still prey ─▶ the jaws next, soon
//   megalodon phase change ─▶ roar (turns to face, pressure blast) ─▶ weak window
//   megalodon phase 3: bite ─▶ recover ─▶ tail whip as the body sweeps past 老公
//   megalodon: brakes and pivots (approach / recover) when 老公 is behind it,
//              comes straight back after spitting him out (no pass, no tail
//              whip), passes overhead along the camera's sun ray
//   bite / ram: the wind-up hovers instead of nosing into him (a ram reins in
//              when he swims into it, and one with no run-up left becomes a
//              bite); the strike's volume goes live only STRIKE_LEAD after
//              CombatSystem's enemy:strike cue (forecast by strikeCue()); jaws
//              already on him at the end of the wind-up gape (up to ARM_TIME,
//              tracking him) and snap as soon as the cue has led with him
//              between them; a gaped bite announces enemy:attack at its snap
//   soft leash: out over the trench / at the edge / deep, the sharks work the
//              fight back toward the lit open water (LEASH_*)
//
// The AI writes intents (steer target/speed, pose targets, attack volumes) to
// the Shark; Shark integrates motion and animates. Attacks are only started
// while game.state === 'playing'; any other state except 'paused' (which keeps
// grabs and wind-ups) drops a running attack or grab. Multi-shark pacing
// (attack token + cooldown, "no second hit inside the first one's hit-stun")
// lives in EnemyManager.
import * as THREE from 'three';
import { clamp, smoothstep, lerp } from './noise.js';

const _target = new THREE.Vector3();
const _toP = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _inward = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);

// Soft leash: with 老公 out past LEASH_R m (over the trench / at the arena
// edge) or below LEASH_Y m, the sharks work the fight back toward the lit
// open water — a recovering shark peels off toward it, a grab drags him that
// way, a murk swing goes out on that side, the orbit rides up to LEASH_PULL
// of the way to LEASH_DEPTH (≤ LEASH_MAX m), and a new wave appears on that
// side (EnemyManager), and it works the open-water half of its circle: a
// player who follows the shark swims back into the light. Only the boss also
// circles a centre shifted toward the open water (≤ LEASH_BOSS_SHIFT m,
// ≤ LEASH_BOSS_K × its orbit radius): it never peels off after a lunge, and
// without the shift a boss fight started out over the trench stayed there
// (Node bench: fight radius median 62–67 m → 49 m). For the sharks the same
// shift measured worse (their strikes, grabs and knockbacks then come from
// the inner side and carry the fight outward).
const LEASH_DEPTH = -25;
const LEASH_R = [42, 55];
const LEASH_Y = [-45, -55];
const LEASH_PULL = 0.3;
const LEASH_MAX = 15;
const LEASH_BOSS_SHIFT = 20;
const LEASH_BOSS_K = 1.2;
// Murk swing (non-boss): between attacks, now and then (species ai.wide:
// chance per lull, cooldown s, hold s; while a tiger is out its partner
// keeps the pressure on), the shark swings out to WIDE_R m — a faint shape
// in the murk, still there under the lock reticle (off-screen arc) — holds
// there, then comes back in. The decision clock waits. Swings that were
// frequent, long and out to 38–48 m cut wave 0's attack rate by a third and
// hid the white entirely (enemies-sim gw-cadence).
const WIDE_R = [34, 40];
const WIDE_DEFAULT = { chance: 0.6, cd: [14, 22], hold: [3, 4.5] };
/** Beyond this arena radius (m) the swing heads out on the centre's side of him. */
const WIDE_INWARD_R = 20;

const ENGAGED = new Set(['approach', 'telegraph', 'attack', 'grab', 'flank']);
const BUSY = new Set(['telegraph', 'attack', 'grab', 'roar']);

/** Boss is open to ×1.3 damage this long after a roar or a shockwave. */
const WEAK_TIME = 1.2;
/** A telegraph that ends this soon after another shark hit 老公 waits (no stacked hits). */
const STACK_GAP = 0.55;
/** Longest a finished telegraph may be held back by STACK_GAP. */
const MAX_HOLD = 1.0;
/** Roar pressure blast: reach (m from the mouth) and peak shove (m/s). */
const ROAR_RANGE = 22;
const ROAR_SHOVE = 12;
/** Turn boost while the boss wheels round to face 老公 at the start of a roar. */
const ROAR_TURN = 6;
/** Within this mouth distance (m) a boss bite needs the jaws this squarely on 老公 (cosine). */
const BOSS_CLOSE = 7;
const BOSS_CLOSE_JAW = 0.35;
/** Between attacks the boss's orbit is capped this far from circleRmin toward circleRmax (it looms). */
const BOSS_LOOM = 0.4;
// Strike cue contract (bites and rams — the parryable strikes). CombatSystem
// emits enemy:strike once the forecast from strikeCue() drops to ≈0.32 s; the
// attack volume goes live only STRIKE_LEAD after that cue, so the parry cue
// always leads contact by ≥ 0.22 s (a human reaction), and never before the
// announced wind-up has run out (volumes only exist in 'attack'). A wind-up
// that ends with the jaws (nearly) on 老公 — a close start, or he swam into
// them — gapes up to ARM_TIME before the snap instead of lunging through him;
// the gape snaps early once the cue has led by STRIKE_LEAD with him already
// between the jaws (no "ghost bite" when he swims in). A gaped bite announces
// enemy:attack at the snap, not when the gape opens.
const STRIKE_LEAD = 0.22;
/** Gape first when the lunge would reach him sooner than the strike lead (+ a forecast margin). */
const ARM_TTC = STRIKE_LEAD + 0.06;
const ARM_TIME = 0.3;
/** A finished gape hangs on up to GAPE_HOLD s while his hurtbox grazes the open jaws (gap < GAPE_NEAR m), until the cue. */
const GAPE_NEAR = 0.35;
const GAPE_HOLD = 0.25;
/** A cued gape snaps at the latest this long after its cue (the lunge then has a few frames to go). */
const GAPE_LATE = STRIKE_LEAD + 0.06;
/**
 * Boss side-snap: the head cocks this long before it whips; the whip then
 * takes ≈ SNAP_REACH. The cock outlasts most of STRIKE_LEAD, so the bite is
 * live by the time the swinging head reaches him (a head swept through him
 * earlier would only shove him out of the jaws).
 */
const SNAP_COCK = 0.2;
const SNAP_REACH = 0.12;
/** Bite wind-up: within this jaw gap (× body length, at most STAND_MAX m) it brakes to a hover instead of nosing in. */
const STAND_GAP = 0.3;
const STAND_MAX = 2;
// Face-tanking (non-boss): COUNTER_HITS knife hits within COUNTER_WINDOW s
// with 老公 within COUNTER_RANGE m of the jaws, or where the tail can reach,
// and it answers at once — a short bite wind-up (the usual gape + strike cue,
// so it stays fair), a pivot onto him, or a tail slap — instead of bolting
// and letting a no-defence masher carve it up.
const COUNTER_HITS = 2;
const COUNTER_WINDOW = 4;
const COUNTER_RANGE = 4;
/** Counter bite wind-up, × the species' bite telegraph. */
const COUNTER_TELE = 0.8;
/** A counter side-snap reaches prey this far from the head pivot (× body length). */
const COUNTER_SNAP = 0.45;
/** Counter bite damage, × the species' bite (it rips and lets go: no grab). */
const COUNTER_DAMAGE = 1.5;
/** Any bite started within this many seconds of COUNTER_HITS knife hits is a rip too. */
const RIP_WINDOW = 10;
const COUNTER_STATES = new Set(['circle', 'feint', 'flank', 'approach', 'recover']);
/** Hurtbox parts a heavy thrust must hit to stop a wind-up ("a stab to the face"). */
const FACE = new Set(['eye', 'head', 'gills']);

const rand = (a, b) => a + Math.random() * (b - a);
const randRange = (r) => rand(r[0], r[1]);

export class SharkAI {
  constructor(shark) {
    this.shark = shark;
    this.game = shark.game;
    this.spec = shark.spec;
    this.cfg = shark.spec.ai;
    this.state = 'circle';
    this.t = 0;
    this.orbitDir = Math.random() < 0.5 ? 1 : -1;
    this.radius = this.cfg.circleRmax + 6;
    this.aggression = 0;
    this.decisionTimer = randRange(this.cfg.firstCommit);
    this.feints = this.cfg.initialFeints;
    this.kind = 'bite';
    this._lastStrike = null; // kind of the last bite / ram / slam launched (no ram follows a ram)
    this.teleDur = 0.7;
    this.chain = 0;
    this.tailCd = 3;
    this.shockCd = 2;
    this.depthSeed = Math.random() * 100;
    this.phase = 1; // megalodon phases 1..3
    this.pendingRoar = false;
    this.coilSide = 1;
    this.lungeDir = new THREE.Vector3(0, 0, 1);
    this.feintSide = new THREE.Vector3();
    this.feintOffset = 3;
    this.feintRise = 0;
    this.feintPassed = false;
    this.feintMaxT = 12;
    this._overhead = false; // current feint is a boss pass across the light
    this.shockCenter = new THREE.Vector3();
    this.flankLeader = null;
    this.flankDelay = 0;
    this.flankArmed = false;
    this.feintMinD = Infinity;
    this._firstDecisionDone = false;
    this._firstCommitDone = false;
    this.recoverTime = this.cfg.recoverTime;
    this.rollDir = 1;
    this.playing = false;
    this.frenzy = false;
    this.speedMul = 1;
    // Approach: time 老公 has spent inside our turning circle, and the
    // drive-by (overshoot, come back head-on) that breaks the orbit.
    this._closeT = 0;
    this._driveBy = false;
    this._driveByT = 0;
    this._driveBys = 0;
    this._driveTarget = new THREE.Vector3();
    this._resumeKind = null; // committed attack to resume after a mid-approach tail whip
    this._resumed = false;
    this._tailFollowUp = false; // boss phase 3: whip the tail after a bite
    // Boss: it has just spat 老公 out. Until its next strike it comes straight
    // back for him — quick decision, a bite, no feint, no opportunistic tail whip.
    this._afterGrab = false;
    this._snap = false; // current bite is a sideways head-snap (boss)
    this._closeBite = false; // current bite is the boss's close-range lunge
    this._snapYaw = 0;
    this._snapPitch = 0;
    this._snapDist = 0;
    this._snapAlong = 0;
    this._holdT = 0; // telegraph held back by STACK_GAP
    this._weakT = 0; // boss weak window (after roar / shockwave)
    this._hitLog = [-Infinity, -Infinity, -Infinity, -Infinity]; // game times of the last knife hits
    this._hitNext = 0;
    this._countering = false; // current wind-up / strike answers face-tanking (_counter)
    this._pressBite = false; // next commit is a bite (pressing after a ram / tail slap drew blood)
    // Murk swing (see WIDE_*): 0 none, 1 swinging out, 2 holding out there.
    this._wide = 0;
    this._wideT = 0;
    this._wideR = 0;
    this._wideCd = randRange((this.cfg.wide ?? WIDE_DEFAULT).cd);
    // The running bite / ram (see STRIKE_LEAD): its volume id, the gape still
    // to hold, the cue (from CombatSystem's enemy:strike) and the lunge model
    // the forecast uses (launch speed v0, top speed vmax, accel).
    this._strike = { type: null, id: 0, armT: 0, hold: 0, cued: false, cueAt: 0, live: false, v0: 0, vmax: 0, accel: 0, gapPrev: 0, gapAt: -1 };
    // snap / point: a side-snap and where its jaws will shut (see strikeCue).
    this._strikeOut = { id: 0, type: 'bite', eta: 0, snap: false, point: null };
    this._snapPoint = new THREE.Vector3();
    this._lungeT0 = 0; // attack time at which the lunge left the gape
    // Per-frame relations to the player.
    this.dist = 100;
    this.mouthDist = 100;
    this.facing = 0;
    this.jawFacing = 0;
  }

  isEngaged() {
    return ENGAGED.has(this.state);
  }

  /**
   * A side-snap (head whip, no lunge — the boss's, or a counter's) is under
   * way: true from the moment it is chosen (before its enemy:telegraph goes
   * out) through the cocked head and the whip, until the attack ends.
   */
  get snapping() {
    return this._snap && this.kind === 'bite' && (this.state === 'telegraph' || this.state === 'attack');
  }

  // ------------------------------------------------------------------ frame

  update(dt) {
    const g = this.game;
    const sh = this.shark;
    this.t += dt;
    this.tailCd -= dt;
    this.shockCd -= dt;
    this._wideCd -= dt;
    this._weakT = Math.max(0, this._weakT - dt);
    const player = g.player;
    // 'paused' counts as playing: pausing keeps a grab (CombatSystem's
    // contract) and a wind-up resumes where it was. Normally no update runs
    // while paused (dt = 0); this covers the frame the pause lands in.
    const st = g.state;
    this.playing = (st === 'playing' || st === 'paused') && player && player.alive !== false;

    const p = player.position;
    _toP.subVectors(p, sh.position);
    this.dist = _toP.length();
    this.facing = this.dist > 1e-4 ? _toP.dot(sh.forward) / this.dist : 1;
    // Same, seen from the jaws: at close range a player can be "ahead" of the
    // body centre yet beside the gills, out of the mouth's reach.
    _toP.subVectors(p, sh.getMouthPosition());
    this.mouthDist = _toP.length();
    this.jawFacing = this.mouthDist > 1e-4 ? _toP.dot(sh.forward) / this.mouthDist : 1;

    const hp = sh.health / sh.maxHealth;
    this.frenzy = hp < 0.3 || this.phase >= 3;
    this.speedMul = (this.frenzy ? 1.18 : 1) * (this.phase >= 2 ? 1.08 : 1);
    sh.vulnerable = this.state === 'stagger' || this._weakT > 0;

    sh.resetPoseTargets();

    if (!this.playing) {
      if (this.state === 'grab') sh.releaseGrab(false);
      else if (this.state === 'approach' || this.state === 'telegraph' || this.state === 'attack' || this.state === 'flank') this._recover(1.2);
    }
    if (this.pendingRoar && !BUSY.has(this.state)) this._enter('roar');

    switch (this.state) {
      case 'circle': this._circle(dt); break;
      case 'feint': this._feint(dt); break;
      case 'approach': this._approach(dt); break;
      case 'flank': this._flank(dt); break;
      case 'telegraph': this._telegraph(dt); break;
      case 'attack': this._attack(dt); break;
      case 'recover': this._recoverUpdate(dt); break;
      case 'stagger': this._stagger(dt); break;
      case 'grab': this._grab(dt); break;
      case 'reel': this._reel(dt); break;
      case 'roar': this._roar(dt); break;
      default: this._enter('circle');
    }

    // Weak window: the boss visibly sags — slow tail, jaw ajar, fins dropped.
    if (this._weakT > 0 && this.state !== 'stagger') {
      const T = sh.poseT;
      T.amp *= 0.55;
      T.freqScale *= 0.8;
      T.jaw = Math.max(T.jaw, 0.22);
      T.pecDrop = Math.max(T.pecDrop, 0.5);
    }
  }

  _enter(name) {
    // A committed approach interrupted by a tail whip resumes after it
    // (see _tryTailSwipe / _afterAttack); anything else drops that intent.
    if (name !== 'telegraph' && name !== 'attack') {
      this._resumeKind = null;
      this._snap = false;
      this._countering = false;
    }
    if (name !== 'recover') this._tailFollowUp = false;
    if (name !== 'circle' && this._wide) this._endWide();
    if (name !== 'recover' && name !== 'circle' && name !== 'approach' && name !== 'telegraph') this._afterGrab = false;
    this._strike.type = null; // _startAttack arms the next one after entering 'attack'
    this._strike.armT = 0;
    this.state = name;
    this.t = 0;
    this.shark.state = name;
    if (name === 'approach') {
      this._closeT = 0;
      this._driveBy = false;
      this._driveBys = 0;
    } else if (name === 'telegraph') {
      this._holdT = 0;
    }
    if (name === 'roar') this._startRoar();
  }

  _manager() {
    return this.shark.manager;
  }

  /**
   * Side-snap aim: yaw / pitch of 老公 seen from the head pivot (for a head
   * whip), plus his distance and along-axis offset from it. Returns true.
   */
  _snapAim() {
    const sh = this.shark;
    _tmp2.copy(sh.position).addScaledVector(sh.forward, (this.spec.sOrigin - this.spec.headS) * sh.length);
    _tmp2.subVectors(this.game.player.position, _tmp2);
    const along = _tmp2.dot(sh.forward);
    const lat = _tmp2.dot(sh.right);
    const fwd = Math.max(0.3, along);
    this._snapYaw = clamp(Math.atan2(lat, fwd), -0.95, 0.95);
    this._snapPitch = clamp(Math.atan2(_tmp2.dot(sh.up), Math.hypot(fwd, lat)), -0.5, 0.5);
    this._snapDist = _tmp2.length();
    this._snapAlong = along;
    return true;
  }

  /** 老公 is within a jaw's reach of the mouth's level (not metres above / below it). */
  _jawsLevel() {
    const sh = this.shark;
    _tmp2.subVectors(this.game.player.position, sh.getMouthPosition());
    return Math.abs(_tmp2.dot(sh.up)) < 0.18 * sh.length;
  }

  /** Head yaw (radians, clamped to ±max) that points the snout at `point`. */
  _headYawTo(point, max) {
    const sh = this.shark;
    _tmp2.subVectors(point, sh.getMouthPosition());
    return clamp(Math.atan2(_tmp2.dot(sh.right), Math.max(0.5, _tmp2.dot(sh.forward))), -max, max);
  }

  // ------------------------------------------------------------------ states

  _circle(dt) {
    const cfg = this.cfg;
    if (this.playing && !this._wide) this.aggression = Math.min(1, this.aggression + dt * cfg.aggressionRate);
    // The spiral tightens late (aggression²; the boss linearly — it looms):
    // most of the circling happens out where it is a shape in the murk.
    const tight = this.shark.isBoss ? this.aggression : this.aggression * this.aggression;
    let Rt = lerp(cfg.circleRmax, cfg.circleRmin, tight) * (this.frenzy ? 0.72 : 1);
    let rate = 0.45;
    let speed = 1;
    let lookScale = 1;
    if (this._wide) {
      // Murk swing: out to the edge of visibility at approach speed (mostly
      // straight out on the way, so a player who gives chase does not close),
      // hold, then back in.
      const st = this.spec.stats;
      Rt = this._wideR;
      rate = 1.6;
      speed = st.approachSpeed / st.circleSpeed;
      if (this._wide === 1) {
        lookScale = 0.35;
        this._wideT -= dt;
        if (this.dist > this._wideR - 4 || this._wideT < -6) {
          this._wide = 2;
          this._wideT = randRange((this.cfg.wide ?? WIDE_DEFAULT).hold);
        }
      } else if ((this._wideT -= dt) <= 0) this._endWide();
    } else if (!this.shark.isBoss) {
      // Wary while it circles: a diver swimming in on it is kept at the
      // orbit's distance (it out-swims him back out) — he meets the shark
      // when it commits, not by running it down.
      const st = this.spec.stats;
      speed = lerp(1, st.approachSpeed / st.circleSpeed, smoothstep(0.9 * this.radius, 0.6 * this.radius, this.dist));
    }
    this.radius += (Rt - this.radius) * (1 - Math.exp(-dt * rate));
    this._orbitSteer(speed, lookScale);

    if (!this.playing || this._wide) return;
    if (this._tryTailSwipe()) return;
    this.decisionTimer -= dt;
    if (this.decisionTimer <= 0) this._decide();
  }

  /** Between attacks: now and then start a murk swing (non-boss, calm, off cooldown, one per pack at a time). */
  _maybeWide() {
    if (this.shark.isBoss || this.frenzy || !this._firstCommitDone || this.aggression >= 0.5) return;
    if (this._wideCd > 0 || Math.random() >= (this.cfg.wide ?? WIDE_DEFAULT).chance) return;
    const mgr = this._manager();
    for (const e of mgr.enemies) if (e !== this.shark && e.alive && e.ai._wide) return;
    this._startWide();
    // A pack keeps the pressure on: while this one fades into the murk, a
    // circling partner comes in soon.
    for (const e of mgr.enemies) {
      if (e !== this.shark && e.alive && e.ai.state === 'circle') e.ai.decisionTimer = Math.min(e.ai.decisionTimer, rand(0.8, 1.6));
    }
  }

  _startWide() {
    this._wide = 1;
    this._wideT = 0; // counts the swing-out (it holds once out there, or after 6 s)
    this._wideR = randRange(WIDE_R);
  }

  _endWide() {
    this._wide = 0;
    this._wideCd = randRange((this.cfg.wide ?? WIDE_DEFAULT).cd);
  }

  /**
   * Orbit centre: 老公 — raised toward LEASH_DEPTH when he is deep (soft
   * leash, see LEASH_*). Returns `out`; also leaves in `_inward` the pull
   * toward the lit open water: the horizontal unit direction to the arena
   * centre × the edge weight, plus +y × the depth weight (all 0 in the open).
   */
  _leashCentre(out) {
    const p = this.game.player.position;
    out.copy(p);
    _inward.set(0, 0, 0);
    const r = Math.hypot(p.x, p.z);
    const wR = smoothstep(LEASH_R[0], LEASH_R[1], r);
    const wY = smoothstep(LEASH_Y[0], LEASH_Y[1], p.y);
    if (wR > 0 && r > 1e-3) _inward.set((-p.x / r) * wR, 0, (-p.z / r) * wR);
    if (wY > 0) {
      _inward.y = wY;
      out.y += Math.min(LEASH_PULL * (LEASH_DEPTH - p.y), LEASH_MAX) * wY;
    }
    return out;
  }

  /** Steers along the orbit (this.radius) around 老公 (or the leash centre), at depth bias + wander. */
  _orbitSteer(speedScale, lookScale = 1) {
    const sh = this.shark;
    const cfg = this.cfg;
    const c = this._leashCentre(_centre);
    const leashed = _inward.x * _inward.x + _inward.z * _inward.z > 1e-4;
    // The leashed boss circles a centre pulled toward the open water (see
    // LEASH_BOSS_*): it hangs on the light's side of him.
    if (leashed && sh.isBoss) {
      const k = Math.min(LEASH_BOSS_SHIFT, LEASH_BOSS_K * this.radius);
      c.x += _inward.x * k;
      c.z += _inward.z * k;
    }
    const ang = Math.atan2(sh.position.z - c.z, sh.position.x - c.x);
    const look = clamp(Math.max(7, sh.speed * 2.4) / this.radius, 0.12, 1.1) * lookScale;
    const inAng = Math.atan2(-c.z, -c.x); // toward the arena centre
    const da = Math.atan2(Math.sin(inAng - ang), Math.cos(inAng - ang));
    // Leashed: it works the open-water half of its circle, turning back the
    // short way when it rounds out of it.
    if (leashed && Math.abs(da) > Math.PI * 0.5) this.orbitDir = da > 0 ? 1 : -1;
    let ta = ang + this.orbitDir * look;
    if (this._wide && Math.hypot(c.x, c.z) > WIDE_INWARD_R) {
      // The murk swing heads out on the open-water side of him (a player
      // who follows the silhouette swims back toward the centre, not off
      // over the trench) and hangs there.
      ta = ang + clamp(da, -look, look);
    }
    const depth = c.y + cfg.depthBias + Math.sin(this.game.time.elapsed * 0.11 + this.depthSeed) * cfg.depthWander;
    _target.set(c.x + Math.cos(ta) * this.radius, depth, c.z + Math.sin(ta) * this.radius);
    // The megalodon's turning circle (16 m) is wider than its tightest orbit:
    // a little extra rudder keeps it hemming 老公 in instead of drifting off.
    sh.setSteer(_target, this.spec.stats.circleSpeed * this.speedMul * speedScale, sh.isBoss ? 1.35 : 1);
  }

  _decide() {
    const sh = this.shark;
    const mgr = this._manager();
    const cfg = this.cfg;
    if (mgr.anyGrabbing(sh)) {
      this.decisionTimer = 1;
      return;
    }
    // The wave's very first move is always a pass: let the player see it
    // before anything bites (once per wave — a pack partner may go straight in).
    const reveal = !this._firstDecisionDone && !mgr.revealDone;
    // The boss keeps an armed pass for when it is lined up for one. Only one
    // shark makes the opening pass: a pack partner's first move is a commit
    // (its pass stays armed for later).
    const canPass = reveal || !sh.isBoss || this._passLinedUp();
    if (this.feints > 0 && canPass && (reveal || (this._firstCommitDone && Math.random() < cfg.feintChance))) {
      if (reveal) mgr.revealDone = true;
      this._firstDecisionDone = true;
      this.feints--;
      this._startFeint(reveal);
      return;
    }
    this._firstDecisionDone = true;
    if (!mgr.requestToken(sh)) {
      this.decisionTimer = 0.8 + Math.random();
      return;
    }
    this.kind = this._chooseAttack();
    this.chain = this.phase >= 3 && this.kind === 'bite' ? 2 : 0;
    this._resumed = false;
    this._enter('approach');
    mgr.onCommit(sh);
  }

  _chooseAttack() {
    const cfg = this.cfg;
    // The first committed attack of a wave is always the iconic bite.
    if (!this._firstCommitDone) {
      this._firstCommitDone = true;
      return 'bite';
    }
    if (this.spec.attacks.shockwave && this.phase >= 2 && this.shockCd <= 0 && Math.random() < 0.4) return 'shockwave';
    // Never two rams in a row: after a ram the next strike is the jaws (or a
    // slam), so a fight cannot go 40 s without a bite. Having just spat 老公
    // out, the boss comes back with its jaws too.
    if (this._lastStrike === 'ram' || this._afterGrab || this._pressBite) {
      this._pressBite = false;
      return 'bite';
    }
    if (this.dist > cfg.ramRange * 0.9 && Math.random() < 0.25) return 'ram';
    if (Math.random() < cfg.ramChance) return 'ram';
    return 'bite';
  }

  /**
   * Boss: can it sweep across the light from here? The pass point (see
   * _sunRayPoint) must lie ahead of it and outside its turning circle —
   * otherwise the 16 m body would only circle it and never get across.
   */
  _passLinedUp() {
    const sh = this.shark;
    const p = this.game.player.position;
    if (!this._sunRayPoint(p, 6.5, _tmp2)) return this.dist > 15 && this.facing > 0.5;
    _tmp.subVectors(_tmp2, sh.position);
    const d = _tmp.length();
    return d > 8 && _tmp.dot(sh.forward) > 0.3 * d && !sh.insideTurnCircle(_tmp2, 1.15);
  }

  /** `reveal`: the shark's very first decision (the boss's opening pass is scripted overhead). */
  _startFeint(reveal = false) {
    const sh = this.shark;
    const g = this.game;
    const p = g.player.position;
    const pr = g.player.radius ?? 0.45;
    // Pass beside (or under/over) the player: perpendicular to the approach line.
    _tmp.subVectors(p, sh.position);
    _tmp.y = 0;
    if (_tmp.lengthSq() < 1e-4) _tmp.copy(sh.forward);
    _tmp.normalize();
    const side = Math.random() < 0.5 ? 1 : -1;
    this.feintSide.set(-_tmp.z * side, 0, _tmp.x * side);
    // The boss usually passes high, on the side the light comes from, so its
    // silhouette slides across the Snell window and swallows the sun.
    const overhead = sh.isBoss && (reveal || Math.random() < 0.7);
    this._overhead = overhead;
    if (overhead) {
      // 5–8 m above 老公 (7 m for the reveal), on the sun ray through him.
      this.feintRise = reveal ? 7 : rand(5, 8);
      const sun = g.env?.sunDirection;
      const sunH = sun ? Math.hypot(sun.x, sun.z) : 0;
      if (sun && sunH > 0.05 && sun.y > 0.2) {
        // Put the pass point on the sun ray through 老公.
        this.feintSide.set(sun.x / sunH, 0, sun.z / sunH);
        this.feintOffset = Math.max(4 + pr, (this.feintRise * sunH) / sun.y);
      } else {
        this.feintOffset = Math.max(4, randRange(this.cfg.feintOffset)) + pr;
      }
    } else {
      // Some passes are bumps: the body brushes right past the player.
      const bump = Math.random() < 0.35;
      this.feintOffset = bump ? 0.6 + 0.07 * sh.length + pr : randRange(this.cfg.feintOffset) + pr;
      this.feintRise = rand(-1.5, 1.5) * (sh.isBoss ? 3 : 1);
    }
    // The boss's passes are short and fast (no 10 s loiter). Its opening pass
    // starts far out in the murk, so it gets enough time to arrive.
    const speed = this.spec.stats.approachSpeed * (sh.isBoss ? 1 : 0.8);
    this.feintMaxT = sh.isBoss ? (reveal ? clamp(this.dist / speed + 3, 6, 8) : 5.6) : 12;
    this.feintPassed = false;
    this.feintMinD = Infinity;
    this._enter('feint');
  }

  /**
   * Overhead pass point: `rise` m above 老公, on the sun ray through the
   * camera — where the body must be to swallow the light in the player's own
   * view (the camera sits metres behind him, so the ray through him misses).
   * Re-aimed every frame until the pass, so it follows the camera round.
   * False (caller falls back to the ray through 老公) without a usable
   * camera or sun.
   */
  _sunRayPoint(p, rise, out) {
    const g = this.game;
    const cam = g.camera?.position;
    const sun = g.env?.sunDirection;
    if (!cam || !sun || sun.y < 0.2 || cam.distanceToSquared(p) > 15 * 15) return false;
    const t = (p.y + rise - cam.y) / sun.y;
    if (t <= 0) return false;
    out.copy(cam).addScaledVector(sun, t);
    return true;
  }

  _feint(dt) {
    const sh = this.shark;
    const p = this.game.player.position;
    const T = sh.poseT;
    if (!this.feintPassed) {
      if (!(this._overhead && this._sunRayPoint(p, this.feintRise, _target))) {
        _target.copy(p).addScaledVector(this.feintSide, this.feintOffset);
        _target.y += this.feintRise;
      }
      // The pass point is "behind" only once we are actually near it (at
      // feint start it may well be beside a shark that is still orbiting).
      _tmp.subVectors(_target, sh.position);
      const near = sh.length * 0.6 + this.feintOffset + 2;
      const d = _tmp.length();
      const st = this.spec.stats;
      let speed = st.approachSpeed * (sh.isBoss ? 1 : 0.8) * this.speedMul;
      let decel = st.decel;
      if (this._overhead) {
        // It eases off as it slides into the light: the body hangs across
        // the sun instead of flicking through it.
        speed = lerp(speed, st.circleSpeed * 0.8, smoothstep(near + 6, near, d));
        decel *= 2;
      }
      sh.setSteer(_target, speed, 1.15, st.accel, decel);
      // Closest approach reached (big sharks may circle a point inside their turning radius).
      const receding = this.feintMinD < near && d > this.feintMinD + 1.5;
      this.feintMinD = Math.min(this.feintMinD, d);
      if ((_tmp.dot(sh.forward) < 0 && d < near) || d < 2 || receding) {
        this.feintPassed = true;
        this.t = 0;
      }
      if (this.t > this.feintMaxT) this._backToCircle(1.5);
    } else {
      _target.copy(sh.position).addScaledVector(sh.forward, 20);
      // Having crossed the light, an overhead pass lingers in a slow, looming glide.
      const st = this.spec.stats;
      if (this._overhead) sh.setSteer(_target, st.circleSpeed * 0.6, 0.5, st.accel, st.decel * 2);
      else sh.setSteer(_target, st.circleSpeed * 1.1, 0.5);
      if (this.t > (sh.isBoss ? (this._overhead ? 2.0 : 1.2) : 2.0)) {
        this.aggression = Math.min(1, this.aggression + 0.12);
        // The boss wheels round for 老公 almost at once (it already looms).
        this._backToCircle(sh.isBoss ? rand(0.8, 1.6) : rand(1.5, 3.5));
      }
    }
    T.amp = 1.15;
    if (this.dist < 8) T.pecDrop = 0.3;
    // A pass is a pass: no tail whip on the way in (only once it has gone by).
    if (this.playing && this.feintPassed) this._tryTailSwipe();
  }

  _approach(dt) {
    const sh = this.shark;
    const cfg = this.cfg;
    const st = this.spec.stats;
    const player = this.game.player;
    const p = player.position;
    const boss = sh.isBoss;
    const T = sh.poseT;
    T.amp = 1.25;
    T.freqScale = 1.15;
    T.pecDrop = 0.15;
    const giveUpT = boss ? 18 : 12; // failsafe only

    if (this._driveBy) {
      // Overshoot past 老公, then come back round head-on.
      sh.setSteer(this._driveTarget, st.approachSpeed * this.speedMul, 1.1);
      this._driveByT += dt;
      _tmp.subVectors(this._driveTarget, sh.position);
      const reached = this._driveByT > 0.6 && (_tmp.dot(sh.forward) < 0 || _tmp.lengthSq() < 9);
      if (reached || this._driveByT > (boss ? 4.5 : 3)) {
        this._driveBy = false;
        this._closeT = 0;
      }
      if (this._tryTailSwipe()) return;
      if (this.t > giveUpT) this._giveUp();
      return;
    }

    const lead = clamp(this.mouthDist / st.approachSpeed, 0, 1) * 0.5;
    _target.copy(p);
    if (player.velocity) _target.addScaledVector(player.velocity, lead);
    if (this.kind === 'ram' && this.mouthDist < 7) this.kind = 'bite';
    // The boss pivots during its wind-up, so it may start less squarely aligned.
    const minFacing = boss ? 0.45 : 0.6;

    // Not lined up and either inside lunge range or inside our own turning
    // circle (unreachable at this speed): brake hard and pivot on the spot
    // (below minTurnSpeed the turning circle collapses to under a metre for
    // the white) — the same braking pivot the bite wind-up uses. Without this
    // a player beside or behind the shark sits inside its turning circle forever.
    const turnBoost = this.frenzy ? 1.7 : 1.25;
    // A ram barely steers once launched, so it needs to be squarely lined up.
    let lined = this.facing > (this.kind === 'ram' ? 0.8 : minFacing) && this.jawFacing > 0.2;
    // Close in, the boss's jaws must actually point at him: a 16 m body
    // cannot swing its mouth onto prey beside its head during the lunge (it
    // pivots on, or whips its head round — see below).
    if (boss && lined && this.mouthDist < BOSS_CLOSE && this.jawFacing < BOSS_CLOSE_JAW) lined = false;
    // The boss also wheels round on the spot when 老公 is behind it (after a
    // pass): a 16 m body swimming its turning circle would carry it 30 m off.
    const braking = this.kind !== 'shockwave' && !lined
      && (this.mouthDist < cfg.lungeRange * 1.1 || sh.insideTurnCircle(_target, turnBoost) || (boss && this.facing < 0));
    if (braking) {
      // The boss needs a harder rudder: at 3× its 16 m turning radius still
      // leaves a 3 m pivot circle, with a flank-hugging 老公 at its centre.
      if (boss) sh.setSteer(_target, st.cruise * 0.3, 5.0, st.accel, st.decel * 2.2);
      else sh.setSteer(_target, st.cruise * 0.4, 3.0, st.accel, st.decel * 2.2);
      T.pecDrop = 0.7; // pectorals flare as it brakes
      T.amp = 0.8;
      T.arch = 0.3;
    } else {
      sh.setSteer(_target, st.approachSpeed * this.speedMul, turnBoost);
    }

    // Still inside our turning circle after 1.5 s — or tucked in beside the
    // head, behind the jaws, where no amount of turning brings the mouth to
    // bear: drive on past 老公 (12–15 m beyond him along our heading) and
    // come back round head-on.
    const deadZone = this.jawFacing < 0.2 && this.facing > 0 && this.mouthDist < cfg.lungeRange * 0.5;
    // The megalodon does not swim off from prey tucked in beside its head: it
    // whips the head round and snaps sideways (no lunge — head and jaws reach).
    if (boss && this.kind === 'bite' && deadZone && this._snapAim() && this._snapDist < 5.8 && this._snapAlong > -1.5) {
      this._startTelegraph('bite', 0.7, true);
      return;
    }
    if (deadZone || this.dist < 1.2 * sh.turnPathRadius()) this._closeT += dt;
    else this._closeT = Math.max(0, this._closeT - dt);
    if (this._closeT > 1.5 && this._driveBys < 2) {
      this._driveBys++;
      this._driveBy = true;
      this._driveByT = 0;
      _tmp.subVectors(p, sh.position);
      this._driveTarget.copy(sh.position).addScaledVector(sh.forward, Math.max(0, _tmp.dot(sh.forward)) + rand(12, 15));
      return;
    }

    if (this.kind === 'shockwave') {
      if (this.dist < cfg.shockRange) {
        this._startTelegraph('shockwave');
        return;
      }
    } else {
      const range = this.kind === 'bite' ? cfg.lungeRange : cfg.ramRange;
      if (this.mouthDist < range && lined) {
        this._startTelegraph(this.kind);
        return;
      }
      // The megalodon snaps its head sideways at prey right beside its jaws
      // (not beside its gills: the pivot brings those round first). Prey more
      // beside than ahead of the jaws gets the head whip: a lunge along the
      // body axis would carry the mouth past him.
      if (boss && this.kind === 'bite' && this.jawFacing > -0.15 && this.mouthDist < 6.5 && this._jawsLevel()) {
        const whip = this.jawFacing < BOSS_CLOSE_JAW && this._snapAim() && this._snapDist < 5.8 && this._snapAlong > -1.5;
        if (whip || this.jawFacing >= BOSS_CLOSE_JAW) {
          this._startTelegraph('bite', whip ? 0.7 : 0.8, whip);
          this._closeBite = !whip;
          return;
        }
        // Too far off the jaws' line for either: keep pivoting onto him.
      }
    }
    if (this._tryTailSwipe()) return;
    if (this.t > giveUpT) this._giveUp();
  }

  beginFlank(leader) {
    if (this.state !== 'circle' && this.state !== 'feint') return;
    if (!this.playing) return;
    this.flankLeader = leader;
    this.flankArmed = false;
    this.flankDelay = 0;
    this._enter('flank');
  }

  _flank(dt) {
    const sh = this.shark;
    const leader = this.flankLeader;
    const p = this.game.player.position;
    const ls = leader?.alive ? leader.ai?.state : null;
    const leaderEngaged = ls === 'approach' || ls === 'telegraph' || ls === 'attack';
    if (!leaderEngaged && !this.flankArmed) {
      if (this.t > 0.4) this._backToCircle(rand(1, 2.5));
      return;
    }
    // Get behind / below the player relative to the leader's line of attack.
    _tmp.subVectors(p, leader?.alive ? leader.position : sh.position);
    _tmp.y = 0;
    if (_tmp.lengthSq() < 1e-4) _tmp.set(1, 0, 0);
    _tmp.normalize();
    _target.copy(p).addScaledVector(_tmp, 8);
    _target.y -= 3.5;
    sh.setSteer(_target, this.spec.stats.approachSpeed * this.speedMul, 1.3);
    sh.poseT.amp = 1.2;
    // The countdown starts only once the leader actually lunges, so the second
    // bite arrives after the first hit instead of inside its hit-stun.
    if (!this.flankArmed) {
      if (ls === 'attack') {
        this.flankArmed = true;
        this.flankDelay = rand(0.35, 0.6);
      }
    } else {
      this.flankDelay -= dt;
      if (this.flankDelay <= 0) {
        if (this.mouthDist < this.cfg.lungeRange * 1.7 && this.facing > 0.3) {
          this._startTelegraph('bite', 0.85);
          return;
        }
        // Give it a few seconds to swing in behind him (it may still be out wide).
        if (this.flankDelay < -3) {
          this._backToCircle(rand(1, 2.5));
          return;
        }
      }
    }
    if (this.t > 8) this._backToCircle(1.5);
  }

  /** `snap`: the bite is a side-snap (head whip) — set before enemy:telegraph goes out, so listeners see `snapping`. */
  _startTelegraph(kind, durMul = 1, snap = false) {
    const sh = this.shark;
    const atk = this.spec.attacks[kind];
    if (!atk) return;
    this.kind = kind;
    this._snap = snap && kind === 'bite';
    this._closeBite = false; // the boss's close-range bite: the caller sets it after this
    let dur = atk.telegraph * durMul;
    if (this.phase >= 2) dur *= 0.85;
    if (this.frenzy) dur *= 0.88;
    this.teleDur = dur;
    if (kind === 'tail') {
      _tmp.subVectors(this.game.player.position, sh.position);
      this.coilSide = _tmp.dot(sh.right) >= 0 ? 1 : -1;
    }
    this._enter('telegraph');
    this.game.events.emit('enemy:telegraph', { enemy: sh, type: kind, duration: dur });
  }

  _telegraph(dt) {
    const sh = this.shark;
    const st = this.spec.stats;
    const player = this.game.player;
    const p = player.position;
    const T = sh.poseT;
    const u = clamp(this.t / this.teleDur, 0, 1);
    switch (this.kind) {
      case 'bite':
        if (this._snap) {
          // Side-snap wind-up: the head cocks away from him, jaws parting.
          this._snapAim();
          sh.setSteer(p, st.cruise * 0.3, 5, st.accel, st.decel * 2.2);
          T.headYaw = -0.35 * this._snapYaw * u;
          T.arch = 0.6;
          T.pecDrop = 1;
          T.jaw = 0.2 + 0.5 * u;
          T.snout = 0.5 * u;
          T.amp = 0.5;
          T.freqScale = 1.6;
          break;
        }
        // Threat posture: pivot to face, hunch the back, drop the pectorals,
        // jaw starts to part, stiff jerky strokes; the head cocks toward 老公.
        // Close in, it brakes to a hover rather than nosing on into him: the
        // jaws must not reach him during the wind-up (the old cause of bites
        // landing with no strike cue), and the lunge needs the room.
        _target.copy(p);
        if (player.velocity) _target.addScaledVector(player.velocity, 0.3);
        const hold = smoothstep(Math.min(STAND_GAP * sh.length, STAND_MAX), 0, this._jawGap('bite'));
        sh.setSteer(_target, lerp(st.cruise * 0.5, 0.3, hold), 3.2, st.accel, st.decel * (2.2 + 3 * hold));
        T.arch = 1;
        T.pecDrop = 1;
        // The boss's wind-up opens wider and thrusts the upper jaw out: a
        // megalodon reads by its teeth.
        T.jaw = 0.12 + (sh.isBoss ? 0.66 : 0.42) * u;
        T.jawOpenRate = 4;
        T.snout = (sh.isBoss ? 0.6 : 0.35) * u;
        T.protrude = (sh.isBoss ? 0.6 : 0.2) * u;
        T.headPitch = 0.05;
        T.headYaw = this._headYawTo(p, sh.isBoss ? 0.45 : 0.3) * u;
        T.amp = 0.5;
        T.freqScale = 1.7;
        break;
      case 'ram': {
        // A diver swimming into the charge: it reins in once the snout is
        // within the ram's reach (the strike would become a gaped bite at
        // the wind-up's end — see _startAttack — and a gape needs it slow).
        const hold = smoothstep(this._ramReach(), 0.5 * this._ramReach(), this._jawGap('ram'));
        sh.setSteer(p, lerp(st.approachSpeed * 0.95 * this.speedMul, 0.3, hold), 2.2, st.accel, st.decel * (1 + 4 * hold));
        T.pecDrop = 1;
        T.arch = 0.35;
        T.headPitch = -0.12;
        T.amp = 1.35;
        T.freqScale = 1.45;
        break;
      }
      case 'tail': {
        _target.copy(sh.position).addScaledVector(sh.forward, 10);
        sh.setSteer(_target, st.cruise * 0.5, 0.5);
        // Cock the tail away from the player before the whip.
        T.coil = this.coilSide * 0.85 * smoothstep(0, 1, u);
        T.coilRate = 7;
        T.pecDrop = 0.6;
        T.amp = 0.3;
        break;
      }
      case 'shockwave':
        _target.copy(sh.position).addScaledVector(sh.forward, 12);
        _target.y += 5;
        sh.setSteer(_target, st.cruise * 0.6, 0.8, st.accel, st.decel, 0.6);
        T.arch = -1.3 * smoothstep(0, 1, u); // tail lifts
        T.archRate = 3;
        T.pecDrop = 1;
        T.jaw = 0.3;
        T.amp = 0.4;
        break;
      default:
        break;
    }
    if (this.t >= this.teleDur) {
      const mgr = this._manager();
      if (mgr.anyGrabbing(sh)) {
        // Another shark has 老公 in its jaws: back off rather than pile in.
        this._recover(1.0);
        return;
      }
      // Hold the wind-up while 老公 is still reeling from another shark's hit.
      if (this._holdT < MAX_HOLD && mgr.hitByOtherWithin?.(sh, STACK_GAP)) {
        this._holdT += dt;
        return;
      }
      this._startAttack();
    }
  }

  _startAttack() {
    const sh = this.shark;
    const g = this.game;
    // A ram whose snout is already (nearly) on him — he swam into the wind-up
    // — has no run-up left: it would plough through him before its volume may
    // go live (STRIKE_LEAD). The jaws take over instead (a gaped bite).
    if (this.kind === 'ram' && this._ramTooClose()) this.kind = 'bite';
    const kind = this.kind;
    const id = this._manager().nextAttackId();
    this._enter('attack');
    this._lungeT0 = 0;
    // Opportunistic tail whips do not count toward the bite/ram alternation.
    if (kind !== 'tail') this._lastStrike = kind;
    const p = g.player.position;
    // Bites and rams: the volume goes live only after the strike cue (_armLive).
    if (kind === 'bite' || kind === 'ram') this._armStrike(kind, id);
    if (kind === 'bite' && this._snap) {
      // No lunge: the head whip carries the jaws (and the bite volume) to him.
      this.lungeDir.copy(sh.forward);
    } else if (kind === 'bite') {
      // A gaped bite hangs open-jawed first; it announces itself at the snap.
      if (this._strike.armT > 0) return;
      this._launchBite();
    } else if (kind === 'ram') {
      this.lungeDir.subVectors(p, sh.position).normalize();
      sh.speed = Math.max(sh.speed, this._strike.v0);
    } else if (kind === 'tail') {
      sh.activateVolume('tail', id);
    } else if (kind === 'shockwave') {
      // The slam comes from the whole rear body, not just the fin tip: centre
      // it between the body centre and the caudal fin so a player in front of
      // the boss (where they usually are) is inside its reach.
      this.shockCenter.copy(sh.position).add(sh._caudal).multiplyScalar(0.5);
      const vol = sh.activateVolume('shockwave', id);
      if (vol) {
        vol.radius = 2;
        vol.center.copy(this.shockCenter);
      }
      this.shockCd = 7 + Math.random() * 3;
      const maxR = this.spec.attacks.shockwave.maxRadius;
      g.vfx?.spawnShockwave?.(this.shockCenter, maxR, { strength: 1.5 });
      g.vfx?.spawnBubbles?.(this.shockCenter, 50, { speed: 4, size: 1.4 });
      // Camera shake comes from CameraRig's own enemy:attack reaction.
    }
    g.events.emit('enemy:attack', { enemy: sh, type: kind });
  }

  /** The ram's snout would reach him within STRIKE_LEAD of its launch (speed + burst). */
  _ramTooClose() {
    return this._jawGap('ram') < this._ramReach();
  }

  /** Snout gap (m) a launched ram closes within STRIKE_LEAD (launch speed + burst). */
  _ramReach() {
    const st = this.spec.stats;
    const v = Math.max(this.shark.speed, st.approachSpeed);
    return STRIKE_LEAD * (v + 0.5 * st.burstAccel * STRIKE_LEAD);
  }

  /** Aims the bite's lunge through 老公 and launches it (`surge`: at its launch speed at once). */
  _launchBite(surge = true) {
    const sh = this.shark;
    const player = this.game.player;
    // Aim the body axis (not the mouth) through him: the body centre steers
    // along lungeDir, so a mouth-based aim would carry the jaws past him by
    // the mouth's sideways offset (metres on the megalodon).
    _tmp.copy(player.position);
    if (player.velocity) _tmp.addScaledVector(player.velocity, 0.25);
    this.lungeDir.subVectors(_tmp, sh.position).normalize();
    if (surge) sh.speed = Math.max(sh.speed, this._strike.v0);
  }

  /** Arms a bite / ram (volume id `id`): its volume waits for the strike cue (see STRIKE_LEAD). */
  _armStrike(kind, id) {
    const S = this._strike;
    const st = this.spec.stats;
    S.type = kind;
    S.id = id;
    S.armT = 0;
    S.hold = GAPE_HOLD;
    S.cued = false;
    S.cueAt = 0;
    S.live = false;
    S.gapAt = -1;
    S.accel = st.burstAccel;
    if (kind === 'bite') {
      S.v0 = st.burstSpeed * (this._closeBite ? 0.3 : 0.55);
      S.vmax = st.burstSpeed * this.speedMul * (this.phase >= 2 ? 1.1 : 1) * (this._closeBite ? 0.55 : 1);
      // A counter — or any bite while the pack is being carved up (knife
      // hits on any shark of the wave) — is a rip, not a hold: bite, tear,
      // let go, harder and with a shove, but no grab (a mashed-out grab would
      // only hand a face-tanker the free eye stab). The boss always holds.
      const rip = !this.shark.isBoss && (this._countering || (this._manager().recentKnifeHits?.(RIP_WINDOW) ?? this._recentHits(RIP_WINDOW)) >= COUNTER_HITS);
      const vol = this.shark.getVolume('bite');
      const atk = this.spec.attacks.bite;
      vol.canGrab = !rip;
      vol.damage = Math.round(atk.damage * (rip ? COUNTER_DAMAGE : 1));
      vol.knockback = atk.knockback * (rip ? 1.6 : 1);
    } else {
      S.v0 = st.approachSpeed;
      S.vmax = st.burstSpeed * 0.92 * this.speedMul;
    }
    // The jaws (nearly) on him already: no lunge would leave the cue its
    // lead, and it would plough through him — gape first, then snap.
    // Only jaws actually (nearly) on him gape: further off, a fast closing
    // speed is the lunge's business (it waits for the cue's lead), and a gape
    // that brakes metres short would leave the cue promising a bite that
    // comes far later.
    if (kind === 'bite' && !this._snap && this._jawGap('bite') < Math.max(1.6, 0.2 * this.shark.length)
      && this._strikeEta(Math.max(this.shark.speed, S.v0)) < ARM_TTC) S.armT = ARM_TIME;
    // Without a CombatSystem (bare harnesses) nobody cues it: go live on schedule.
    if (!this.game.combat) {
      S.cued = true;
      S.cueAt = this.game.time.elapsed;
    }
  }

  /**
   * Cued but not live yet (the cue came late in the run): the strike runs on
   * until its volume can go live, rather than timing out between the "parry
   * now" cue and the contact it announced.
   */
  _cuePending() {
    const S = this._strike;
    return !!S.type && S.cued && !S.live && this.game.time.elapsed - S.cueAt < STRIKE_LEAD + 0.1;
  }

  /** The armed bite / ram goes live once its cue has led by STRIKE_LEAD (and any gape is over). */
  _armLive() {
    const S = this._strike;
    if (!S.type || S.live || S.armT > 0 || !S.cued) return;
    if (this.game.time.elapsed - S.cueAt < STRIKE_LEAD - 1e-6) return;
    this.shark.activateVolume(S.type, S.id);
    S.live = true;
  }

  /** Gap (m) between attack volume `name` and 老公's hurtbox (≤ 0: touching). */
  _jawGap(name) {
    const vol = this.shark.getVolume(name);
    const ph = this.game.player?.hurtbox;
    if (!vol || !ph) return Infinity;
    return vol.center.distanceTo(ph.center) - vol.radius - ph.radius;
  }

  /**
   * Seconds until the running strike's volume can touch 老公 if he holds his
   * course: the jaws close at the body's speed toward him (`launchSpeed`
   * stands in for a lunge not launched yet) plus his speed toward them, the
   * shark accelerating at its burst rate up to the strike's top speed.
   */
  _strikeEta(launchSpeed = null) {
    const S = this._strike;
    const sh = this.shark;
    const player = this.game.player;
    const ph = player?.hurtbox;
    const vol = sh.getVolume(S.type);
    if (!vol || !ph) return Infinity;
    _tmp2.subVectors(ph.center, vol.center);
    const d = _tmp2.length();
    const gap = d - vol.radius - ph.radius;
    // In flight, also how fast the gap really shrank since the last forecast
    // (a head swinging round onto him closes faster than the body swims).
    let shrink = 0;
    if (launchSpeed === null) {
      const now = this.game.time.elapsed;
      if (S.gapAt >= 0 && now > S.gapAt + 1e-6) shrink = (S.gapPrev - gap) / (now - S.gapAt);
      S.gapPrev = gap;
      S.gapAt = now;
    }
    if (gap <= 0) return 0;
    _tmp2.multiplyScalar(1 / d);
    // A lunge still to launch is aimed through him: it closes head-on (the
    // body swinging onto that line swings the jaws round even faster).
    const along = launchSpeed === null ? Math.max(0, sh.forward.dot(_tmp2)) : 1;
    const speed = launchSpeed ?? sh.speed;
    let c = launchSpeed === null ? sh.velocity.dot(_tmp2) : speed * along;
    if (player.velocity) c -= player.velocity.dot(_tmp2);
    c = Math.max(c, shrink);
    const gain = Math.max(0, S.vmax - speed) * along; // closing speed still to come
    const a = S.accel * along;
    if (gain > 1e-3 && a > 1e-3) {
      const tAcc = gain / a;
      const dAcc = c * tAcc + 0.5 * a * tAcc * tAcc;
      if (gap <= dAcc) return (Math.sqrt(Math.max(0, c * c + 2 * a * gap)) - c) / a;
      c += gain;
      return c > 1e-3 ? tAcc + (gap - dAcc) / c : Infinity;
    }
    return c > 1e-3 ? gap / c : Infinity;
  }

  /**
   * The running bite / ram for CombatSystem's strike cue — `{ id, type, eta,
   * snap, point }` (its volume id, seconds until it can touch 老公; for a
   * side-snap `snap: true` and `point`, the predicted jaw contact — see
   * _snapContact — else `point: null`) — or null (none, or already cued: a
   * side-snap cues on its first attack frame, so framing reads `snapping` /
   * `snapPoint`). A reused object: read it at once.
   */
  strikeCue() {
    const S = this._strike;
    if (this.state !== 'attack' || !S.type || S.cued) return null;
    let eta;
    if (this._snap) eta = Math.max(0, SNAP_COCK - this.t) + SNAP_REACH;
    else if (S.armT > 0) eta = S.armT + this._strikeEta(Math.max(this.shark.speed, S.v0));
    else eta = this._strikeEta();
    const o = this._strikeOut;
    o.id = S.id;
    o.type = S.type;
    o.eta = eta;
    o.snap = this._snap;
    o.point = this._snap ? this._snapContact(this._snapPoint) : null;
    return o;
  }

  /**
   * Side-snap: where the jaws (the mouth point) will be when the whip lands —
   * the mouth swung about the head pivot from the head's current yaw / pitch
   * to the aim (_snapAim), then carried by the body's turn and drift until
   * then (≈0.7 m off on the boss at the cue, `enemies-sim boss-snap`).
   */
  _snapContact(out) {
    const sh = this.shark;
    this._snapAim();
    const P = sh.pose;
    _tmp.copy(sh.position).addScaledVector(sh.forward, (this.spec.sOrigin - this.spec.headS) * sh.length);
    out.subVectors(sh.getMouthPosition(), _tmp)
      .applyAxisAngle(sh.right, P.headPitch - this._snapPitch)
      .applyAxisAngle(sh.up, this._snapYaw - P.headYaw)
      .add(_tmp);
    const until = this.state === 'telegraph' ? Math.max(0, this.teleDur - this.t) + SNAP_COCK + SNAP_REACH : Math.max(0, SNAP_COCK + SNAP_REACH - this.t);
    out.sub(sh.position).applyAxisAngle(_UP, sh.yawRate * until).add(sh.position);
    return out.addScaledVector(sh.velocity, until);
  }

  /** While `snapping`: the predicted jaw contact (see _snapContact; a reused Vector3), else null. */
  get snapPoint() {
    return this.snapping ? this._snapContact(this._snapPoint) : null;
  }

  /** CombatSystem announced the running strike (enemy:strike): it goes live STRIKE_LEAD later. */
  onStrikeCue() {
    const S = this._strike;
    if (this.state !== 'attack' || !S.type || S.cued) return;
    S.cued = true;
    S.cueAt = this.game.time.elapsed;
  }

  _attack(dt) {
    const sh = this.shark;
    const st = this.spec.stats;
    const cfg = this.cfg;
    const p = this.game.player.position;
    const T = sh.poseT;
    switch (this.kind) {
      case 'bite': {
        if (this._snap) {
          this._snapAim();
          this._armLive();
          sh.setSteer(p, st.cruise * 0.6, 5, st.accel, st.decel);
          // A beat with the head cocked away and the jaws flung open (the
          // strike cue goes out here), then the whip.
          const ws = this.t - SNAP_COCK;
          if (ws < 0) {
            T.headYaw = -0.45 * this._snapYaw;
            T.headPitch = 0.05;
          } else {
            T.headYaw = this._snapYaw;
            T.headPitch = this._snapPitch;
            T.headRate = 16;
          }
          T.jaw = ws < 0.32 ? 1 : 0;
          T.jawOpenRate = 14;
          T.jawCloseRate = 30;
          T.snout = 1;
          T.protrude = 1;
          T.shake = ws < 0 ? 0 : 0.3;
          T.amp = 0.8;
          T.freqScale = 2.0;
          T.pecDrop = 0.8;
          T.eyeRoll = 1;
          if (ws > 0.55) this._afterAttack();
          break;
        }
        const S = this._strike;
        if (S.armT > 0) {
          // Gape: too close to lunge, so it hangs braked and square on him,
          // jaws flung wide, snout up, back hunched — then the snap.
          S.armT -= dt;
          sh.setSteer(p, 0.3, 5, st.accel, st.decel * 5);
          T.jaw = 1;
          T.jawOpenRate = 9;
          T.snout = 1;
          T.protrude = 0.7;
          T.arch = 1;
          T.pecDrop = 1;
          // The open jaws follow him (from the head pivot, so prey sliding
          // along the cheek stays between them rather than slipping past).
          this._snapAim();
          const hy = sh.isBoss ? 0.45 : 0.6;
          T.headYaw = clamp(this._snapYaw, -hy, hy);
          T.headPitch = 0.08 + clamp(this._snapPitch, -0.3, 0.3);
          T.headRate = 9;
          T.amp = 0.45;
          T.freqScale = 1.8;
          T.eyeRoll = 0.6;
          // Snap at once if he is between the jaws and the cue has led by
          // STRIKE_LEAD (a swimmer would otherwise slip past the open mouth
          // before it shuts); else when the gape is over — held a moment
          // longer while he grazes the open jaws, until he is in or clear.
          const gap = this._jawGap('bite');
          const sinceCue = S.cued ? this.game.time.elapsed - S.cueAt : -1;
          const inJaws = gap <= 0 && sinceCue >= STRIKE_LEAD - 1e-6;
          // Once cued it never hangs on past GAPE_LATE: the "parry now" cue
          // promised contact about STRIKE_ETA later, not whenever.
          let snap = inJaws || sinceCue >= GAPE_LATE;
          if (!snap && S.armT <= 0) {
            if (gap < GAPE_NEAR && S.hold > 0 && !S.cued) {
              S.hold -= dt;
              S.armT = 1e-3;
            } else snap = true;
          }
          if (snap) {
            S.armT = 0;
            // Jaws already on him: they shut where they are (no launch
            // surge to carry them past him this frame).
            this._launchBite(!inJaws);
            this._lungeT0 = this.t;
            this._armLive();
            this.game.events.emit('enemy:attack', { enemy: sh, type: 'bite' });
          }
          break;
        }
        this._armLive();
        const lt = this.t - this._lungeT0;
        // Limited homing so a well-timed sideways dodge makes it miss.
        _tmp.subVectors(p, sh.getMouthPosition());
        if (_tmp.dot(this.lungeDir) > 0) {
          _tmp.subVectors(p, sh.position).normalize();
          rotateTowardSimple(this.lungeDir, _tmp, cfg.homing * dt);
        }
        _target.copy(sh.position).addScaledVector(this.lungeDir, 30);
        // A close-range bite (boss, prey just off its jaws) lunges shorter and
        // swings harder, so the jaws come round onto him instead of past him.
        const close = this._closeBite;
        const burst = st.burstSpeed * this.speedMul * (this.phase >= 2 ? 1.1 : 1) * (close ? 0.55 : 1);
        sh.setSteer(_target, burst, close ? 3.5 : 2.2, st.burstAccel, st.decel, 0.7);
        T.jaw = 1;
        T.jawOpenRate = 12;
        T.snout = 1;
        T.protrude = 1;
        T.pecDrop = 0.8;
        T.arch = 0.25;
        T.amp = 1.5;
        T.freqScale = 2.0;
        T.eyeRoll = smoothstep(5, 2, this.mouthDist);
        _tmp.subVectors(p, sh.getMouthPosition());
        const passed = _tmp.dot(sh.forward) < -0.4;
        if (!passed) T.headYaw = this._headYawTo(p, sh.isBoss ? 0.45 : 0.3);
        if ((passed && lt > 0.12) || (lt > cfg.lungeTime && !this._cuePending())) {
          T.jaw = 0;
          sh.pose.jaw *= 0.5; // snap
          this._afterAttack();
        }
        break;
      }
      case 'ram': {
        this._armLive();
        // A little homing (less than a bite): a sideways dodge still beats it.
        _tmp.subVectors(p, sh.position);
        if (_tmp.dot(this.lungeDir) > 0) {
          _tmp.normalize();
          rotateTowardSimple(this.lungeDir, _tmp, cfg.homing * 0.6 * dt);
        }
        _target.copy(sh.position).addScaledVector(this.lungeDir, 30);
        sh.setSteer(_target, st.burstSpeed * 0.92 * this.speedMul, 0.6, st.burstAccel);
        T.pecDrop = 1;
        T.jaw = 0.02;
        T.headPitch = -0.1;
        T.amp = 1.6;
        T.freqScale = 2.0;
        _tmp.subVectors(p, sh.position);
        if (_tmp.dot(sh.forward) < -sh.length * 0.3 || (this.t > cfg.ramTime && !this._cuePending())) this._afterAttack();
        break;
      }
      case 'tail': {
        _target.copy(sh.position).addScaledVector(sh.forward, 10);
        sh.setSteer(_target, st.cruise * 0.7, 0.3);
        T.coil = -this.coilSide * 1.0;
        T.coilRate = 16;
        T.pecDrop = 0.5;
        T.amp = 0.2;
        if (this.t > 0.38) sh.deactivateVolume('tail');
        if (this.t > 0.55) this._afterAttack();
        break;
      }
      case 'shockwave': {
        _target.copy(sh.position).addScaledVector(sh.forward, 10);
        sh.setSteer(_target, st.cruise * 0.6, 0.5);
        T.arch = 1.4;
        T.archRate = 14;
        T.pecDrop = 1;
        T.jaw = 0.5;
        T.amp = 0.6;
        const vol = sh.getVolume('shockwave');
        if (vol) {
          vol.center.copy(this.shockCenter);
          vol.radius = lerp(2, vol.maxRadius, smoothstep(0, 0.55, this.t));
        }
        if (this.t > 0.7) this._afterAttack();
        break;
      }
      default:
        this._afterAttack();
    }
  }

  _afterAttack() {
    const sh = this.shark;
    sh.clearVolumes();
    const kind = this.kind;
    // The slam leaves the boss briefly spent: a punish window.
    if (sh.isBoss && kind === 'shockwave') this._weakT = WEAK_TIME;
    // A tail whip thrown mid-approach: carry on with the committed attack.
    if (kind === 'tail' && this._resumeKind && this.playing) {
      this.kind = this._resumeKind;
      this._resumed = true;
      this._enter('approach');
      return;
    }
    // Phase 3: a bite that carried past 老公 is followed by a tail whip as
    // the body sweeps by him (armed here, fired from _recoverUpdate).
    this._tailFollowUp = sh.isBoss && this.phase >= 3 && kind === 'bite' && this.playing;
    const chaining = this.chain > 0 && this.playing;
    if (!chaining) this._manager().releaseToken(sh);
    this._recover(this.cfg.recoverTime * (this.frenzy ? 0.7 : 1) * (chaining ? 0.5 : 1));
  }

  /** 老公 is where the caudal fin can reach: behind the body centre, beside the tail. */
  _inTailZone(latExtra = 0) {
    const sh = this.shark;
    const L = sh.length;
    _tmp.subVectors(this.game.player.position, sh.position);
    const along = _tmp.dot(sh.forward);
    const rear = -(sh.isBoss ? 0.35 : 0.2) * L;
    return along < rear && along > -0.8 * L
      && Math.abs(_tmp.dot(sh.right)) < (0.3 + latExtra) * L + 1.2
      && Math.abs(_tmp.dot(sh.up)) < 0.25 * L + 1.2;
  }

  _recover(time) {
    const sh = this.shark;
    sh.clearVolumes();
    if (!(this.chain > 0 && this.playing)) this._manager().releaseToken(sh);
    this.recoverTime = time;
    this._enter('recover');
  }

  _recoverUpdate(dt) {
    const sh = this.shark;
    const st = this.spec.stats;
    const p = this.game.player.position;
    // Inertia: big bodies keep going straight before they can swing away.
    const inertia = 0.6 + 0.045 * sh.length;
    if (this.t < 0.3) sh.poseT.jawCloseRate = 26; // jaws snap shut after a lunge
    if (this.t < inertia) {
      _target.copy(sh.position).addScaledVector(sh.forward, 20);
      sh.setSteer(_target, st.cruise * 1.3, 0.35, st.accel, 3.5);
      sh.poseT.amp = 1.2;
    } else if (sh.isBoss) {
      // The boss wheels straight back onto its (tight) orbit: it never
      // retreats into the murk between attacks. Carried past 老公 by the
      // lunge, it sheds the speed and pivots back (its turning circle at
      // lunge speed would take it 30 m out first).
      this.radius = Math.min(this.radius, lerp(this.cfg.circleRmin, this.cfg.circleRmax, BOSS_LOOM));
      if (this.facing < 0) {
        sh.setSteer(p, st.cruise * 0.5, 3.0, st.accel, st.decel * 2.2);
        sh.poseT.pecDrop = 0.7; // pectorals flare as it brakes
      } else this._orbitSteer(1.15);
    } else {
      _tmp.subVectors(sh.position, p);
      _tmp.y *= 0.3;
      if (_tmp.lengthSq() < 1e-4) _tmp.copy(sh.forward);
      _tmp.normalize();
      // Leashed (he is out over the trench / deep): peel off toward the lit
      // open water rather than straight away from him.
      this._leashCentre(_centre);
      if (_inward.lengthSq() > 1e-6) _tmp.addScaledVector(_inward, 1.2).normalize();
      _tmp2.crossVectors(_tmp, sh.up).multiplyScalar(this.orbitDir);
      _target.copy(sh.position).addScaledVector(_tmp, 15).addScaledVector(_tmp2, 8);
      sh.setSteer(_target, st.circleSpeed * 1.15 * this.speedMul, 1);
    }
    if (this._tailFollowUp) {
      // Phase-3 combo: the whip comes as soon as the tail draws level with him.
      if (!this.playing || this.t > 1.8) this._tailFollowUp = false;
      else if (this._inTailZone(0.1)) {
        this._tailFollowUp = false;
        this.tailCd = 6 + Math.random() * 3;
        this._startTelegraph('tail', 0.8);
        return;
      }
    }
    if (this.playing && this.t > 0.9 && this._tryTailSwipe()) return;
    if (this.t > this.recoverTime) {
      if (this.chain > 0 && this.playing) {
        this.chain--;
        this.kind = 'bite';
        this._enter('approach');
      } else {
        this.chain = 0;
        if (Math.random() < 0.3) this.orbitDir *= -1;
        const boss = this.shark.isBoss;
        // Occasionally another unnerving pass before the next real attack —
        // only after a committed attack (not an opportunistic tail whip),
        // never before the opening bite and never in a frenzy. The boss
        // never passes straight after a grab, and in phase 1 only after a
        // strike that found nothing (dodged / parried): one that drew blood
        // is followed by the jaws coming straight back.
        const mgr = this._manager();
        const drewBlood = mgr.lastHitBy === this.shark && (this.game.time?.elapsed ?? 0) - mgr.lastPlayerHitAt < 6;
        const bossHolds = boss && (this._afterGrab || (this.phase < 2 && drewBlood));
        // Blood drawn from prey that is not getting away (barely moving): it
        // presses — no pass in between, the jaws next, and after a tail slap
        // or a ram (no bite yet this round) soon. Otherwise a pass or a ram
        // standing in for the second bite dragged an idle fight past 45 s.
        const press = !boss && drewBlood && this._preyStill();
        if (!this.frenzy && !bossHolds && !press && this._firstCommitDone && this.kind !== 'tail' && this.feints === 0
          && Math.random() < (boss ? 0.3 : 0.35)) this.feints = 1;
        // Back off a little before the next commit (the boss only a little: it looms).
        this.aggression = boss ? clamp(this.aggression, 0.6, 0.8) : Math.min(this.aggression, 0.45);
        // Having spat 老公 out, the boss comes straight back for him.
        let next = boss && this._afterGrab ? rand(0.8, 1.4) : randRange(this.cfg.decisionInterval);
        if (press) {
          this._pressBite = true;
          if (this.kind !== 'bite') next = rand(1.2, 2.2);
        }
        this._backToCircle(next * (this.frenzy ? 0.55 : 1));
        // Now and then it melts back into the murk before the next pass at
        // him (never while pressing passive prey, never the boss).
        if (!press) this._maybeWide();
      }
    }
  }

  _backToCircle(decision) {
    this.shark.clearVolumes();
    this._manager().releaseToken(this.shark);
    this.radius = Math.max(this.radius, this.dist * 0.9);
    // The boss does not drift back out to the edge of visibility between
    // attacks: it stays close enough to loom.
    if (this.shark.isBoss) this.radius = Math.min(this.radius, lerp(this.cfg.circleRmin, this.cfg.circleRmax, BOSS_LOOM));
    this.decisionTimer = decision;
    this._enter('circle');
  }

  _giveUp() {
    this.chain = 0;
    this._backToCircle(1.5);
  }

  // ------------------------------------------------------------------ reactions

  onParried() {
    const sh = this.shark;
    sh.clearVolumes();
    this.chain = 0;
    this._manager().releaseToken(sh);
    if (this.state === 'grab') return;
    this.rollDir = Math.random() < 0.5 ? -1 : 1;
    if (sh.isBoss) {
      // The boss is stopped dead with its head in knife reach: the punish window.
      sh.speed = 0;
    } else {
      sh.drift.addScaledVector(sh.forward, -3).addScaledVector(sh.right, this.rollDir * 2);
      sh.speed *= 0.3;
    }
    sh.pose.flinch = clamp(sh.pose.flinch + this.rollDir * 0.8, -1.2, 1.2);
    sh.pose.jaw = Math.max(sh.pose.jaw, 0.4);
    this._enter('stagger');
  }

  _stagger(dt) {
    const sh = this.shark;
    const p = this.game.player.position;
    const T = sh.poseT;
    const dur = this.cfg.staggerTime;
    const u = this.t / dur;
    T.jaw = 0.38;
    T.jawCloseRate = 3;
    T.eyeRoll = 0.55;
    T.amp = 0.3;
    T.freqScale = 0.7;
    T.pecDrop = 0.2;
    T.headPitch = -0.08;
    T.extraRoll = this.rollDir * 1.25 * Math.sin(Math.PI * Math.min(1, u * 1.1));
    T.rollRate = 6;
    if (sh.isBoss) {
      // Hang dazed in place so the head and gills stay within reach.
      sh.setSteer(_tmp.copy(sh.position).addScaledVector(sh.forward, 2), 0.3, 0.2);
    } else {
      _tmp.subVectors(sh.position, p).normalize();
      _target.copy(sh.position).addScaledVector(sh.forward, 10).addScaledVector(_tmp, 6);
      sh.setSteer(_target, 1.4, 0.4);
    }
    if (this.t > dur) this._recover(this.cfg.recoverTime * 0.6);
  }

  onGrab() {
    this.chain = 0;
    this._enter('grab');
  }

  _grab(dt) {
    const sh = this.shark;
    const T = sh.poseT;
    // Clamp down and thrash the head side to side while swimming off.
    T.jaw = 0.3;
    T.jawCloseRate = 20;
    T.shake = 1;
    T.eyeRoll = 1;
    T.amp = 1.7;
    T.freqScale = 1.9;
    T.pecDrop = 0.5;
    T.snout = 0.5;
    T.protrude = 0.7;
    _target.copy(sh.position).addScaledVector(sh.forward, 10).addScaledVector(sh.right, Math.sin(this.t * 1.7) * 6);
    _target.y += Math.sin(this.t * 1.1) * 2;
    // Leashed: it drags him back toward the lit open water, not into the dark.
    this._leashCentre(_centre);
    _target.addScaledVector(_inward, 10);
    sh.setSteer(_target, 3 + 1.5 * Math.sin(this.t * 3.1), 1.4);
    if (this.t > 9) sh.releaseGrab(false); // failsafe if combat never releases
  }

  onGrabEscape() {
    this._manager().releaseToken(this.shark);
    this._enter('reel');
  }

  onGrabRelease() {
    this._recover(this.cfg.recoverTime);
    this._afterGrab = this.shark.isBoss; // cleared by _enter when the next strike launches
  }

  _reel(dt) {
    const sh = this.shark;
    const p = this.game.player.position;
    const T = sh.poseT;
    T.jaw = 0.85;
    T.jawOpenRate = 10;
    T.eyeRoll = 1;
    T.amp = 1.8;
    T.freqScale = 2.1;
    T.shake = 0.5 * Math.max(0, 1 - this.t / 2.4);
    T.extraRoll = Math.sin(this.t * 7) * 0.3;
    _tmp.subVectors(sh.position, p);
    if (_tmp.lengthSq() < 1e-4) _tmp.copy(sh.forward);
    _tmp.normalize();
    _target.copy(sh.position).addScaledVector(_tmp, 20);
    sh.setSteer(_target, this.spec.stats.approachSpeed * 1.05, 1.4);
    if (this.t > 2.4) {
      this.aggression = 0.25;
      this.radius = Math.max(this.radius, this.cfg.circleRmin + 8);
      this._backToCircle(randRange(this.cfg.decisionInterval));
      this._maybeWide(); // stabbed free of: it may sulk out in the murk a while
    }
  }

  onHit({ part, attackType }) {
    const sh = this.shark;
    this.aggression = Math.min(1, this.aggression + 0.1);
    const st = this.state;
    if (this._wide) this._endWide(); // he caught up with it out there
    // Knife hits in the last COUNTER_WINDOW s (a short ring of hit times).
    // Blows into a staggered shark are the parry's reward, the eye stab that
    // breaks a grab is the QTE's: neither counts as carving it up.
    if (st !== 'stagger' && attackType !== 'grabStab') {
      this._hitLog[this._hitNext] = this.game.time.elapsed;
      this._hitNext = (this._hitNext + 1) % this._hitLog.length;
      this._manager().noteKnifeHit?.(this.game.time.elapsed);
    }
    const recent = this._recentHits(COUNTER_WINDOW);
    const atHead = this.mouthDist < COUNTER_RANGE;
    if (!sh.isBoss && this.playing && recent >= COUNTER_HITS && COUNTER_STATES.has(st) && this._counter()) {
      // Face-tanked: it fights back (see _counter) instead of bolting.
    } else if (st === 'circle' || st === 'feint' || st === 'flank') {
      // Cut from the flank or behind it bolts now and then; stabbed in the
      // face it never turns tail — it comes for him.
      if (atHead || Math.random() < 0.45) this.decisionTimer = Math.min(this.decisionTimer, 0.4);
      else if (!sh.isBoss && this.playing) this._recover(1.2); // bolt
    } else if ((st === 'telegraph' || (st === 'attack' && this._strike.armT > 0))
      && (attackType === 'heavy' ? part === 'eye' || (!sh.isBoss && FACE.has(part)) : part === 'eye' && !this._countering)) {
      // A stab to the face interrupts the wind-up (or the gape before a snap);
      // an enraged counter only gives way to a heavy thrust.
      sh.pose.flinch = clamp(sh.pose.flinch + (Math.random() < 0.5 ? -1 : 1), -1.2, 1.2);
      this.chain = 0;
      this._recover(this.cfg.recoverTime * 0.8);
    }
    if (sh.isBoss) {
      const f = sh.health / sh.maxHealth;
      if (this.phase === 1 && f < 0.6) {
        this.phase = 2;
        this.pendingRoar = true;
      }
      if (this.phase === 2 && f < 0.25) {
        this.phase = 3;
        this.pendingRoar = true;
      }
    }
  }

  /** 老公 is passive prey: barely moving and not fighting back (no knife hit on us for 8 s). */
  _preyStill() {
    return (this.game.player.velocity?.length() ?? 0) < 1.5 && this._recentHits(8) === 0;
  }

  /** Knife hits taken in the last `window` s (up to the ring's length). */
  _recentHits(window) {
    const now = this.game.time.elapsed;
    let n = 0;
    for (let i = 0; i < this._hitLog.length; i++) if (now - this._hitLog[i] <= window) n++;
    return n;
  }

  /**
   * Answer to face-tanking (see COUNTER_HITS): jaws able to bear → a short
   * bite wind-up; beside the head → a committed approach (its braking pivot
   * swings the jaws round, then it bites); in reach of the tail → a tail slap,
   * then round for the jaws. Cut along the flank it does nothing here (the
   * caller's bolt). Needs the manager's leave (no other shark mid-strike or
   * holding him). True if it answered.
   */
  _counter() {
    const sh = this.shark;
    const mgr = this._manager();
    const front = this.mouthDist < COUNTER_RANGE;
    const tail = !front && this._inTailZone(0.15);
    if (!front && !tail) return false;
    if (mgr.anyGrabbing(sh) || !mgr.requestCounter?.(sh)) return false;
    this.chain = 0;
    this._resumed = false;
    this._firstDecisionDone = true;
    this._firstCommitDone = true;
    if (tail) {
      this.tailCd = 6 + Math.random() * 3;
      this._startTelegraph('tail');
      this._resumeKind = 'bite'; // after the slap, round for the jaws
    } else if (this.jawFacing > 0.3 && this._jawsLevel()) {
      this._startTelegraph('bite', COUNTER_TELE);
    } else if (this._snapAim() && this._snapDist < COUNTER_SNAP * sh.length && this._snapAlong > -0.25 * sh.length) {
      // Tucked in beside the head, carving at the eye and gills: the head
      // whips round onto him (the boss's side-snap), no swimming off.
      this._startTelegraph('bite', COUNTER_TELE, true);
    } else {
      this.kind = 'bite';
      if (this.state !== 'approach') this._enter('approach');
    }
    this._countering = this.state === 'telegraph';
    return true;
  }

  _startRoar() {
    const sh = this.shark;
    const g = this.game;
    this.pendingRoar = false;
    sh.clearVolumes();
    this._manager().releaseToken(sh);
    // CameraRig, PostFX and audio react to the event themselves (one trauma add).
    g.events.emit('enemy:roar', { enemy: sh });
    const mouth = sh.getMouthPosition();
    g.vfx?.spawnShockwave?.(mouth, 18, { strength: 0.6 });
    g.vfx?.spawnBubbles?.(mouth, 60, { speed: 3, size: 1.5 });
    // The roar is a pressure blast: it shoves 老公 away from the jaws.
    const player = g.player;
    if (player && player.alive !== false && !player.grabbedBy && player.velocity) {
      _tmp.subVectors(player.position, mouth);
      const d = _tmp.length();
      if (d < ROAR_RANGE) {
        if (d < 1e-3) _tmp.copy(sh.forward);
        else _tmp.multiplyScalar(1 / d);
        player.velocity.addScaledVector(_tmp, ROAR_SHOVE * (1 - d / (ROAR_RANGE + 4)));
        g.vfx?.spawnBubbles?.(player.position, 24, { speed: 2.5, size: 1.1, spread: 0.6 });
      }
    }
    g.slowmo?.(0.5, 0.45);
  }

  _roar(dt) {
    const sh = this.shark;
    const st = this.spec.stats;
    const p = this.game.player.position;
    const T = sh.poseT;
    // Jaws part, then gape once it has turned on 老公.
    T.jaw = this.t > 0.5 ? 1 : 0.3;
    T.jawOpenRate = 6;
    T.snout = 1;
    T.protrude = 1;
    T.shake = 0.8;
    T.arch = 0.6;
    T.pecDrop = 1;
    T.amp = 0.7;
    T.freqScale = 1.5;
    T.eyeRoll = 0.3;
    if (this.t < 0.7) {
      // Wheel round to face him first.
      sh.setSteer(p, st.cruise * 0.3, ROAR_TURN);
      T.headYaw = this._headYawTo(p, 0.45);
    } else {
      _target.copy(sh.position).addScaledVector(sh.forward, 10);
      sh.setSteer(_target, st.cruise * 0.6, 0.6);
    }
    if (this.t > 2.0) {
      this.aggression = 1;
      this._weakT = WEAK_TIME; // spent after the roar: punish window
      this._backToCircle(1.0);
    }
  }

  onDeath() {
    this.shark.clearVolumes();
    this._manager().releaseToken(this.shark);
    this.state = 'dying';
    this.chain = 0;
  }

  // ------------------------------------------------------------------ opportunistic tail swipe

  _tryTailSwipe() {
    if (this.tailCd > 0 || !this.playing || this._afterGrab) return false;
    const sh = this.shark;
    // Only when the shark is cruising (not still carrying lunge momentum).
    if (sh.speed > this.spec.stats.cruise * 1.6) return false;
    if (this._manager().anyGrabbing(sh)) return false;
    // Only where the caudal fin can actually reach: behind the body centre.
    if (this._inTailZone()) {
      // Not every opportunity is taken, so the pattern stays unpredictable.
      if (Math.random() > (this.cfg.tailChance ?? 0.55)) {
        this.tailCd = 1.2;
        return false;
      }
      this.tailCd = 6 + Math.random() * 4;
      // Thrown during a committed approach: resume it afterwards (once).
      const resume = this.state === 'approach' && !this._resumed ? this.kind : null;
      this._startTelegraph('tail');
      this._resumeKind = resume;
      return true;
    }
    return false;
  }
}

const _axisA = new THREE.Vector3();
const _qA = new THREE.Quaternion();
function rotateTowardSimple(v, target, maxAngle) {
  const d = clamp(v.dot(target), -1, 1);
  const ang = Math.acos(d);
  if (ang < 1e-5) return;
  if (ang <= maxAngle) {
    v.copy(target);
    return;
  }
  _axisA.crossVectors(v, target);
  if (_axisA.lengthSq() < 1e-10) return;
  _axisA.normalize();
  _qA.setFromAxisAngle(_axisA, maxAngle);
  v.applyQuaternion(_qA).normalize();
}
