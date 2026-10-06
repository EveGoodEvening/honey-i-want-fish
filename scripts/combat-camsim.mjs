#!/usr/bin/env node
// Browser-free camera checks for the combat module (CameraRig + cinematics).
// The real Player / EnemyManager / CombatSystem / CameraRig run on a stub game
// (no renderer, audio, VFX or UI) stepped like Game.frame under ?fixeddt, on a
// 1280×720 virtual screen; Math.random is seeded per run (mulberry32). Based
// on the round-3 tension lens's camsim harness. No browser, no gate:
//
//   node scripts/combat-camsim.mjs [check …] [--seeds N]
//
// Checks (default: all), each printing one JSON line per run and a
// `## <check> {…, pass}` summary:
//   whip      120 s locked, god, grabs broken at once, per wave: frames whose rig
//             rotation (pre-shake) exceeds 0.1 rad ≤ 5 per run (the lock no longer
//             whip-pans on a shark within ~4 m / passing overhead); the run's first
//             two frames (the scripted lock snap) are skipped
//   dying     idle player, locked, god off, per wave: rig rotation ≤ 0.06 rad/frame
//             over the 2.6 s dying beat (player:death drops the lock)
//   bosscue   phase-3 megalodon, locked, god, 120 s: the lock reticle (head hurtbox,
//             |ndc| ≤ 1.05) is on screen at ≥ 80 % of the strike cues of close bites
//             (mouth < 7 m at the telegraph end), pooled over the seeds
//   bossboom  megalodon, locked, god: 60 s of phase 1 (its hits shove 老公 down to
//             the seabed), then 60 s of phase 3: camera ↔ 老公 distance over the
//             phase-3 minute, 5th percentile ≥ 2.5 m
//   victory   a chase bot kills the megalodon (lock, swim at it, slash, parry the
//             cues). At victory +1.5 s, in ≥ 90 % of the runs: the corpse's bbox is
//             15–50 % of the frame, its centroid left of the stats panel (NDC x <
//             −0.16), 老公 inside the letterbox and not hidden behind it; up to +6 s,
//             in every run: the corpse never seen from > 10° below, 老公 ≥ 5 % of the
//             frame height, no sight line > 10 % through rock (cinematics `occluded`)
//   victorywall  the same, the kill moved under the middle of the reef wall
//   breather  after the tiger wave's wave:clear the idle view levels from −0.7 to
//             ≈ 0.05 within 2 s; a mouse move stops it
// Each check runs on a fresh stub game with every species built before the
// seeded runs (a first build draws on Math.random), so it reads the same alone
// or after other checks.
import * as THREE from 'three';
import { EventBus } from '../src/core/EventBus.js';
import { WORLD } from '../src/core/config.js';
import { Heightfield, LAYOUT } from '../src/world/terrain.js';
import { Player } from '../src/player/Player.js';
import { EnemyManager } from '../src/enemies/EnemyManager.js';
import { CombatSystem } from '../src/combat/CombatSystem.js';
import { CameraRig } from '../src/camera/CameraRig.js';
import { occluded } from '../src/camera/cinematics.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const SEEDS = Number(opt('--seeds', 6));
const ALL = ['whip', 'dying', 'bosscue', 'bossboom', 'victory', 'victorywall', 'breather'];
const CHECKS = args.length ? args : ALL;
const W = 1280;
const H = 720;
const noop = () => {};
const nullProxy = new Proxy({}, { get: () => noop });
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[(a.length / 2) | 0] : null);
const pct = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : null);
const warn = console.warn;
console.warn = (...a) => {
  if (!String(a[0]).includes('PMREM')) warn(...a);
};

function seedRandom(s) {
  let a = s >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGame() {
  const g = {
    debug: { autostart: true, wave: 0, god: false, fixedDt: true },
    events: new EventBus(),
    state: 'boot',
    danger: 0,
    quality: 'high',
    time: { elapsed: 0, realElapsed: 0, dt: 0, realDt: 0, timeScale: 1, frame: 0 },
    _hitstopUntil: 0,
    _hitstopScale: 1,
    _slowmoUntil: 0,
    _slowmoScale: 1,
    renderer: null,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(62, W / H, 0.1, 700),
    vfx: nullProxy,
    post: { pulse: noop, flash: noop },
    audio: nullProxy,
    ui: nullProxy,
    director: { waveIndex: 0, stats: {}, stateTime: 0 },
  };
  g.scene.add(g.camera);
  g.setState = (next) => {
    if (next === g.state) return;
    const from = g.state;
    g.state = next;
    g.director.stateTime = 0;
    g.events.emit('game:state', { from, to: next });
  };
  g.hitstop = (duration = 0.08, scale = 0.02) => {
    g._hitstopUntil = Math.max(g._hitstopUntil, g.time.realElapsed + duration);
    g._hitstopScale = Math.min(scale, g._hitstopScale);
  };
  g.slowmo = (duration = 0.6, scale = 0.3) => {
    g._slowmoUntil = Math.max(g._slowmoUntil, g.time.realElapsed + duration);
    g._slowmoScale = Math.min(scale, g._slowmoScale);
  };
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
  // build (and cache) every species before any seeded run: a first build
  // draws on Math.random and would shift the fights of whichever check ran it
  for (let w = 0; w < 3; w++) g.enemies.spawnWave(w);
  g.enemies.clear();
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
    g.director.stateTime += realDt;
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

// ------------------------------------------------------------------ helpers
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
function project(g, w) {
  _a.copy(w).project(g.camera);
  return { x: _a.x, y: _a.y, front: _a.z < 1 && _a.z > -1 };
}
/** Clipped screen bbox area (fraction) of an enemy's hurtbox spheres. */
function coverArea(g, e) {
  const cam = g.camera;
  const f = H / 2 / Math.tan((cam.fov * Math.PI) / 360);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const hb of e.hurtboxes) {
    _a.copy(hb.center).applyMatrix4(cam.matrixWorldInverse);
    const z = -_a.z;
    if (z < 0.3) continue;
    const sx = W / 2 + (_a.x / z) * f;
    const sy = H / 2 - (_a.y / z) * f;
    const rr = (hb.radius / z) * f;
    x0 = Math.min(x0, sx - rr);
    x1 = Math.max(x1, sx + rr);
    y0 = Math.min(y0, sy - rr);
    y1 = Math.max(y1, sy + rr);
  }
  const cx0 = Math.max(0, x0);
  const cx1 = Math.min(W, x1);
  const cy0 = Math.max(0, y0);
  const cy1 = Math.min(H, y1);
  return cx1 > cx0 && cy1 > cy0 ? ((cx1 - cx0) * (cy1 - cy0)) / (W * H) : 0;
}
/**
 * The victory shot of a corpse: its bbox (area, x range as shares of the
 * width), its centroid's NDC x, |cos| between the view and its body axis,
 * the elevation it is seen at (deg, + = from below), 老公's share of the
 * frame height, and the share of each sight line through rock.
 */
function victoryShot(g, e) {
  const cam = g.camera;
  const f = H / 2 / Math.tan((cam.fov * Math.PI) / 360);
  let x0 = Infinity;
  let x1 = -Infinity;
  const B = new THREE.Vector3();
  let w = 0;
  for (const hb of e.hurtboxes) {
    B.addScaledVector(hb.center, hb.radius);
    w += hb.radius;
    _a.copy(hb.center).applyMatrix4(cam.matrixWorldInverse);
    const z = -_a.z;
    if (z < 0.3) continue;
    const sx = W / 2 + (_a.x / z) * f;
    const rr = (hb.radius / z) * f;
    x0 = Math.min(x0, sx - rr);
    x1 = Math.max(x1, sx + rr);
  }
  B.multiplyScalar(1 / w);
  const v = new THREE.Vector3().subVectors(B, cam.position);
  const side = Math.abs(v.clone().normalize().dot(e.forward));
  const p = g.player.position;
  const top = project(g, _b.set(p.x, p.y + 0.95, p.z));
  const bot = project(g, _b.set(p.x, p.y - 0.85, p.z));
  const hc = g.player.hurtbox?.center ?? p;
  return {
    area: r2(coverArea(g, e)),
    bx: [r2(Math.max(0, x0) / W), r2(Math.min(W, x1) / W)],
    cx: r2(project(g, B).x),
    side: r2(side),
    lookUp: r2((Math.asin(v.y / v.length()) * 180) / Math.PI),
    heroH: r3((top.y - bot.y) / 2),
    occ: [r2(occluded(g.env, cam.position, B, 1 + 0.1 * e.length)), r2(occluded(g.env, cam.position, hc))],
  };
}
/** 老公 inside the 10 % letterbox bars and not behind the corpse's spheres. */
function heroVisible(g, corpse) {
  const p = g.player.position;
  const top = project(g, _b.set(p.x, p.y + 0.95, p.z));
  const bot = project(g, _b.set(p.x, p.y - 0.85, p.z));
  const inFrame = top.front && bot.front && Math.abs(top.x) < 1 && Math.abs(bot.x) < 1 && top.y < 0.8 && bot.y > -0.8;
  const cam = g.camera.position;
  const tgt = g.player.hurtbox?.center ?? p;
  const dir = _b.subVectors(tgt, cam);
  const L = dir.length();
  dir.normalize();
  for (const hb of corpse.hurtboxes) {
    _a.subVectors(hb.center, cam);
    const tca = _a.dot(dir);
    if (tca < 0 || tca > L) continue;
    if (_a.lengthSq() - tca * tca < hb.radius * hb.radius * 0.8) return false;
  }
  return inFrame;
}
/** Rotation (rad) of the rig's pre-shake orientation since the last call. */
function rigTracer(g) {
  const pq = new THREE.Quaternion();
  let have = false;
  return () => {
    const q = g.cameraRig._quat;
    const dq = have ? 2 * Math.acos(Math.min(1, Math.abs(q.dot(pq)))) : 0;
    pq.copy(q);
    have = true;
    return dq;
  };
}

function harness(g) {
  const T = {};
  T.reset = (wave, god) => {
    g.combat.qte?.end?.(false);
    g.debug.god = god;
    g.player.reset();
    g.cameraRig.lockTarget = null;
    g.director.waveIndex = wave;
    g.setState('playing');
    g.enemies.spawnWave(wave);
    T.t0 = g.time.elapsed;
  };
  // keep a lock (a scripted lock snaps the rig yaw: callers skip those frames)
  T.keepLock = () => {
    const rig = g.cameraRig;
    if (!g.player.alive || (rig.lockTarget && rig.lockTarget.alive)) return;
    const alive = g.enemies.getAlive();
    if (!alive.length) return;
    const e = alive[0];
    const p = g.player.position;
    rig.yaw = Math.atan2(-(e.position.x - p.x), -(e.position.z - p.z));
    rig.toggleLock();
  };
  T.run = (sec, hook) => {
    const n = Math.round(sec * 60);
    for (let i = 0; i < n; i++) {
      g.frame();
      if (hook && hook(i)) return i;
    }
    return n;
  };
  return T;
}

// ------------------------------------------------------------------ checks
const CHECK = {
  whip(g, T, seed, sum) {
    const out = {};
    for (const wave of [0, 1, 2]) {
      T.reset(wave, true);
      const trace = rigTracer(g);
      let n = 0;
      let big = 0;
      let max = 0;
      T.run(120, () => {
        if (g.combat.grab) g.combat.qte.end(true);
        const relock = !g.cameraRig.lockTarget;
        T.keepLock();
        const dq = trace();
        if (relock) n = 0; // a scripted (re)lock snaps the yaw
        if (++n > 2) {
          if (dq > 0.1) big++;
          max = Math.max(max, dq);
        }
        return false;
      });
      out[`w${wave}`] = { over01: big, max: r3(max) };
      sum.push(big);
    }
    return out;
  },
  dying(g, T, seed, sum) {
    const out = {};
    for (const wave of [0, 1, 2]) {
      T.reset(wave, false);
      T.run(150, () => {
        T.keepLock();
        return !g.player.alive;
      });
      if (g.player.alive) {
        out[`w${wave}`] = 'survived';
        continue;
      }
      const trace = rigTracer(g);
      trace();
      let max = 0;
      T.run(2.6, () => {
        max = Math.max(max, trace());
        return false;
      });
      out[`w${wave}`] = { max: r3(max), locked: !!g.cameraRig.lockTarget };
      sum.push(max);
    }
    return out;
  },
  bosscue(g, T, seed, sum) {
    T.reset(2, true);
    const b = g.enemies.getBoss();
    b.takeHit({ damage: Math.round(b.health - b.maxHealth * 0.2), part: 'body', attackType: 'heavy' });
    let cue = false;
    let mdTele = null;
    const on = ({ enemy } = {}) => {
      if (enemy === b) cue = true;
    };
    g.events.on('enemy:strike', on);
    const head = b.hurtboxes.find((h) => h.part === 'head') ?? b.hurtboxes[0];
    let close = 0;
    let shown = 0;
    let all = 0;
    let allShown = 0;
    T.run(120, () => {
      if (g.combat.grab) g.combat.qte.end(true);
      T.keepLock();
      if (b.ai.state === 'telegraph') mdTele = b.getMouthPosition().distanceTo(g.player.position);
      if (!cue) return false;
      cue = false;
      const p = project(g, head.center);
      const ok = p.front && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05;
      all++;
      if (ok) allShown++;
      if (mdTele != null && mdTele < 7) {
        close++;
        if (ok) shown++;
      }
      return false;
    });
    g.events.off?.('enemy:strike', on);
    sum.push([shown, close, allShown, all]);
    return { close, closeShown: shown, cues: all, cuesShown: allShown };
  },
  bossboom(g, T, seed, sum) {
    T.reset(2, true);
    const b = g.enemies.getBoss();
    // phase 1 first: its hits shove the idle 老公 down to the seabed
    T.run(60, () => {
      if (g.combat.grab) g.combat.qte.end(true);
      T.keepLock();
      return false;
    });
    b.takeHit({ damage: Math.round(b.health - b.maxHealth * 0.2), part: 'body', attackType: 'heavy' });
    const d = [];
    T.run(60, () => {
      if (g.combat.grab) g.combat.qte.end(true);
      T.keepLock();
      d.push(g.camera.position.distanceTo(g.player.position));
      return false;
    });
    const p5 = pct(d, 0.05);
    sum.push(p5);
    return { p5: r2(p5), min: r2(Math.min(...d)) };
  },
  victory(g, T, seed, sum) {
    return victoryRun(g, T, sum, false);
  },
  victorywall(g, T, seed, sum) {
    return victoryRun(g, T, sum, true);
  },
  breather(g, T, seed, sum) {
    const res = {};
    for (const mouse of [false, true]) {
      T.reset(1, true);
      T.run(1);
      for (const e of g.enemies.enemies) if (e.alive) e.takeHit({ damage: 1e6, part: 'gills', attackType: 'heavy' });
      g.cameraRig.pitch = -0.7;
      let at2 = null;
      T.run(4, (i) => {
        g.input.mouseDY = mouse && i === 10 ? 5 : 0;
        if (i === 119) at2 = g.cameraRig.pitch;
        return false;
      });
      g.input.mouseDY = 0;
      res[mouse ? 'mouse' : 'idle'] = r2(at2);
    }
    sum.push(res);
    return res;
  },
};

/** A chase bot kills the megalodon (by the reef wall when `wall`), then the victory shot is measured. */
function victoryRun(g, T, sum, wall) {
  {
    T.reset(2, true);
    const I = g.input;
    const P = g.player;
    const b = g.enemies.getBoss();
    let cue = false;
    const on = ({ enemy } = {}) => {
      if (enemy === b) cue = true;
    };
    g.events.on('enemy:strike', on);
    const tap = (a) => {
      I.simulate(a, true);
      I.simulate(a, false);
    };
    const gap = () => {
      let best = 1e9;
      for (const hb of b.hurtboxes) best = Math.min(best, hb.center.distanceTo(P.hurtbox.center) - hb.radius);
      return best;
    };
    let atkCd = 0;
    let lockCd = 0;
    T.run(240, () => {
      if (g.combat.grab) g.combat.qte.end(true);
      if (cue) {
        tap('parry');
        cue = false;
      }
      if (!g.cameraRig.lockTarget && --lockCd <= 0) {
        tap('lock');
        lockCd = 20;
      }
      if (gap() > 2) I.simulate('forward', true);
      else {
        I.simulate('forward', false);
        if (--atkCd <= 0) {
          tap('attack');
          atkCd = 10;
        }
      }
      return !b.alive;
    });
    I.simulate('forward', false);
    g.events.off?.('enemy:strike', on);
    if (b.alive) return { error: 'no kill in 240 s' };
    // Director: 'victory' 3.4 s after the last wave:clear
    T.run(3.4 + 0.3);
    if (wall) {
      // the same kill by the reef wall: 老公 at r 54 under its middle, at his
      // height over the seabed, the corpse moved along (kept on the open side)
      const c = LAYOUT.cliff.center;
      const tx = 54 * Math.sin(c);
      const tz = -54 * Math.cos(c);
      const hf = g.env.getSeabedHeight;
      // (height over the seabed capped: a kill over the trench would land in the air)
      const ty = Math.min(-8, hf(tx, tz) + Math.min(12, P.position.y - hf(P.position.x, P.position.z)));
      const off = new THREE.Vector3().subVectors(b.position, P.position);
      if (Math.hypot(tx + off.x, tz + off.z) > 56) off.set(-off.x, off.y, -off.z);
      P.position.set(tx, ty, tz);
      P.velocity.set(0, 0, 0);
      b.position.set(tx + off.x, Math.min(-5, Math.max(ty + off.y, hf(tx + off.x, tz + off.z) + 1.5)), tz + off.z);
      T.run(0.1);
    }
    g.setState('victory');
    const trace = rigTracer(g);
    trace();
    let max = 0;
    T.run(1.5, () => {
      max = Math.max(max, trace());
      return false;
    });
    const s15 = victoryShot(g, b);
    const shot = { area: s15.area, hero: heroVisible(g, b), corpseD: r2(b.position.distanceTo(P.position)) };
    let lookUp = s15.lookUp;
    let heroH = s15.heroH;
    let occ = Math.max(...s15.occ);
    let occAt = `${s15.occ.join('/')}@1.5`;
    T.run(4.5, (i) => {
      max = Math.max(max, trace());
      if (i % 30 === 29) {
        const s = victoryShot(g, b);
        lookUp = Math.max(lookUp, s.lookUp);
        heroH = Math.min(heroH, s.heroH);
        if (Math.max(...s.occ) > occ) occAt = s.occ.join("/") + "@" + r2(1.5 + (i + 1) / 60);
        occ = Math.max(occ, ...s.occ);
      }
      return false;
    });
    Object.assign(shot, { cx: s15.cx, bx: s15.bx, side: s15.side, lookUp: r2(lookUp), heroH: r3(heroH), occ: r2(occ), occAt });
    sum.push(shot);
    return { ...shot, maxRot: r3(max) };
  }
}

/**
 * ≥ 90 % of the shots: corpse bbox 15–50 % of the frame, its centroid left of
 * the stats panel (NDC x < −0.16), 老公 in the letterbox and unhidden; every
 * shot: the corpse never seen from more than 10° below, 老公 ≥ 5 % of the
 * frame height, no sight line more than 10 % through rock.
 */
function victoryVerdict(s) {
  const good = s.filter((x) => x.area >= 0.15 && x.area <= 0.5 && x.cx < -0.16 && x.hero).length;
  return {
    areas: s.map((x) => x.area).join(' '),
    good: `${good}/${s.length}`,
    lookUp: r2(Math.max(...s.map((x) => x.lookUp))),
    heroH: r3(Math.min(...s.map((x) => x.heroH))),
    occ: r2(Math.max(...s.map((x) => x.occ))),
    pass: s.length > 0 && good >= 0.9 * s.length && s.every((x) => x.lookUp <= 10 && x.heroH >= 0.05 && x.occ <= 0.1),
  };
}

const VERDICT = {
  whip: (s) => ({ worst: Math.max(...s), pass: Math.max(...s) <= 5 }),
  dying: (s) => ({ worst: r3(Math.max(...s)), pass: Math.max(...s) <= 0.06 }),
  bosscue: (s) => {
    const t = s.reduce((a, x) => a.map((v, i) => v + x[i]), [0, 0, 0, 0]);
    const close = t[1] ? t[0] / t[1] : 1;
    return { closeShown: `${t[0]}/${t[1]}`, closePct: r2(100 * close), allPct: r2((100 * t[2]) / Math.max(1, t[3])), pass: close >= 0.8 };
  },
  bossboom: (s) => ({ p5: r2(median(s)), worst: r2(Math.min(...s)), pass: Math.min(...s) >= 2.5 }),
  victory: (s) => victoryVerdict(s),
  victorywall: (s) => victoryVerdict(s),
  breather: (s) => ({ idle: s.map((x) => x.idle).join(' '), mouse: s.map((x) => x.mouse).join(' '), pass: s.every((x) => Math.abs(x.idle - 0.05) < 0.05 && x.mouse < -0.3) }),
};

const report = {};
for (const name of CHECKS) {
  const fn = CHECK[name];
  if (!fn) {
    console.log(`unknown check ${name} (have: ${ALL.join(', ')})`);
    continue;
  }
  // a fresh stub game per check: a check reads the same alone or after others
  // (game time / AI state carried over used to change its fights)
  const g = makeGame();
  const T = harness(g);
  const sum = [];
  for (let s = 1; s <= SEEDS; s++) {
    seedRandom(1000 + s * 7919);
    let r;
    try {
      r = fn(g, T, s, sum);
    } catch (e) {
      r = { error: String(e.stack || e).slice(0, 600) };
    }
    console.log(`${name} s${s} ${JSON.stringify(r)}`);
  }
  report[name] = sum.length ? VERDICT[name](sum) : { pass: false, error: 'no samples' };
  console.log(`## ${name} ${JSON.stringify(report[name])}`);
}
console.log(`combat-camsim ${JSON.stringify(Object.fromEntries(Object.entries(report).map(([k, v]) => [k, v.pass])))}`);
process.exit(0);
