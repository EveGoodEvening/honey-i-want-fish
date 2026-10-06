// Browserless pacing simulator for the enemies module (Node, no WebGL).
//
// Builds the real gameplay modules — Player, EnemyManager (sharks + AI),
// CombatSystem (hits, grabs, QTE damage), CameraRig (lock-on camera, for the
// boss light-occlusion estimate) and the seabed heightfield — around a stub
// game (no renderer / audio / VFX / UI) and steps them exactly like
// Game.frame does under ?fixeddt (1/60 s, hitstop / slow-mo time scale).
// Hundreds of simulated seconds take a few wall seconds, so AI tuning can be
// judged over many runs instead of one gated browser run.
//
//   node scripts/enemies-sim.mjs [check ...] [--runs N] [--quality high|low]
//
// Prints one JSON line per run and a '## check {median/min/max}' summary.
// Checks (default: the first six):
//   boss-p1     idle player (god off, locked on) vs the phase-1 megalodon:
//               time to death, every attack volume's launch time and closest gap
//   boss-p3     same, the boss put straight into phase 3 at 20 % health
//   boss-presence  god on, idle, locked, 60 s: median distance, time above
//               老公, light occlusion > 0.2 (Environment._updateOcclusion maths
//               with the CameraRig camera), occlusion / distance by AI state
//   tiger-idle  idle player vs the tiger pair: time to death, stacked hits
//               (hits from different sharks < 0.5 s apart)
//   gw-idle     idle player vs the great white: time to death
//   gw-kinds    god on, 120 s: great-white strike kinds, longest ram streak,
//               bite share
//   gw-cadence  wave 0 vs the great white's murk swings: idle-with-escape attacks
//               per minute (target ≥ 4.3) and death time, then god on / locked:
//               on screen within 25 m (`vis25`), swings per minute, swing length
//   boss-snap   the boss side-snap's public face (ai.snapping / ai.snapPoint, the
//               strike cue's snap + point) over 18 placements beside its head
//   tiger-cadence  god on, locked, 60 s: telegraphs (flank ones marked F)
//   pause       a pause landing mid-frame keeps a grab and a wind-up
//   chase-0/1/2 lock-on "swim at it and stab" bot (god on, 120 s): kill time
//   strike-close  placed close-range bites (jaws 2–4 m off, ×heading ×speed, 老公
//               idle or swimming in; god on), 80 per species: contacts before the
//               telegraph end (`early`), without a strike cue (`uncued`) or < 0.22 s
//               after it (`late`, SharkAI STRIKE_LEAD) — all must be 0. Run with
//               --runs 1 (seeded). STRIKE_KIND=ram places rams 6–14 m off and starts
//               their wind-up directly (an approach turns a ram under 7 m into a bite).
//   strike-natural  the same bookkeeping over natural fights per wave, 老公 idle
//               and parrying every cue (seeded per run)
//   parry-spam  idle vs parry-every-0.4-s death times per wave (seeded per run;
//               compare means over 16+ runs, single runs vary ±30 %)
//   boss-trace / boss-approach / boss-strikes  debugging: AI state trace of
//               slow boss runs (SIM_TRACE_OVER=<s>), long approaches, every
//               strike's set-up and outcome (SIM_DEBUG=1 adds frame traces)
// The numbers match scripts/enemies-pressure-scenario.mjs (same resets and
// bookkeeping; validated against it within run-to-run noise); the browser
// scenario stays the acceptance reference.
import * as THREE from 'three';
import { EventBus } from '../src/core/EventBus.js';
import { WORLD } from '../src/core/config.js';
import { Heightfield, LAYOUT } from '../src/world/terrain.js';
import { Player } from '../src/player/Player.js';
import { EnemyManager } from '../src/enemies/EnemyManager.js';
import { CombatSystem } from '../src/combat/CombatSystem.js';
import { CameraRig } from '../src/camera/CameraRig.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const RUNS = Number(opt('--runs', 6));
const QUALITY = opt('--quality', 'low');
const CHECKS = args.length ? args : ['boss-p1', 'boss-p3', 'boss-presence', 'tiger-idle', 'gw-idle', 'gw-kinds'];

// Environment.js SUN_DIR (unit vector toward the light).
const SUN_DIR = new THREE.Vector3(0.2, 0.9, -0.38).normalize();
const noop = () => {};
// Expected without a renderer: the player's PMREM env map falls back.
const warn = console.warn;
console.warn = (...a) => {
  if (!String(a[0]).includes('PMREM')) warn(...a);
};
const nullProxy = new Proxy({}, { get: () => noop });

function makeGame() {
  const g = {
    debug: { autostart: true, wave: 0, god: false, fixedDt: true },
    events: new EventBus(),
    state: 'boot',
    danger: 0,
    quality: QUALITY,
    time: { elapsed: 0, realElapsed: 0, dt: 0, realDt: 0, timeScale: 1, frame: 0 },
    _hitstopUntil: 0,
    _hitstopScale: 1,
    _slowmoUntil: 0,
    _slowmoScale: 1,
    renderer: null,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 700),
    vfx: nullProxy,
    post: { pulse: noop, flash: noop },
    audio: nullProxy,
    ui: nullProxy,
    director: { waveIndex: 0, stats: {} },
  };
  g.scene.add(g.camera);
  g.setState = (next) => {
    if (next === g.state) return;
    const from = g.state;
    g.state = next;
    g.events.emit('game:state', { from, to: next });
  };
  g.hitstop = (duration = 0.08, scale = 0.02) => {
    const until = g.time.realElapsed + duration;
    if (until > g._hitstopUntil) g._hitstopUntil = until;
    g._hitstopScale = Math.min(scale, g._hitstopScale);
  };
  g.slowmo = (duration = 0.6, scale = 0.3) => {
    const until = g.time.realElapsed + duration;
    if (until > g._slowmoUntil) g._slowmoUntil = until;
    g._slowmoScale = Math.min(scale, g._slowmoScale);
  };
  // Input: nothing held unless a check simulates it.
  const down = new Set();
  const just = new Set();
  g.input = {
    mouseDX: 0,
    mouseDY: 0,
    pointerLocked: true,
    isDown: (a) => down.has(a),
    pressed: (a) => just.has(a),
    released: () => false,
    axis: (p, n) => (down.has(p) ? 1 : 0) - (down.has(n) ? 1 : 0),
    simulate(a, on) {
      if (on && !down.has(a)) just.add(a);
      if (on) down.add(a);
      else down.delete(a);
    },
    requestPointerLock: noop,
    exitPointerLock: noop,
    endFrame: () => just.clear(),
  };
  // Environment stand-in: the real heightfield plus the boss light occlusion.
  const hf = new Heightfield(200, LAYOUT.size);
  const _c = new THREE.Vector3();
  g.env = {
    bounds: { surfaceY: WORLD.surfaceY, floorY: WORLD.floorY, radius: WORLD.arenaRadius },
    waterColor: new THREE.Color(0x0b3a4a),
    sunDirection: SUN_DIR.clone(),
    landmarks: {},
    _occlusion: 0,
    getSeabedHeight: (x, z) => hf.heightAt(x, z),
    update(dt) {
      let target = 0;
      const boss = g.enemies.getBoss();
      const cam = g.camera.position;
      if (boss) {
        _c.subVectors(boss.position, cam);
        const dist = _c.length();
        if (dist > 1e-3 && boss.position.y > cam.y) {
          const cosA = _c.dot(this.sunDirection) / dist;
          const half = Math.atan((boss.length * 0.32) / dist);
          const ang = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
          const cover = THREE.MathUtils.smoothstep(ang, half * 0.6, half * 2.2);
          const fade = THREE.MathUtils.smoothstep(dist, 25, 70);
          target = (1 - cover) * (1 - fade) * 0.75;
        }
      }
      const k = 1 - Math.exp(-dt * (target > this._occlusion ? 5 : 1.5));
      this._occlusion += (target - this._occlusion) * k;
    },
  };
  g.player = new Player(g);
  g.enemies = new EnemyManager(g);
  g.combat = new CombatSystem(g);
  g.cameraRig = new CameraRig(g);
  g.enemies.start();

  g.frame = () => {
    const t = g.time;
    const realDt = 1 / 60;
    t.realDt = realDt;
    t.realElapsed += realDt;
    let scale = 1;
    if (t.realElapsed < g._hitstopUntil) scale = Math.min(scale, g._hitstopScale);
    else g._hitstopScale = 1;
    if (t.realElapsed < g._slowmoUntil) scale = Math.min(scale, g._slowmoScale);
    else g._slowmoScale = 1;
    t.timeScale = scale;
    const dt = g.state === 'paused' ? 0 : realDt * scale;
    t.dt = dt;
    t.elapsed += dt;
    t.frame++;
    if (g.state !== 'paused') {
      g.player.update(dt);
      g.enemies.update(dt);
      g.combat.update(dt);
      g.env.update(dt);
      let target = 0;
      for (const e of g.enemies.enemies) if (e.alive) target = Math.max(target, e.getDangerLevel());
      g.danger += (target - g.danger) * (1 - Math.exp(-realDt * (target > g.danger ? 4 : 1.2)));
    }
    g.cameraRig.update(dt);
    g.camera.updateMatrixWorld();
    g.input.endFrame();
  };
  return g;
}

// ------------------------------------------------------------------ harness (mirrors enemies-pressure-scenario)
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const median = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[(s.length / 2) | 0];
};

function harness(g) {
  const T = { ev: [], trans: [], prev: new Map(), t0: 0 };
  const names = ['enemy:telegraph', 'enemy:attack', 'player:hit', 'grab:start', 'grab:end', 'player:death'];
  for (const n of names) {
    g.events.on(n, (p = {}) => {
      const o = { t: g.time.elapsed, ev: n };
      if (p.enemy) o.who = g.enemies.enemies.indexOf(p.enemy);
      if (p.type) o.type = p.type;
      if (n === 'player:hit') o.by = g.enemies.enemies.indexOf(g.enemies.lastHitBy);
      if (n === 'enemy:telegraph' && p.enemy) o.fromFlank = T.prev.get(p.enemy) === 'flank';
      T.ev.push(o);
    });
  }
  // A dead player ends combat (the Director's 'dead' state).
  g.events.on('player:death', () => g.setState('dead'));
  T.track = () => {
    for (const e of g.enemies.enemies) {
      const s = e.ai.state;
      const p = T.prev.get(e);
      if (p !== undefined && p !== s) T.trans.push({ t: g.time.elapsed, who: g.enemies.enemies.indexOf(e), from: p, to: s, kind: e.ai.kind });
      T.prev.set(e, s);
    }
  };
  T.reset = (wave, god) => {
    g.combat.qte?.end?.(false);
    g.debug.god = god;
    g.player.reset();
    g.cameraRig.lockTarget = null;
    g.director.waveIndex = wave;
    g.setState('playing');
    g.enemies.spawnWave(wave);
    T.ev.length = 0;
    T.trans.length = 0;
    T.prev.clear();
    T.t0 = g.time.elapsed;
  };
  T.keepLock = () => {
    const rig = g.cameraRig;
    if (!rig.lockTarget || !rig.lockTarget.alive) {
      const a = g.enemies.getAlive();
      if (a.length) {
        const p = g.player.position;
        const e = a[0];
        rig.yaw = Math.atan2(-(e.position.x - p.x), -(e.position.z - p.z));
        rig.toggleLock();
      }
    }
  };
  // Per attack volume: launch time and the smallest gap to 老公's hurtbox (≤ 0 = contact).
  T.gaps = new Map();
  T.trackGaps = () => {
    const ph = g.player.hurtbox;
    for (const e of g.enemies.enemies) {
      if (!e.alive) continue;
      for (const v of e.getAttackVolumes()) {
        const key = g.enemies.enemies.indexOf(e) + ':' + v.id;
        const gap = v.center.distanceTo(ph.center) - v.radius - ph.radius;
        const o = T.gaps.get(key);
        if (!o) T.gaps.set(key, { type: v.type, gap, t: r2(g.time.elapsed - T.t0) });
        else if (gap < o.gap) o.gap = gap;
      }
    }
  };
  T.run = (sec, hook) => {
    const n = Math.round(sec * 60);
    for (let i = 0; i < n; i++) {
      g.frame();
      T.track();
      if (hook && hook(i)) return i;
    }
    return n;
  };
  return T;
}

// ------------------------------------------------------------------ strike fairness probe
function seedRandom(s) {
  let a = s >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Records, per shark, every parryable telegraph (start, announced duration,
 * jaw gap), every enemy:strike cue and the moment Combat resolves each attack
 * volume (its hit ledger: a hit — god mode included — or a parry). `rows()`
 * pairs them: one row per bite / ram telegraph.
 */
function strikeProbe(g, T) {
  if (g._strikeProbe) return g._strikeProbe;
  const S = { teles: [], cues: [], contacts: [] };
  const ph = () => g.player.hurtbox;
  const jawGap = (e) => {
    const v = e.getVolume?.('bite');
    return v ? v.center.distanceTo(ph().center) - v.radius - ph().radius : NaN;
  };
  const led = g.combat._hitLedger;
  const add = led.add.bind(led);
  led.add = (enemy, id) => {
    const vol = enemy.getAttackVolumes?.().find((v) => v.id === id);
    if (vol && (vol.type === 'bite' || vol.type === 'ram')) S.contacts.push({ t: g.time.elapsed, enemy, id, type: vol.type, parried: false });
    add(enemy, id);
  };
  const parry = g.combat._parry.bind(g.combat);
  g.combat._parry = (player, enemy, vol) => {
    const c = S.contacts[S.contacts.length - 1];
    if (c && c.enemy === enemy && c.id === vol.id) c.parried = true;
    parry(player, enemy, vol);
  };
  g.events.on('enemy:telegraph', ({ enemy, type, duration }) => {
    if (type !== 'bite' && type !== 'ram') return;
    S.teles.push({ t: g.time.elapsed, enemy, type, dur: duration, gap0: jawGap(enemy), md0: enemy.ai.mouthDist, snap: false, gapEnd: NaN });
  });
  g.events.on('enemy:strike', ({ enemy, type, eta }) => S.cues.push({ t: g.time.elapsed, enemy, type, eta }));
  S.clear = () => {
    S.teles.length = 0;
    S.cues.length = 0;
    S.contacts.length = 0;
  };
  // Per frame: the jaw gap when each telegraph's announced time runs out, snap flag.
  // Also the first frame the strike's volume, live or not, overlaps him (the
  // jaws visibly arriving): `touch`.
  S.frame = () => {
    for (let i = 0; i < S.teles.length; i++) {
      const te = S.teles[i];
      const ai = te.enemy.ai;
      if (Number.isNaN(te.gapEnd) && g.time.elapsed >= te.t + te.dur - 1e-9) te.gapEnd = jawGap(te.enemy);
      const latest = !S.teles.slice(i + 1).some((x) => x.enemy === te.enemy);
      if (latest && ai.state === 'attack' && ai._snap) te.snap = true;
      if (latest && ai.state === 'attack' && ai._strike?.armT > 0) te.gape = true;
      if (latest && te.touch === undefined && ai.state === 'attack' && ai._strike?.type) {
        const v = te.enemy.getVolume(ai._strike.type);
        if (v.center.distanceTo(ph().center) <= v.radius + ph().radius) te.touch = g.time.elapsed;
      }
    }
  };
  S.rows = () => S.teles.map((te, i) => {
    const next = S.teles.slice(i + 1).find((x) => x.enemy === te.enemy);
    const until = next ? next.t : Infinity;
    const c = S.contacts.find((x) => x.enemy === te.enemy && x.t >= te.t && x.t < until);
    const cue = S.cues.find((x) => x.enemy === te.enemy && x.t >= te.t && x.t < until);
    return {
      type: te.type,
      snap: te.snap,
      gape: !!te.gape,
      md0: te.md0,
      gap0: te.gap0,
      gapEnd: te.gapEnd,
      teleEnd: te.t + te.dur,
      contact: c ? c.t - (te.t + te.dur) : null, // s after the announced telegraph end
      parried: !!c?.parried,
      cue: cue ? cue.t - (te.t + te.dur) : null,
      lead: c && cue && cue.t <= c.t ? c.t - cue.t : null,
      eta: cue ? cue.eta : null,
      // the jaws reached him this long before the volume could bite (frame after the overlap is seen)
      lag: c && te.touch !== undefined ? c.t - te.touch : null,
    };
  });
  g._strikeProbe = S;
  return S;
}

/** One placed close-range strike: returns the probe rows of that trial. */
function strikeTrial(g, T, S, { wave, kind, D, yaw, fast, swimIn }) {
  T.reset(wave, true);
  g.frame(); // 老公's hurtbox follows the reset
  S.clear();
  const P = g.player;
  const mgr = g.enemies;
  const [sh, ...rest] = mgr.enemies;
  for (const o of rest) {
    o.freeze = true;
    o.placeAt(new THREE.Vector3(P.position.x + 60, P.position.y, P.position.z + 60), new THREE.Vector3(1, 0, 0));
  }
  // Mouth D m from his hurtbox (on his −Z side); heading straight at him
  // (+Z) turned `yaw` degrees, so the jaws point that far off him.
  const fwd = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), (yaw * Math.PI) / 180);
  const pos = P.hurtbox.center.clone();
  sh.placeAt(pos, fwd);
  const mouthOff = sh.getMouthPosition().clone().sub(pos);
  pos.copy(P.hurtbox.center).add(new THREE.Vector3(0, 0, -D)).sub(mouthOff);
  sh.placeAt(pos, fwd);
  const st = sh.spec.stats;
  sh.speed = fast ? st.approachSpeed : st.cruise * 0.5;
  const ai = sh.ai;
  ai._chooseAttack = () => kind;
  ai.feints = 0;
  ai._firstDecisionDone = true;
  ai._firstCommitDone = true;
  ai.tailCd = 99;
  ai.kind = kind;
  mgr.requestToken(sh);
  // An approach turns a ram this close into a bite: start its wind-up directly.
  if (kind === 'ram') ai._startTelegraph('ram');
  else ai._enter('approach');
  if (swimIn) {
    g.cameraRig.lockTarget = sh;
    g.input.simulate('forward', true);
  }
  let done = -1;
  T.run(10, (i) => {
    S.frame();
    if (swimIn && ai.state !== 'approach' && ai.state !== 'telegraph' && ai.state !== 'attack') g.input.simulate('forward', false);
    if (done < 0 && S.teles.length && ai.state !== 'telegraph' && ai.state !== 'attack') done = i;
    return done >= 0 && i > done + 30;
  });
  g.input.simulate('forward', false);
  g.cameraRig.lockTarget = null;
  for (const o of rest) o.freeze = false;
  return S.rows().map((r) => ({ ...r, D, yaw, fast, swimIn }));
}

/** SIM_DEBUG=1: one line per strike row. */
function strikeDebug(name, rows) {
  if (!process.env.SIM_DEBUG) return;
  for (const r of rows) {
    const setup = r.D !== undefined ? ` D${r.D} y${r.yaw}${r.fast ? 'F' : ''}${r.swimIn ? 'W' : ''}` : '';
    console.log(`  ${name} ${r.type}${r.snap ? "S" : ""}${r.gape ? "G" : ""}${setup} md${r2(r.md0)} gap0 ${r2(r.gap0)} gapEnd ${r2(r.gapEnd)} cue ${r2(r.cue)} eta ${r2(r.eta)} contact ${r2(r.contact)}${r.parried ? 'P' : ''} lead ${r2(r.lead)} lag ${r2(r.lag)}`);
  }
}

/** The cue must lead contact by at least SharkAI STRIKE_LEAD (0.22 s). */
const LEAD_MIN = 0.22;

function strikeSummary(rows) {
  const all = rows.filter((r) => r.contact !== null);
  // A parry resolves when 老公 presses (here: on the cue), not when the jaws arrive.
  const con = all.filter((r) => !r.parried);
  const early = all.filter((r) => r.contact < -1e-6);
  const uncued = all.filter((r) => r.lead === null);
  const late = con.filter((r) => r.lead !== null && r.lead < LEAD_MIN - 1e-6);
  const leads = con.map((r) => r.lead).filter((x) => x !== null);
  const close = rows.filter((r) => r.md0 <= 4.5);
  const bad = [...early, ...uncued, ...late].slice(0, 6).map((r) => `${r.type}${r.snap ? 'S' : ''} D${r.D ?? ''} y${r.yaw ?? ''}${r.fast ? 'F' : ''}${r.swimIn ? 'W' : ''} md${r2(r.md0)} gapEnd${r2(r.gapEnd)} contact${r2(r.contact)} cue${r2(r.cue)}`);
  return {
    telegraphs: rows.length,
    closeStarts: close.length,
    contacts: all.length,
    parried: all.length - con.length,
    early: early.length,
    uncued: uncued.length,
    late: late.length,
    minLead: leads.length ? r2(Math.min(...leads)) : null,
    medLead: r2(median(leads)),
    // the cue promises contact ≈ STRIKE_ETA (0.32 s) out: a press 0.1 s after it must still parry
    maxLead: leads.length ? r2(Math.max(...leads)) : null,
    maxLag: r2(Math.max(0, ...con.map((r) => r.lag ?? 0))),
    cueBeforeTeleEnd: rows.filter((r) => r.cue !== null && r.cue < -1e-6).length,
    snaps: rows.filter((r) => r.snap).length,
    gapes: rows.filter((r) => r.gape).length,
    bad: bad.length ? bad.join(' | ') : undefined,
  };
}

// ------------------------------------------------------------------ checks
const CHECK = {
  'boss-p1'(g, T) {
    T.reset(2, false);
    T.gaps.clear();
    T.run(90, () => {
      T.keepLock();
      T.trackGaps();
      return !g.player.alive;
    });
    return {
      deathAt: g.player.alive ? null : r2(g.time.elapsed - T.t0),
      attacks: [...T.gaps.values()].map((x) => `${x.type}@${x.t}:${r2(x.gap)}`).join(' '),
      firstCommit: r2((T.trans.find((x) => x.to === 'approach')?.t ?? NaN) - T.t0),
      feints: T.trans.filter((x) => x.to === 'feint').length,
    };
  },
  'boss-p3'(g, T) {
    T.reset(2, false);
    const b = g.enemies.getBoss();
    b.ai.phase = 3;
    b.health = Math.round(b.maxHealth * 0.2);
    b.ai.decisionTimer = 3;
    b.ai.feints = 0;
    T.run(90, () => {
      T.keepLock();
      return !g.player.alive;
    });
    return {
      deathAt: g.player.alive ? null : r2(g.time.elapsed - T.t0),
      attacks: T.ev.filter((x) => x.ev === 'enemy:attack').map((x) => x.type + '@' + r2(x.t - T.t0)).join(' '),
    };
  },
  'boss-presence'(g, T) {
    T.reset(2, true);
    const D = [];
    let above = 0;
    let occ = 0;
    let n = 0;
    const occBy = {};
    const farBy = {};
    const circ = [];
    const flist = [];
    let fcur = null;
    let feintMax = 0;
    T.run(60, () => {
      T.keepLock();
      const b = g.enemies.getBoss();
      if (!b) return false;
      n++;
      const dd = b.position.distanceTo(g.player.position);
      D.push(dd);
      if (dd > 18) farBy[b.ai.state] = (farBy[b.ai.state] || 0) + 1;
      if (process.env.SIM_DEBUG && b.ai.state === 'circle' && g.time.frame % 30 === 0) {
        const p = g.player.position;
        circ.push(`${r2(g.time.elapsed - T.t0)}:h${r2(Math.hypot(b.position.x - p.x, b.position.z - p.z))} v${r2(b.position.y - p.y)} R${r2(b.ai.radius)} a${r2(b.ai.aggression)} f${r2(b.ai.facing)} s${r2(b.speed)}`);
      }
      if (b.position.y - g.player.position.y > 4) above++;
      if (g.env._occlusion > 0.2) {
        occ++;
        occBy[b.ai.state] = (occBy[b.ai.state] || 0) + 1;
      }
      if (b.ai.state === 'feint') {
        feintMax = Math.max(feintMax, g.env._occlusion);
        if (!fcur) fcur = { t: r2(g.time.elapsed - T.t0), oh: b.ai._overhead ? 1 : 0, occ: 0, passed: 0, d0: r2(b.ai.dist) };
        fcur.occ = Math.max(fcur.occ, r2(g.env._occlusion));
        if (b.ai.feintPassed && !fcur.passed) fcur.passed = r2(g.time.elapsed - T.t0);
        if (process.env.SIM_DEBUG2 && g.time.frame % 20 === 0) {
          const tg = b.steer.target;
          const p = g.player.position;
          fcur.tr = (fcur.tr || '') + ` ${r2(b.ai.t)}${b.ai._runUp ? 'R' : ''}:dt${r2(tg.distanceTo(b.position))} dp${r2(b.ai.dist)} f${r2(b.ai.facing)} tgy${r2(tg.y - p.y)} by${r2(b.position.y - p.y)} cam${r2(g.camera.position.distanceTo(p))}`;
        }
      } else if (fcur) {
        fcur.end = r2(g.time.elapsed - T.t0);
        flist.push(fcur);
        fcur = null;
      }
      return false;
    });
    return {
      medianDist: r2(median(D)),
      above4: r2(above / n),
      occ02: r2(occ / n),
      occBy: Object.entries(occBy).map(([k, v]) => k + ':' + v).join(' '),
      feintOccMax: r2(feintMax),
      farBy: Object.entries(farBy).map(([k, v]) => k + ':' + v).join(' '),
      circ: circ.length ? circ.join(' | ') : undefined,
      passes: process.env.SIM_DEBUG ? flist.map((f) => `${f.t}-${f.end} oh${f.oh} d0 ${f.d0} passed@${f.passed} occ${f.occ}${f.tr ? ' TR' + f.tr : ''}`).join(" ; ") : undefined,
      attacks: T.ev.filter((x) => x.ev === 'enemy:attack').map((x) => x.type + '@' + r2(x.t - T.t0)).join(' '),
      feints: T.trans.filter((x) => x.to === 'feint').map((x) => r2(x.t - T.t0)).join(' '),
    };
  },
  'tiger-idle'(g, T) {
    T.reset(1, false);
    T.run(120, () => !g.player.alive);
    const hits = T.ev.filter((x) => x.ev === 'player:hit');
    let stacked = 0;
    let minGapOther = 99;
    for (let i = 1; i < hits.length; i++) {
      for (let j = i - 1; j >= 0 && hits[i].t - hits[j].t < 2; j--) {
        if (hits[j].by !== hits[i].by && hits[i].by >= 0 && hits[j].by >= 0) {
          const gap = hits[i].t - hits[j].t;
          minGapOther = Math.min(minGapOther, gap);
          if (gap < 0.5) stacked++;
        }
      }
    }
    const tele = T.ev.filter((x) => x.ev === 'enemy:telegraph');
    return {
      deathAt: g.player.alive ? null : r2(g.time.elapsed - T.t0),
      stacked,
      minGapOther: r2(minGapOther),
      tele: tele.map((x) => x.type[0] + (x.fromFlank ? 'F' : '') + x.who + '@' + r2(x.t - T.t0)).join(' '),
      grabs: T.ev.filter((x) => x.ev === 'grab:start').map((x) => r2(x.t - T.t0)).join(' '),
      trace: process.env.SIM_DEBUG ? T.trans.filter((x) => x.t - T.t0 < 22).map((x) => `${r2(x.t - T.t0)} #${x.who} ${x.from}>${x.to}`).join(' | ') : undefined,
    };
  },
  'boss-approach'(g, T) {
    T.reset(2, false);
    const S = [];
    let longest = 0;
    let cur = [];
    T.run(90, () => {
      T.keepLock();
      const b = g.enemies.getBoss();
      const ai = b.ai;
      if (ai.state === 'approach') {
        if (g.time.frame % 15 === 0) {
          const p = g.player.position;
          cur.push(`${r2(ai.t)}:d${r2(ai.dist)} md${r2(ai.mouthDist)} f${r2(ai.facing)} jf${r2(ai.jawFacing)} v${r2(b.speed)} dy${r2(p.y - b.position.y)} db${ai._driveBy ? 1 : 0} ct${r2(ai._closeT)} k${ai.kind} py${r2(p.y)} pv${r2(g.player.velocity.length())}`);
        }
      } else if (cur.length) {
        if (cur.length > longest) {
          longest = cur.length;
          S.length = 0;
          S.push(...cur);
        }
        cur = [];
      }
      return !g.player.alive;
    });
    return longest > 16 ? { samples: S.join(' | ') } : { short: longest };
  },
  // Debug: every boss strike vs an idle player (god off, full HP restored after
  // each hit so the fight goes on): how it was set up and whether it landed.
  'boss-strikes'(g, T) {
    T.reset(2, false);
    const b = g.enemies.getBoss();
    const ai = b.ai;
    const list = [];
    let cur = null;
    let prev = ai.state;
    T.run(120, () => {
      T.keepLock();
      if (g.player.health < 40) g.player.health = 100;
      const st = ai.state;
      if (st === 'telegraph' && prev !== 'telegraph') {
        const mv = g.player.position.clone().sub(b.getMouthPosition());
        cur = { t: r2(g.time.elapsed - T.t0), kind: ai.kind, snap: ai._snap ? 1 : 0, dur: r2(ai.teleDur), md: r2(ai.mouthDist), f: r2(ai.facing), jf: r2(ai.jawFacing), u: r2(mv.dot(b.up)), l: r2(mv.dot(b.right)), from: prev, hit: 0 };
        list.push(cur);
      }
      if (cur && (st === 'grab' || T.ev.some((x) => x.ev === 'player:hit' && x.t > T.t0 + cur.t))) cur.hit = 1;
      if (cur && process.env.SIM_DEBUG && (st === 'attack' || st === 'telegraph') && g.time.frame % 3 === 0) {
        const m = b.getMouthPosition();
        const v = g.player.position.clone().sub(m);
        const vol = b.getVolume('bite');
        cur.tr = (cur.tr || '') + ` ${st[0]}${r2(ai.t)}:a${r2(v.dot(b.forward))} l${r2(v.dot(b.right))} u${r2(v.dot(b.up))} v${r2(b.speed)} g${r2(vol.center.distanceTo(g.player.hurtbox.center) - vol.radius - g.player.hurtbox.radius)}`;
      }
      if (st === 'recover' || st === 'circle') cur = null;
      prev = st;
      return false;
    });
    return { strikes: list.map((x) => `${x.kind}${x.snap ? 'S' : ''}${x.hit ? '+' : '-'} md${x.md} f${x.f} jf${x.jf} u${x.u} l${x.l} d${x.dur}${!x.hit && x.tr ? ' TR' + x.tr : ''}`).join(' | ') };
  },
  // Debug: boss-p1 with the AI state trace (only printed when it dies late).
  'boss-trace'(g, T) {
    const r = CHECK['boss-p1'](g, T);
    if (r.deathAt !== null && r.deathAt <= Number(process.env.SIM_TRACE_OVER ?? 33)) return { deathAt: r.deathAt };
    r.trace = T.trans.map((x) => `${r2(x.t - T.t0)} ${x.from}>${x.to}${x.to === 'approach' ? ':' + x.kind : ''}`).join(' | ');
    return r;
  },
  'tiger-cadence'(g, T) {
    T.reset(1, true);
    T.run(60, () => {
      T.keepLock();
      return false;
    });
    const tele = T.ev.filter((x) => x.ev === 'enemy:telegraph');
    return { telePer60: tele.length, flank: tele.filter((x) => x.fromFlank).length, kinds: tele.map((x) => x.type[0] + (x.fromFlank ? 'F' : '')).join('') };
  },
  // enemies-r1: a pause landing mid-frame (state 'paused' while the modules
  // still update with dt > 0, as Game.frame did before core-r1) must keep a
  // grab and a wind-up. Idle player, god off, great white.
  pause(g, T) {
    const pausedFrame = () => {
      g.setState('paused');
      const dt = 1 / 60;
      g.player.update(dt);
      g.enemies.update(dt);
      g.combat.update(dt);
      g.setState('playing');
    };
    const out = {};
    T.reset(0, false);
    let e = g.enemies.enemies[0];
    T.run(60, () => g.combat.grab !== null);
    if (g.combat.grab) {
      for (let k = 0; k < 20; k++) g.frame();
      pausedFrame();
      out.grabKept = g.combat.grab?.enemy === e && g.player.grabbedBy === e && e.ai.state === 'grab';
      const hp0 = g.player.health;
      T.run(5, () => !g.combat.grab);
      out.grabEndedNormally = !g.combat.grab && g.player.grabbedBy === null && e.ai.state !== 'grab';
      out.grabDamage = r2(hp0 - g.player.health);
    } else out.grabKept = 'no grab in 60 s';
    T.reset(0, false);
    e = g.enemies.enemies[0];
    T.run(60, () => e.ai.state === 'telegraph' && e.ai.t > 0.2);
    if (e.ai.state === 'telegraph') {
      const kind = e.ai.kind;
      const t0 = e.ai.t;
      pausedFrame();
      out.teleKept = e.ai.state === 'telegraph' && e.ai.kind === kind && e.ai.t > t0;
      T.run(3, () => e.ai.state !== 'telegraph');
      out.teleThen = e.ai.state;
    } else out.teleKept = 'no telegraph in 60 s';
    return out;
  },
  // Lock-on "swim at it and stab" bot, god mode, 120 s per wave (the
  // approach stalemate must not come back): kill time and hit rate.
  chase(g, T, wave = T.chaseWave ?? 0) {
    T.reset(wave, true);
    const I = g.input;
    const P = g.player;
    const C = { lockCd: 0, atkCd: 0, cyc: 0, heavyHold: 0 };
    const tap = (a) => {
      I.simulate(a, true);
      I.simulate(a, false);
    };
    const closest = (e, from) => {
      let best = 1e9;
      for (const hb of e.hurtboxes) best = Math.min(best, hb.center.distanceTo(from) - hb.radius);
      return best;
    };
    let killedAt = null;
    T.run(120, () => {
      C.lockCd--;
      const rig = g.cameraRig;
      if ((!rig.lockTarget || !rig.lockTarget.alive) && C.lockCd <= 0 && g.enemies.getAlive().length) {
        tap('lock');
        C.lockCd = 20;
      }
      const t = rig.lockTarget?.alive ? rig.lockTarget : g.enemies.getNearest(P.position, 500);
      if (t) {
        const d = closest(t, P.hurtbox.center);
        if (C.heavyHold > 0) {
          if (--C.heavyHold === 0) I.simulate('heavy', false);
        } else if (d > 2.0) {
          I.simulate('forward', true);
          if (d > 7 && !P._sprint && P.state === 'swim' && P.stamina > 45) {
            I.simulate('dodge', false);
            I.simulate('dodge', true);
          } else if (d <= 5) I.simulate('dodge', false);
        } else {
          I.simulate('forward', false);
          I.simulate('dodge', false);
          if (--C.atkCd <= 0) {
            C.cyc++;
            if (C.cyc % 5 === 0 && P.stamina > 30) {
              I.simulate('heavy', true);
              C.heavyHold = 40;
              C.atkCd = 20;
            } else {
              tap('attack');
              C.atkCd = 10;
            }
          }
        }
      }
      if (killedAt === null && g.enemies.getAlive().length === 0) killedAt = r2(g.time.elapsed - T.t0);
      return killedAt !== null;
    });
    for (const a of ['forward', 'dodge', 'heavy']) I.simulate(a, false);
    const dur = g.time.elapsed - T.t0;
    const hits = T.ev.filter((x) => x.ev === 'enemy:attack').length;
    return { wave, killedAt, attacks: hits, hp: g.enemies.enemies.map((e) => Math.round(e.health)).join('/'), durS: r2(dur) };
  },
  'chase-0'(g, T) {
    return CHECK.chase(g, T, 0);
  },
  'chase-1'(g, T) {
    return CHECK.chase(g, T, 1);
  },
  'chase-2'(g, T) {
    return CHECK.chase(g, T, 2);
  },
  // Close-range strike fairness: one bite (or ram) per placed start, the jaws
  // 2–4 m from 老公 (mouth distance × heading offset × speed, 老公 idle or
  // swimming at the jaws; god on). Every parryable telegraph is checked: no
  // contact (Combat resolving the volume: hit or parry) before the announced
  // telegraph has run out, and an enemy:strike cue ≥ 0.15 s before it.
  //   node scripts/enemies-sim.mjs strike-close --runs 1   (STRIKE_KIND=ram: 6–14 m, wind-up started directly; STRIKE_SPECIES=tiger)
  'strike-close'(g, T) {
    const S = strikeProbe(g, T);
    const kind = process.env.STRIKE_KIND || 'bite';
    const only = process.env.STRIKE_SPECIES;
    const out = {};
    for (const [species, wave] of [['greatWhite', 0], ['tiger', 1], ['megalodon', 2]]) {
      if (only && only !== species) continue;
      const rows = [];
      let n = 0;
      for (const D of kind === 'ram' ? [6, 8, 10, 12, 14] : [2, 2.5, 3, 3.5, 4]) {
        for (const yaw of [0, 25, -40, 60]) {
          for (const fast of [false, true]) {
            for (const swimIn of [false, true]) {
              seedRandom(1000 + n++);
              rows.push(...strikeTrial(g, T, S, { wave, kind, D, yaw, fast, swimIn }));
            }
          }
        }
      }
      out[species] = strikeSummary(rows);
      strikeDebug(species, rows);
    }
    return out;
  },
  // Boss side-snap exposure (for the camera): 老公 placed beside the
  // megalodon's head (2.5–4.5 m out from the head pivot, −1…+2 m along it,
  // either side), god on, idle. Counts the side-snaps that ran, those with
  // `ai.snapping` already true when their enemy:telegraph went out, frames
  // it (or `ai.snapPoint`) read false / null in between until the whip ended
  // (`gapFrames`), cues where Combat's getStrikeCue() carried `snap: true`
  // and a `point`; `pointErr` = distance (m) from that cue-time point to the
  // mouth when the whip lands (SNAP_COCK + SNAP_REACH into the attack).
  'boss-snap'(g, T) {
    const rows = [];
    let n = 0;
    for (const side of [1, -1]) {
      for (const D of [2.5, 3.5, 4.5]) {
        for (const a of [-1, 0.5, 2]) {
          seedRandom(3000 + n++);
          T.reset(2, true);
          g.frame();
          const sh = g.enemies.getBoss();
          const ai = sh.ai;
          const P = g.player;
          sh.placeAt(P.position.clone().add(new THREE.Vector3(-30, 0, 0)), new THREE.Vector3(0, 0, 1));
          const pivot = sh.position.clone().addScaledVector(sh.forward, (sh.spec.sOrigin - sh.spec.headS) * sh.length);
          const pos = sh.position.clone().sub(pivot).add(P.position).addScaledVector(sh.right, -side * D).addScaledVector(sh.forward, -a);
          sh.placeAt(pos, new THREE.Vector3(0, 0, 1));
          sh.speed = sh.spec.stats.cruise * 0.5;
          ai.feints = 0;
          ai._firstDecisionDone = true;
          ai._firstCommitDone = true;
          ai.tailCd = 99;
          ai.shockCd = 99;
          ai.kind = 'bite';
          ai._chooseAttack = () => 'bite';
          g.enemies.requestToken(sh);
          ai._enter('approach');
          const r = { side, D, a, snap: false, atTele: null, gaps: 0, cueSnap: false, point: false, pointErr: null, preyErr: null };
          let cuePoint = null;
          let shutAt = -1;
          const offT = g.events.on('enemy:telegraph', ({ enemy, type }) => {
            if (enemy === sh && type === 'bite' && r.atTele === null) r.atTele = ai.snapping;
          });
          // Combat's own reads: the last forecast before the cue is the cue's.
          const getCue = sh.getStrikeCue;
          sh.getStrikeCue = function () {
            const fc = getCue.call(this);
            if (fc && ai._snap) {
              r.cueSnap = fc.snap === true;
              r.point = !!fc.point;
              cuePoint = fc.point ? (cuePoint ?? new THREE.Vector3()).copy(fc.point) : null;
            }
            return fc;
          };
          T.run(6, (i) => {
            if (ai._snap && (ai.state === 'telegraph' || ai.state === 'attack')) {
              r.snap = true;
              if (!ai.snapping || !ai.snapPoint) r.gaps++;
              // The whip lands (SharkAI SNAP_COCK + SNAP_REACH into the attack).
              if (ai.state === 'attack' && shutAt < 0 && ai.t > 0.2 + 0.12 - 1e-6) {
                shutAt = i;
                if (cuePoint) {
                  r.pointErr = r2(cuePoint.distanceTo(sh.getMouthPosition()));
                  r.preyErr = r2(cuePoint.distanceTo(P.hurtbox.center));
                  if (process.env.SIM_DEBUG) {
                    const pv = sh.position.clone().addScaledVector(sh.forward, (sh.spec.sOrigin - sh.spec.headS) * sh.length);
                    const loc = (v) => { const d = v.clone().sub(pv); return [r2(d.dot(sh.right)), r2(d.dot(sh.up)), r2(d.dot(sh.forward))]; };
                    r.dbg = { mouth: loc(sh.getMouthPosition()), pred: loc(cuePoint), prey: loc(P.hurtbox.center), yaw: r2(ai._snapYaw), pitch: r2(ai._snapPitch) };
                  }
                }
              }
            }
            return r.snap && !ai.snapping && ai.state !== 'telegraph' && ai.state !== 'attack';
          });
          offT();
          delete sh.getStrikeCue;
          rows.push(r);
        }
      }
    }
    const snaps = rows.filter((r) => r.snap);
    const errs = snaps.map((r) => r.pointErr).filter((x) => x !== null);
    const out = {
      placements: rows.length,
      snaps: snaps.length,
      snappingAtTele: snaps.filter((r) => r.atTele === true).length,
      gapFrames: snaps.reduce((s, r) => s + r.gaps, 0),
      cueSnap: snaps.filter((r) => r.cueSnap).length,
      cuePoint: snaps.filter((r) => r.point).length,
      pointErrMed: r2(median(errs)),
      pointErrMax: errs.length ? r2(Math.max(...errs)) : null,
    };
    const all = (k) => out[k] === out.snaps;
    out.pass = out.snaps > 0 && all('snappingAtTele') && all('cueSnap') && all('cuePoint') && out.gapFrames === 0 && errs.length === out.snaps && out.pointErrMax < 1.5;
    if (process.env.SIM_DEBUG) out.rows = rows;
    return out;
  },
  // Natural fights (god on, 90 s per wave), 老公 idle, then parrying every
  // strike cue after a 0.12 s reaction (so the next attack often starts close
  // after a stagger). Same per-telegraph bookkeeping as strike-close.
  'strike-natural'(g, T) {
    const S = strikeProbe(g, T);
    const out = {};
    const run = (T.strikeRun = (T.strikeRun ?? 0) + 1);
    for (const [wave, parry] of [[0, false], [1, false], [2, false], [0, true], [1, true], [2, true]]) {
      seedRandom(7000 + 100 * run + 10 * wave + (parry ? 1 : 0));
      T.reset(wave, true);
      S.clear();
      let pressAt = -1;
      const off = g.events.on('enemy:strike', () => {
        if (parry && pressAt < 0) pressAt = g.time.elapsed + 0.12;
      });
      T.run(90, () => {
        T.keepLock();
        if (pressAt >= 0 && g.time.elapsed >= pressAt) {
          g.input.simulate('parry', true);
          g.input.simulate('parry', false);
          pressAt = -1;
        }
        S.frame();
        return false;
      });
      off();
      const name = `w${wave}${parry ? ' parry' : ' idle'}`;
      out[name] = strikeSummary(S.rows());
      strikeDebug(name, S.rows());
    }
    return out;
  },
  // Parry spam vs idle (scripts/player-parry-scenario.mjs `spam`, browserless): god
  // off, 140 s cap, the same seed for both; the spammer taps parry every 0.4 s and
  // mashes attack while grabbed. Prints the death times; ratio = spam / idle.
  'parry-spam'(g, T) {
    const run = (T.spamRun = (T.spamRun ?? 0) + 1);
    const out = {};
    for (const wave of [0, 1, 2]) {
      const r = {};
      for (const [name, every] of [['idle', 0], ['spam', 24]]) {
        seedRandom(101 * run + 7 * wave);
        T.reset(wave, false);
        let k = 0;
        let m = 0;
        T.run(140, () => {
          if (g.combat.grab) {
            if (++m % 4 === 0) {
              g.input.simulate('attack', true);
              g.input.simulate('attack', false);
            }
          } else if (every > 0 && ++k % every === 0) {
            g.input.simulate('parry', true);
            g.input.simulate('parry', false);
          }
          return !g.player.alive;
        });
        r[name] = g.player.alive ? 140 : r2(g.time.elapsed - T.t0);
      }
      out['w' + wave] = `${r.idle}/${r.spam}`;
      out['ratio' + wave] = r2(r.spam / r.idle);
    }
    return out;
  },
  'gw-idle'(g, T) {
    T.reset(0, false);
    T.run(120, () => !g.player.alive);
    return {
      deathAt: g.player.alive ? null : r2(g.time.elapsed - T.t0),
      tele: T.ev.filter((x) => x.ev === 'enemy:telegraph').map((x) => x.type + '@' + r2(x.t - T.t0)).join(' '),
    };
  },
  // Great-white cadence vs its murk swings (ai.wide / SharkAI WIDE_*), wave 0,
  // seeded per run. Idle with escape (god off, mashing out of grabs, 160 s
  // cap): attacks (enemy:attack, tails included) per minute until death —
  // target ≥ 4.3 (no swings at all: ≈5; round 4's frequent long swings cut
  // it to ≈3.7 and stretched idle deaths from 72 to 91–97 s). Then god on,
  // locked on, 120 s: share of samples (every 6 frames) with the shark on
  // screen within 25 m of the camera (`vis25`) / 55 m (`vis55`), swings per
  // minute, their mean length and the share of time spent swinging.
  'gw-cadence'(g, T) {
    const run = (T.cadRun = (T.cadRun ?? 0) + 1);
    seedRandom(5000 + run);
    T.reset(0, false);
    let m = 0;
    T.run(160, () => {
      if (g.combat.grab && ++m % 4 === 0) {
        g.input.simulate('attack', true);
        g.input.simulate('attack', false);
      }
      return !g.player.alive;
    });
    const dur = g.time.elapsed - T.t0;
    const attacks = T.ev.filter((x) => x.ev === 'enemy:attack').length;
    const out = { deathAt: g.player.alive ? null : r2(dur), attacks, atkPerMin: r2(attacks / (dur / 60)) };
    seedRandom(5500 + run);
    T.reset(0, true);
    const sh = g.enemies.enemies[0];
    const ndc = new THREE.Vector3();
    const on = (p) => {
      ndc.copy(p).project(g.camera);
      return ndc.z < 1 && Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1;
    };
    let n = 0;
    let v25 = 0;
    let v55 = 0;
    let wideF = 0;
    let swings = 0;
    let wasWide = false;
    T.run(120, (i) => {
      T.keepLock();
      const wide = !!sh.ai._wide;
      if (wide) wideF++;
      if (wide && !wasWide) swings++;
      wasWide = wide;
      if (i % 6) return false;
      n++;
      const cam = g.camera.position;
      const mth = sh.getMouthPosition();
      const vis = on(sh.position) || on(mth);
      const cd = Math.min(cam.distanceTo(sh.position), cam.distanceTo(mth));
      if (vis && cd < 25) v25++;
      if (vis && cd < 55) v55++;
      return false;
    });
    g.cameraRig.lockTarget = null;
    Object.assign(out, { vis25: r2(v25 / n), vis55: r2(v55 / n), swingsPerMin: r2(swings / 2), swingLen: swings ? r2(wideF / 60 / swings) : 0, wideShare: r2(wideF / (120 * 60)) });
    return out;
  },
  'gw-kinds'(g, T) {
    T.reset(0, true);
    T.run(120, () => {
      T.keepLock();
      return false;
    });
    const kinds = T.trans.filter((x) => x.to === 'approach' && x.from !== 'approach' && x.from !== 'attack').map((x) => x.kind);
    const atk = T.ev.filter((x) => x.ev === 'enemy:attack' && x.type !== 'tail').map((x) => x.type);
    let streak = 0;
    let maxRam = 0;
    for (const k of atk) {
      streak = k === 'ram' ? streak + 1 : 0;
      maxRam = Math.max(maxRam, streak);
    }
    const bites = atk.filter((k) => k === 'bite').length;
    return { commits: kinds.join(','), attacks: atk.join(','), maxRamStreak: maxRam, biteShare: r2(bites / Math.max(1, atk.length)) };
  },
};

const t0 = performance.now();
const g = makeGame();
const T = harness(g);
console.log(`[sim] built in ${((performance.now() - t0) / 1000).toFixed(1)} s (quality ${QUALITY})`);
for (const name of CHECKS) {
  const fn = CHECK[name];
  if (!fn) {
    console.log(`[sim] unknown check ${name}`);
    continue;
  }
  const runs = [];
  for (let k = 0; k < RUNS; k++) runs.push(fn(g, T));
  for (const r of runs) console.log(`${name} ${JSON.stringify(r)}`);
  const num = (key) => runs.map((r) => r[key]).filter(Number.isFinite);
  const summary = {};
  for (const key of ['deathAt', 'medianDist', 'occ02', 'above4', 'maxRamStreak', 'biteShare', 'stacked', 'telePer60', 'flank', 'killedAt', 'atkPerMin', 'vis25', 'vis55', 'swingsPerMin', 'swingLen', 'wideShare']) {
    const v = num(key);
    if (v.length) summary[key] = { median: r2(median(v)), min: r2(Math.min(...v)), max: r2(Math.max(...v)) };
  }
  const nulls = runs.filter((r) => 'deathAt' in r && r.deathAt === null).length;
  if (nulls) summary.survived = nulls;
  console.log(`## ${name} ${JSON.stringify(summary)}`);
}
process.exit(0);
