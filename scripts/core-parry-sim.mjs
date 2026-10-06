// Browserless parry-balance sweep (Node, no WebGL — no gate needed). The stub game of
// scripts/enemies-sim.mjs (the real Player / EnemyManager / CombatSystem / CameraRig, stepped
// like Game.frame under ?fixeddt) driven by the bots of scripts/core-parry-spam.mjs and the
// cue trials of scripts/player-parry-scenario.mjs. ≈20× faster than the stepped browser run,
// so tuning can be swept over 32+ seeds first; the browser scripts stay the acceptance
// reference (same seeds still give different fights there — single cells can disagree).
//
//   node scripts/core-parry-sim.mjs [spam] [cue] [--seeds 16] [--base 1] [--cd 0.6,0.9]
//        [--variants file.json] [--waves 0,1,2] [--bots rhythm:24,mash:2,patient:120]
//        [--sec 160] [--verbose]
//
// spam  per wave: an idle player vs never-attacking parry bots (press every N frames, mash
//       out of grabs), Math.random seeded per run (mulberry32): median and mean death-time
//       ratio to idle (a run that outlives --sec counts 100 HP / damage rate) and the share
//       of attacks parried. Target ≤ 1.3× everywhere.
// cue   great-white trials from a fresh wave (attack kind forced, no feints): bite / ram on
//       the enemy:strike cue, and a panicked press 0.6 / 0.45 / 0.3 s before the telegraph
//       ends followed by the on-cue press (n/seeds parried).
// Variants: the shipped tuning plus one per --cd value, or a JSON list from --variants of
//   { name, cd, k, grace, max, decay, lock, lockPerF, retry, bots? } patched onto the player
//   instance (f = spam fatigue) — cd: parryCooldown; k (+ grace, default 0): window =
//   parryWindow / (1 + k·max(0, f − grace)); max: fatigue cap; decay: fatigue drain per s;
//   lock (default 0.15) + lockPerF (default 0) · max(0, f − (grace ?? 1)): s after a whiff
//   with no new parry (the whiff pose keeps its shipped length); retry: false drops the
//   round-3 retry (the first press after a lone, unfatigued whiff skips the cooldown and
//   the whiff lock — Player PARRY_RETRY). Omitted = shipped. Round 2's whiff rules:
//   { "k": 0.75, "decay": 1, "retry": false }.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { EventBus } from '../src/core/EventBus.js';
import { WORLD, PLAYER } from '../src/core/config.js';
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
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const SEEDS = Array.from({ length: +opt('--seeds', 16) }, (_, i) => i + +opt('--base', 1));
const CDS = opt('--cd', '').split(',').filter(Boolean).map(Number);
const VFILE = opt('--variants', null);
const WAVES = opt('--waves', '0,1,2').split(',').map(Number);
const BOTS = opt('--bots', 'rhythm:24,mash:2,patient:120').split(',').map((s) => s.split(':')).map(([n, e]) => [n, +e]);
const SEC = +opt('--sec', 160);
const VERBOSE = flag('--verbose');
const MODES = args.length ? args : ['spam', 'cue'];
const variants = VFILE ? JSON.parse(readFileSync(VFILE, 'utf8')) : [{ name: 'shipped' }, ...CDS.map((cd) => ({ name: `cd ${cd}`, cd }))];

// ---------------------------------------------------------------- stub game (as enemies-sim)
const noop = () => {};
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
    quality: 'high',
    time: { elapsed: 0, realElapsed: 0, dt: 0, realDt: 0, timeScale: 1, frame: 0 },
    _hitstopUntil: 0, _hitstopScale: 1, _slowmoUntil: 0, _slowmoScale: 1,
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
  const down = new Set();
  const just = new Set();
  g.input = {
    mouseDX: 0, mouseDY: 0, pointerLocked: true,
    isDown: (a) => down.has(a),
    pressed: (a) => just.has(a),
    released: () => false,
    axis: (p, n) => (down.has(p) ? 1 : 0) - (down.has(n) ? 1 : 0),
    simulate(a, on) {
      if (on && !down.has(a)) just.add(a);
      if (on) down.add(a);
      else down.delete(a);
    },
    requestPointerLock: noop, exitPointerLock: noop,
    endFrame: () => just.clear(),
  };
  const hf = new Heightfield(200, LAYOUT.size);
  g.env = {
    bounds: { surfaceY: WORLD.surfaceY, floorY: WORLD.floorY, radius: WORLD.arenaRadius },
    waterColor: new THREE.Color(0x0b3a4a),
    sunDirection: new THREE.Vector3(0.2, 0.9, -0.38).normalize(),
    landmarks: {},
    getSeabedHeight: (x, z) => hf.heightAt(x, z),
    update: noop,
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

const g = makeGame();
const P = g.player;
const proto = Object.getPrototypeOf(P);
g.events.on('player:death', () => g.setState('dead'));

// Shipped fatigue drain, measured (the constant is private to Player.js).
P._parryFatigue = 2;
P.update(0.1);
const SHIPPED_DECAY = (2 - P._parryFatigue) / 0.1;
P.reset();

// ---------------------------------------------------------------- variant patches + counters
const X = { V: {}, c: { parried: 0, attacks: 0, hits: 0, grabs: 0, whiffs: 0, attempts: 0 }, tele: null, strikes: [], kind: 'bite', lastWin: 0 };
g.events.on('enemy:telegraph', (p) => { X.tele = { t: g.time.elapsed, dur: p.duration, type: p.type, enemy: p.enemy }; });
g.events.on('enemy:strike', (p) => { X.strikes.push({ t: g.time.elapsed, type: p.type, eta: p.eta }); });
g.events.on('enemy:attack', () => X.c.attacks++);
g.events.on('player:hit', () => X.c.hits++);
g.events.on('grab:start', () => X.c.grabs++);
g.events.on('player:parry', (p) => {
  if (p?.success) X.c.parried++;
  if (p?.whiff) X.c.whiffs++;
  if (p?.attempt) X.c.attempts++;
});
P._tryParry = function () {
  const f = this._parryFatigue;
  const ok = proto._tryParry.call(this);
  if (ok) {
    const V = X.V;
    if (V.cd != null) this._parryCooldown = V.cd;
    if (V.k != null) this._parryWin = PLAYER.parryWindow / (1 + V.k * Math.max(0, f - (V.grace ?? 0)));
    X.lastWin = this._parryWin;
  }
  return ok;
};
P._whiff = function () {
  const f = this._parryFatigue;
  proto._whiff.call(this);
  if (X.V.max != null) this._parryFatigue = Math.min(X.V.max, f + 1);
  if (X.V.lock != null) this._parryLock = X.V.lock;
  if (X.V.lock != null || X.V.lockPerF != null) {
    this._parryLock = (X.V.lock ?? 0.15) + (X.V.lockPerF ?? 0) * Math.max(0, this._parryFatigue - (X.V.grace ?? 1));
  }
  // round-2 rules: no retry after a lone whiff (Player PARRY_RETRY, round 3)
  if (X.V.retry === false) this._parryRetry = false;
};
P.update = function (dt) {
  if (X.V.decay != null) this._parryFatigue = Math.max(0, this._parryFatigue - Math.max(0, dt) * (X.V.decay - SHIPPED_DECAY));
  return proto.update.call(this, dt);
};

// ---------------------------------------------------------------- helpers
const seed = (s) => {
  let a = s >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const tap = (a) => {
  g.input.simulate(a, true);
  g.input.simulate(a, false);
};
const release = () => {
  for (const a of ['forward', 'back', 'left', 'right', 'dodge', 'heavy', 'attack', 'parry', 'up', 'down']) g.input.simulate(a, false);
};
const resetWave = (wave) => {
  g.combat.qte?.end?.(false);
  g.debug.god = false;
  P.reset();
  g.cameraRig.lockTarget = null;
  g.director.waveIndex = wave;
  g.setState('playing');
  g.enemies.spawnWave(wave);
  release();
};
const frames = (n, pred, hook) => {
  for (let i = 0; i < n; i++) {
    hook?.(i);
    g.frame();
    if (pred?.()) return i + 1;
  }
  return n;
};
const r3 = (v) => +(+v).toFixed(3);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// One great-white attack of kind X.kind (see player-parry-scenario.mjs T.trial).
const trial = (opts) => {
  const s = g.enemies.enemies.find((e) => e.alive);
  const nudge = () => {
    const ai = s.ai;
    ai._chooseAttack = () => X.kind;
    ai.feints = 0;
    ai._firstDecisionDone = true;
    ai._firstCommitDone = true;
    if (ai.state === 'circle') ai.decisionTimer = Math.min(ai.decisionTimer, 0.2);
    ai.tailCd = 99;
  };
  X.tele = null;
  X.strikes = [];
  const a0 = X.c.attempts;
  frames(60 * 40, () => X.tele && X.tele.type === X.kind && X.tele.enemy === s, nudge);
  if (!X.tele) return { err: 'no telegraph' };
  const teleEnd = X.tele.t + X.tele.dur;
  const res = {};
  let end = null;
  let pressed = false;
  let pre = false;
  let cue = null;
  const p0 = X.c.parried;
  const h0 = X.c.hits;
  frames(60 * 4, () => {
    if (cue === null && X.strikes.length) cue = X.strikes[0].t - teleEnd;
    if (g.combat.grab) end = 'grab';
    else if (X.c.parried > p0) end = 'parry';
    else if (['recover', 'stagger', 'circle'].includes(s.ai.state)) end = X.c.hits > h0 ? 'hit' : 'shark:' + s.ai.state;
    return end !== null;
  }, () => {
    const t = g.time.elapsed - teleEnd;
    if (opts.pre !== undefined && !pre && t >= opts.pre - 1 / 120) {
      tap('parry');
      pre = true;
      res.pre = r3(t);
    }
    if (!pressed && cue !== null && t >= cue - 1 / 120) {
      tap('parry');
      pressed = true;
      res.f = r3(P._parryFatigue);
      res.cd = r3(P._parryCooldown);
    }
  });
  Object.assign(res, { cue: cue === null ? null : r3(cue), presses: X.c.attempts - a0, win: r3(X.lastWin), end, ok: end === 'parry' });
  return res;
};

const spam = (wave, every, s) => {
  seed(s);
  resetWave(wave);
  const c0 = { ...X.c };
  const t0 = g.time.elapsed;
  let k = 0;
  let m = 0;
  let deathAt = null;
  frames(SEC * 60, () => {
    if (!P.alive) deathAt = g.time.elapsed - t0;
    return deathAt !== null;
  }, () => {
    if (g.combat.grab) {
      if (++m % 4 === 0) tap('attack');
    } else if (every > 0 && ++k % every === 0) tap('parry');
  });
  const dur = g.time.elapsed - t0;
  const lost = 100 - Math.max(0, P.health);
  const d = { deathAt: deathAt === null ? null : r3(deathAt), est: Math.min(999, deathAt ?? (lost > 0 ? (dur * 100) / lost : 999)) };
  for (const key in X.c) d[key] = X.c[key] - c0[key];
  release();
  return d;
};

// ---------------------------------------------------------------- runs
const t0 = performance.now();
console.log(`[parry-sim] cooldown ${PLAYER.parryCooldown} s, window ${PLAYER.parryWindow} s, fatigue drain ${r3(SHIPPED_DECAY)}/s; ${SEEDS.length} seeds; variants: ${variants.map((v) => v.name).join(', ')}`);
if (MODES.includes('cue')) {
  const sets = [
    ['bite on strike', 'bite', {}],
    ['ram on strike', 'ram', {}],
    ['bite: press 0.6 s before telegraph end, then on strike', 'bite', { pre: -0.6 }],
    ['ram: press 0.6 s before telegraph end, then on strike', 'ram', { pre: -0.6 }],
    ['bite: press 0.45 s before telegraph end, then on strike', 'bite', { pre: -0.45 }],
    ['bite: press 0.3 s before telegraph end, then on strike', 'bite', { pre: -0.3 }],
  ];
  for (const v of variants) {
    X.V = v;
    for (const [name, kind, o] of sets) {
      const rs = SEEDS.map((s) => {
        seed(s + 299);
        resetWave(0);
        X.kind = kind;
        return trial(o);
      });
      console.log(`cue  ${v.name.padEnd(16)} ${name.padEnd(56)} ${rs.filter((r) => r.ok).length}/${rs.length}`);
      if (VERBOSE) for (const r of rs) console.log('     ' + JSON.stringify(r));
    }
  }
}
if (MODES.includes('spam')) {
  const rows = [];
  for (const s of SEEDS) {
    for (const wave of WAVES) {
      X.V = {};
      rows.push({ v: '-', bot: 'idle', wave, s, ...spam(wave, 0, s) });
      for (const v of variants) {
        X.V = v;
        for (const [bot, every] of v.bots ?? BOTS) rows.push({ v: v.name, bot, wave, s, ...spam(wave, every, s) });
      }
    }
  }
  if (VERBOSE) for (const r of rows) console.log('run  ' + JSON.stringify(r));
  const idleOf = (wave) => rows.filter((r) => r.wave === wave && r.bot === 'idle').map((r) => r.est);
  console.log(`idle median death ${WAVES.map((w) => `w${w} ${median(idleOf(w)).toFixed(1)} s`).join(' | ')}`);
  for (const v of variants) {
    for (const [bot] of v.bots ?? BOTS) {
      const cells = WAVES.map((wave) => {
        const idle = idleOf(wave);
        const q = rows.filter((r) => r.wave === wave && r.v === v.name && r.bot === bot);
        const atk = q.reduce((n, r) => n + r.attacks, 0);
        const par = q.reduce((n, r) => n + r.parried, 0);
        const med = median(q.map((r) => r.est)) / median(idle);
        const mn = mean(q.map((r) => r.est)) / mean(idle);
        return `w${wave} ${med.toFixed(2)}× (mean ${mn.toFixed(2)}×, parried ${((100 * par) / Math.max(1, atk)).toFixed(0)} %)`;
      });
      console.log(`spam ${v.name.padEnd(16)} ${bot.padEnd(8)} ${cells.join(' | ')}`);
    }
  }
}
console.log(`[parry-sim] ${((performance.now() - t0) / 1000).toFixed(1)} s`);
process.exit(0);
