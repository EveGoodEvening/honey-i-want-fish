// Pressure / pacing checks for the enemies module. Runs the real game loop
// (g.frame) with the render pass disabled and logs one '### name {json}' line
// per check:
//   chase-waveN      lock-on "swim at it and stab" bot, 120 s per wave: bite
//                    telegraphs per 25 s, knife hits per 10 s, kill time
//                    (the approach stalemate must not come back)
//   gw-opening       5 runs: first committed attack is a bite, ~15–25 s in
//   danger-wave0     game.danger ≥ 0.9 only around telegraph → attack windows
//   *-idle-death     idle player, god off (time to death, stacked hits)
//   tiger-cadence    telegraphs / 60 s and flank attacks
//   boss-presence    median distance, time above 老公, light occlusion, feints
//   shockwave / roar / wake / boss-parry-punish   boss set pieces
// then the module's AI scenario (contract checks).
//
//   ~/.claude/bin/heavy-gate -n 1 -l enemies -- node scripts/smoke.mjs --dist --step \
//       --params 'autostart&fixeddt&god&stats' --wait 300 --shots 0 \
//       --scenario scripts/enemies-pressure-scenario.mjs --out .smoke/enemies/pressure
// Idle-death times include grab-fail damage only once CombatSystem applies it.
export default async function scenario(page, ctx) {
  const { log } = ctx;
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const out = (k, v) => log(`### ${k} ${JSON.stringify(v)}`);

  await ev(() => {
    const g = window.__game;
    const T = (window.__T = {});
    const V3 = g.camera.position.constructor;
    T.V3 = V3;
    const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
    T.r2 = r2;
    T.ev = [];
    const names = ['enemy:telegraph', 'enemy:attack', 'enemy:roar', 'enemy:hit', 'player:hit', 'player:parry', 'grab:start', 'grab:end', 'player:death', 'wave:start'];
    for (const n of names) {
      g.events.on(n, (p = {}) => {
        const o = { t: r2(g.time.elapsed), ev: n };
        if (p.enemy) {
          o.who = g.enemies.enemies.indexOf(p.enemy);
          o.st = p.enemy.ai?.state;
          o.prev = p.enemy.ai?._prevState;
          o.d = r2(p.enemy.position.distanceTo(g.player.position));
        }
        if (p.type) o.type = p.type;
        if (p.damage !== undefined) o.dmg = p.damage;
        if (n === 'player:hit') o.by = g.enemies.enemies.indexOf(g.enemies.lastHitBy);
        if (p.success !== undefined) o.success = p.success;
        if (n === 'enemy:telegraph' && p.enemy) {
          const e = p.enemy;
          const v = g.player.position.clone().sub(e.position);
          o.alongL = r2(v.dot(e.forward) / e.length);
          o.latL = r2(v.dot(e.right) / e.length);
          o.fromFlank = T.prevStates.get(e)?.s === 'flank';
          o.afterAttack = T.prevStates.get(e)?.s === 'attack' || T.prevStates.get(e)?.s === 'recover';
        }
        T.ev.push(o);
      });
    }
    // Track previous AI state per shark (set on every state change).
    T.prevStates = new Map();
    T.trackStates = () => {
      for (const e of g.enemies.enemies) {
        const s = e.ai?.state;
        const p = T.prevStates.get(e);
        if (p && p.s !== s) {
          e.ai._prevState = p.s;
          T.trans.push({ t: r2(g.time.elapsed), who: g.enemies.enemies.indexOf(e), from: p.s, to: s, d: r2(e.position.distanceTo(g.player.position)), kind: e.ai.kind });
        }
        T.prevStates.set(e, { s });
      }
    };
    T.trans = [];
    const realRender = g.post.render;
    T.run = (sec, hook) => {
      g.post.render = () => g.scene.updateMatrixWorld();
      const n = Math.round(sec * 60);
      let i = 0;
      try {
        for (; i < n; i++) {
          g.frame();
          T.trackStates();
          if (hook && hook(i)) break;
        }
      } finally {
        g.post.render = realRender;
      }
      return i;
    };
    T.reset = (wave, god = true) => {
      g.combat?.qte?.end?.(false);
      g.debug.god = god;
      g.player.reset();
      g.cameraRig.lockTarget = null;
      g.director.beginWave(wave, { immediate: true });
      for (const a of ['forward', 'back', 'left', 'right', 'dodge', 'heavy', 'attack', 'parry', 'up', 'down']) g.input.simulate(a, false);
      T.ev.length = 0;
      T.trans.length = 0;
      T.prevStates.clear();
      T.t0 = g.time.elapsed;
    };
    T.keepLock = () => {
      if (!g.cameraRig.lockTarget || !g.cameraRig.lockTarget.alive) {
        const a = g.enemies.getAlive();
        if (a.length) {
          const p = g.player.position;
          const e = a[0];
          g.cameraRig.yaw = Math.atan2(-(e.position.x - p.x), -(e.position.z - p.z));
          g.cameraRig.toggleLock();
        }
      }
    };
    T.closest = (e, from) => {
      let best = 1e9;
      for (const hb of e.hurtboxes) {
        const d = hb.center.distanceTo(from) - hb.radius;
        if (d < best) best = d;
      }
      return best;
    };
    // Per attack-volume minimum gap to the player hurtbox.
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
    T.median = (a) => {
      if (!a.length) return null;
      const s = a.slice().sort((x, y) => x - y);
      return s[(s.length / 2) | 0];
    };
    // Chase bot (the natural "lock on and go for it" player), god mode.
    T.chaseTick = (C) => {
      const P = g.player;
      const I = g.input;
      const tap = (a) => {
        I.simulate(a, true);
        I.simulate(a, false);
      };
      C.lockCd--;
      if ((!g.cameraRig.lockTarget || !g.cameraRig.lockTarget.alive) && C.lockCd <= 0 && g.enemies.getAlive().length) {
        tap('lock');
        C.lockCd = 20;
      }
      const t = g.cameraRig.lockTarget?.alive ? g.cameraRig.lockTarget : g.enemies.getNearest(P.position, 500);
      if (!t) return;
      const d = T.closest(t, P.hurtbox.center);
      C.distHist[d < 1 ? 0 : d < 2 ? 1 : d < 4 ? 2 : d < 8 ? 3 : d < 16 ? 4 : 5]++;
      C.states[t.ai.state] = (C.states[t.ai.state] || 0) + 1;
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
    };
  });

  // ------------------------------------------------------------------ enemies-1: chase bot per species
  for (const wave of [0, 2, 1]) {
    const r = await ev((wave) => {
      const g = window.__game;
      const T = window.__T;
      T.reset(wave, true);
      const C = { lockCd: 0, atkCd: 0, cyc: 0, heavyHold: 0, distHist: [0, 0, 0, 0, 0, 0], states: {} };
      let killedAt = null;
      T.run(120, () => {
        if (g.state === 'playing') T.chaseTick(C);
        if (killedAt === null && g.enemies.getAlive().length === 0) killedAt = T.r2(g.time.elapsed - T.t0);
        return killedAt !== null;
      });
      for (const a of ['forward', 'dodge', 'heavy']) g.input.simulate(a, false);
      const dur = g.time.elapsed - T.t0;
      const firstApproach = T.trans.find((x) => x.to === 'approach');
      const tele = T.ev.filter((x) => x.ev === 'enemy:telegraph');
      const biteTele = tele.filter((x) => x.type === 'bite');
      const hits = T.ev.filter((x) => x.ev === 'enemy:hit');
      return {
        wave, dur: T.r2(dur), killedAt, hp: g.enemies.enemies.map((e) => Math.round(e.health) + '/' + e.maxHealth),
        firstApproach: firstApproach ? T.r2(firstApproach.t - T.t0) : null,
        firstBiteTele: biteTele[0] ? T.r2(biteTele[0].t - T.t0) : null,
        biteTeleAfterApproach: firstApproach && biteTele[0] ? T.r2(biteTele[0].t - firstApproach.t) : null,
        hits: hits.length, hitsPer10s: T.r2((hits.length / dur) * 10),
        tele: tele.reduce((m, x) => ((m[x.type] = (m[x.type] || 0) + 1), m), {}),
        biteTelePer25s: T.r2((biteTele.length / dur) * 25),
        attacks: T.ev.filter((x) => x.ev === 'enemy:attack').length,
        distHist: C.distHist, states: C.states,
        driveBys: T.trans.filter((x) => x.from === 'approach' && x.to === 'approach').length,
      };
    }, wave);
    out(`chase-wave${wave}`, r);
  }

  // ------------------------------------------------------------------ enemies-10: GW opening (5 idle runs, god)
  {
    const runs = [];
    for (let k = 0; k < 5; k++) {
      runs.push(await ev(() => {
        const g = window.__game;
        const T = window.__T;
        T.reset(0, true);
        T.run(45, () => {
          const fc = T.trans.find((x) => x.to === 'approach');
          return !!fc && T.ev.some((z) => z.ev === 'enemy:attack' && z.t >= fc.t);
        });
        const firstCommit = T.trans.find((x) => x.to === 'approach');
        const firstAtk = firstCommit ? T.ev.find((x) => x.ev === 'enemy:attack' && x.t >= firstCommit.t) : null;
        const feintsBefore = T.trans.filter((x) => x.to === 'feint' && (!firstCommit || x.t < firstCommit.t)).length;
        return { commitAt: firstCommit ? T.r2(firstCommit.t - T.t0) : null, kind: firstCommit?.kind, attackAt: firstAtk ? T.r2(firstAtk.t - T.t0) : null, attackKind: firstAtk?.type, feintsBefore };
      }));
    }
    out('gw-opening', runs);
  }

  // ------------------------------------------------------------------ enemies-4: danger (wave 1, idle, god, 60 s)
  {
    const r = await ev(() => {
      const g = window.__game;
      const T = window.__T;
      T.reset(0, true);
      const S = [];
      T.run(60, () => {
        const e = g.enemies.enemies[0];
        S.push({ t: g.time.elapsed, dg: g.danger, st: e.ai.state, d: e.position.distanceTo(g.player.position) });
      });
      // windows: telegraph start → attack end + 0.6 s
      const win = [];
      let open = null;
      for (const s of S) {
        if (s.st === 'telegraph' && open === null) open = s.t;
        if (open !== null && s.st !== 'telegraph' && s.st !== 'attack' && s.st !== 'grab') {
          win.push([open, s.t + 0.6]);
          open = null;
        }
      }
      if (open !== null) win.push([open, 1e9]);
      const hi = S.filter((s) => s.dg >= 0.9);
      const inWin = hi.filter((s) => win.some(([a, b]) => s.t >= a && s.t <= b));
      const circ = S.filter((s) => s.st === 'circle' && s.d >= 12 && s.d <= 20);
      const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
      // vignette proxy: danger at telegraph end vs circling mean
      const teleEnd = [];
      for (let i = 1; i < S.length; i++) if (S[i - 1].st === 'telegraph' && S[i].st !== 'telegraph') teleEnd.push(S[i - 1].dg);
      return {
        samples: S.length, hiSamples: hi.length, hiInWindow: hi.length ? T.r2(inWin.length / hi.length) : null,
        windows: win.length, meanCircle12to20: T.r2(mean(circ.map((s) => s.dg))), circleSamples: circ.length,
        meanAll: T.r2(mean(S.map((s) => s.dg))), dangerAtTeleEnd: teleEnd.map(T.r2),
        frac06: T.r2(S.filter((s) => s.dg > 0.6).length / S.length),
      };
    });
    out('danger-wave0', r);
  }

  // ------------------------------------------------------------------ GW idle death (god off)
  {
    const r = await ev(() => {
      const g = window.__game;
      const T = window.__T;
      T.reset(0, false);
      T.run(120, () => !g.player.alive);
      return { deathAt: g.player.alive ? null : T.r2(g.time.elapsed - T.t0), hp: g.player.health, hits: T.ev.filter((x) => x.ev === 'player:hit').length, tele: T.ev.filter((x) => x.ev === 'enemy:telegraph').map((x) => x.type + '@' + T.r2(x.t - T.t0)) };
    });
    out('gw-idle-death', r);
  }

  // ------------------------------------------------------------------ enemies-5: tiger pincer (3 idle runs, god off) + cadence (god on 60 s)
  {
    const runs = [];
    for (let k = 0; k < 3; k++) {
      runs.push(await ev(() => {
        const g = window.__game;
        const T = window.__T;
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
        const dur = g.time.elapsed - T.t0;
        const tele = T.ev.filter((x) => x.ev === 'enemy:telegraph');
        return {
          deathAt: g.player.alive ? null : T.r2(dur), hits: hits.length, stacked, minGapOther: T.r2(minGapOther),
          grabs: T.ev.filter((x) => x.ev === 'grab:start').map((x) => T.r2(x.t - T.t0)),
          tele: tele.map((x) => x.type[0] + (x.fromFlank ? 'F' : '') + '@' + T.r2(x.t - T.t0)).join(' '),
          telePer60: T.r2((tele.length / dur) * 60),
        };
      }));
    }
    out('tiger-idle-death', runs);
    const r = await ev(() => {
      const g = window.__game;
      const T = window.__T;
      T.reset(1, true);
      T.run(60, () => {
        T.keepLock();
      });
      const tele = T.ev.filter((x) => x.ev === 'enemy:telegraph');
      const flank = tele.filter((x) => x.fromFlank);
      const ft = flank.map((x) => {
        // flanker telegraph relative to the leader's attack start
        const lead = T.ev.filter((y) => y.ev === 'enemy:attack' && y.who !== x.who && y.t <= x.t).pop();
        return { at: T.r2(x.t - T.t0), sinceLeaderAttack: lead ? T.r2(x.t - lead.t) : null };
      });
      return { telePer60: tele.length, kinds: tele.reduce((m, x) => ((m[x.type] = (m[x.type] || 0) + 1), m), {}), flankTele: ft, attacks: T.ev.filter((x) => x.ev === 'enemy:attack').length };
    });
    out('tiger-cadence', r);
  }

  // ------------------------------------------------------------------ enemies-2/6: boss presence (god on, idle, locked, 60 s)
  {
    const r = await ev(() => {
      const g = window.__game;
      const T = window.__T;
      T.reset(2, true);
      T.gaps.clear();
      const D = [];
      let above = 0;
      let occ = 0;
      let n = 0;
      let firstPassAbove = null;
      let occMax = 0;
      const occDiag = [];
      T.run(60, () => {
        T.keepLock();
        T.trackGaps();
        const b = g.enemies.getBoss();
        if (!b) return false;
        n++;
        const d = b.position.distanceTo(g.player.position);
        D.push(d);
        if (b.position.y - g.player.position.y > 4) above++;
        if ((g.env._occlusion ?? 0) > 0.2) occ++;
        occMax = Math.max(occMax, g.env._occlusion ?? 0);
        if (firstPassAbove === null && b.ai.state === 'feint' && b.ai.feintPassed) firstPassAbove = T.r2(b.position.y - g.player.position.y);
        if (b.ai.state === 'feint' && n % 10 === 0) {
          const cam = g.camera.position;
          const c = b.position.clone().sub(cam);
          const dist = c.length();
          const ang = Math.acos(Math.max(-1, Math.min(1, c.dot(g.env.sunDirection) / dist))) * 57.3;
          const half = Math.atan((b.length * 0.32) / dist) * 57.3;
          if (occDiag.length < 30 && b.ai.feintPassed) occDiag.push([T.r2(g.time.elapsed - T.t0), b.ai.feintPassed ? 1 : 0, T.r2(dist), T.r2(ang), T.r2(half), T.r2(b.position.y - cam.y), T.r2(g.env._occlusion)]);
        }
        return false;
      });
      const feints = [];
      let fStart = null;
      for (const x of T.trans) {
        if (x.to === 'feint') fStart = x.t;
        else if (x.from === 'feint' && fStart !== null) {
          feints.push(T.r2(x.t - fStart));
          fStart = null;
        }
      }
      const tails = T.ev.filter((x) => x.ev === 'enemy:telegraph' && x.type === 'tail').map((x) => ({ alongL: x.alongL, after: x.afterAttack }));
      return {
        medianDist: T.r2(T.median(D)), above4: T.r2(above / n), occ02: T.r2(occ / n), occMax: T.r2(occMax), occDiag, firstPassAboveM: firstPassAbove,
        feintDurations: feints, attacks: T.ev.filter((x) => x.ev === 'enemy:attack').map((x) => x.type),
        gaps: [...T.gaps.values()].slice(0, 9).map((x) => x.type + ':' + T.r2(x.gap)), tails,
      };
    });
    out('boss-presence', r);
  }

  // ------------------------------------------------------------------ enemies-2: boss idle death, phase 1 and phase 3 (god off)
  for (const phase of [1, 3]) {
    const r = await ev((phase) => {
      const g = window.__game;
      const T = window.__T;
      T.reset(2, false);
      T.gaps.clear();
      const b = g.enemies.getBoss();
      if (phase === 3) {
        b.ai.phase = 3;
        b.health = Math.round(b.maxHealth * 0.2);
        b.ai.decisionTimer = 3;
        b.ai.feints = 0;
      }
      let maxFeint = 0;
      let fStart = null;
      T.run(90, () => {
        T.keepLock();
        T.trackGaps();
        const bb = g.enemies.getBoss();
        if (bb?.ai.state === 'feint') {
          if (fStart === null) fStart = g.time.elapsed;
          maxFeint = Math.max(maxFeint, g.time.elapsed - fStart);
        } else fStart = null;
        return !g.player.alive;
      });
      const gaps = [...T.gaps.values()].slice(0, 7);
      return {
        phase, deathAt: g.player.alive ? null : T.r2(g.time.elapsed - T.t0), hp: g.player.health,
        attacks: T.ev.filter((x) => x.ev === 'enemy:attack').map((x) => x.type + '@' + T.r2(x.t - T.t0)),
        first7Gaps: gaps.map((x) => x.type + ':' + T.r2(x.gap)), within1m: gaps.filter((x) => x.gap <= 1).length,
        hits: T.ev.filter((x) => x.ev === 'player:hit').length, maxFeint: T.r2(maxFeint),
        tails: T.ev.filter((x) => x.ev === 'enemy:telegraph' && x.type === 'tail').map((x) => ({ alongL: x.alongL, fromRecover: x.afterAttack })),
      };
    }, phase);
    out(`boss-idle-death-p${phase}`, r);
  }

  // ------------------------------------------------------------------ shockwave + trauma count
  {
    const r = await ev(() => {
      const g = window.__game;
      const T = window.__T;
      T.reset(2, false);
      const b = g.enemies.getBoss();
      const p = g.player.position;
      b.ai.phase = 2;
      b.placeAt(new T.V3(p.x, p.y, p.z - 10), new T.V3(0, 0, 1));
      b.ai.state = 'approach';
      b.ai.kind = 'shockwave';
      b.ai._startTelegraph('shockwave');
      let trauma = 0;
      const orig = g.cameraRig.addTrauma;
      g.cameraRig.addTrauma = function (a) {
        trauma++;
        return orig.call(this, a);
      };
      let hit = false;
      const off = g.events.on('player:hit', () => (hit = true));
      T.run(3, () => b.ai.state === 'recover');
      off?.();
      g.cameraRig.addTrauma = orig;
      const hits = T.ev.filter((x) => x.ev === 'player:hit');
      return { hit, hits: hits.length, traumaAdds: trauma, note: 'trauma incl. CameraRig enemy:attack + player:hit', shockCenterToPlayer: T.r2(b.ai.shockCenter.distanceTo(p)) };
    });
    out('shockwave', r);
    const r2 = await ev(() => {
      const g = window.__game;
      const T = window.__T;
      T.reset(2, true);
      const b = g.enemies.getBoss();
      const p = g.player.position;
      b.ai.phase = 2;
      b.placeAt(new T.V3(p.x, p.y, p.z - 10), new T.V3(0, 0, 1));
      b.ai.kind = 'shockwave';
      b.ai._startTelegraph('shockwave');
      let trauma = 0;
      const orig = g.cameraRig.addTrauma;
      g.cameraRig.addTrauma = function (a) {
        trauma++;
        return orig.call(this, a);
      };
      T.run(3, () => b.ai.state === 'recover');
      g.cameraRig.addTrauma = orig;
      return { godTraumaAdds: trauma, weakAfter: T.r2(b.ai._weakT), vulnerable: b.vulnerable };
    });
    out('shockwave-god-trauma', r2);
  }

  // ------------------------------------------------------------------ roar: facing, shove, trauma
  {
    const r = await ev(() => {
      const g = window.__game;
      const T = window.__T;
      T.reset(2, true);
      const b = g.enemies.getBoss();
      const p = g.player.position;
      // Player 10 m from the boss centre, 90° off its nose.
      b.placeAt(new T.V3(p.x, p.y, p.z - 10), new T.V3(1, 0, 0));
      b.speed = 4.8;
      T.run(0.05);
      g.player.velocity.set(0, 0, 0);
      let trauma = 0;
      const orig = g.cameraRig.addTrauma;
      g.cameraRig.addTrauma = function (a) {
        trauma++;
        return orig.call(this, a);
      };
      const d0 = b.getMouthPosition().distanceTo(p);
      const f0 = T.r2(b.ai.facing);
      b.ai.pendingRoar = true;
      let vmax = 0;
      let facingAt07 = null;
      T.run(2.4, () => {
        vmax = Math.max(vmax, g.player.velocity.length());
        if (facingAt07 === null && b.ai.state === 'roar' && b.ai.t >= 0.7) facingAt07 = T.r2(b.ai.facing);
        return b.ai.state === 'circle';
      });
      g.cameraRig.addTrauma = orig;
      return { mouthDist0: T.r2(d0), facing0: f0, facingAt07, playerPeakSpeed: T.r2(vmax), traumaAdds: trauma, weakT: T.r2(b.ai._weakT), vulnerable: b.vulnerable };
    });
    out('roar', r);
  }

  // ------------------------------------------------------------------ wake: boss pass at ~4 m (idle player)
  {
    const r = await ev(() => {
      const g = window.__game;
      const T = window.__T;
      T.reset(2, true);
      const b = g.enemies.getBoss();
      const p = g.player.position;
      b.placeAt(new T.V3(p.x - 4.5, p.y, p.z - 30), new T.V3(0, 0, 1));
      b.speed = 7.6;
      b.ai._enter('feint');
      b.ai.feintSide.set(-1, 0, 0);
      b.ai.feintOffset = 4.5;
      b.ai.feintRise = 0;
      b.ai.feintPassed = false;
      b.ai.feintMinD = Infinity;
      b.ai.feintMaxT = 12;
      b.ai.tailCd = 99;
      g.player.velocity.set(0, 0, 0);
      let vmax = 0;
      let dmin = 99;
      const tmp = new T.V3();
      T.run(8, () => {
        dmin = Math.min(dmin, Math.sqrt(b.closestBodyPoint(g.player.position, tmp)));
        vmax = Math.max(vmax, g.player.velocity.length());
        return b.ai.state !== 'feint';
      });
      return { minBodyDist: T.r2(dmin), playerPeakSpeed: T.r2(vmax) };
    });
    out('wake', r);
  }

  // ------------------------------------------------------------------ enemies-3: parry punish (3 tries)
  {
    const tries = [];
    for (let k = 0; k < 3; k++) {
      tries.push(await ev(() => {
        const g = window.__game;
        const T = window.__T;
        T.reset(2, true);
        const b = g.enemies.getBoss();
        const p = g.player.position;
        b.placeAt(new T.V3(p.x, p.y, p.z - 20), new T.V3(0, 0, 1));
        b.speed = 5;
        b.ai.kind = 'bite';
        b.ai._enter('approach');
        b.ai.tailCd = 99;
        b.ai.feints = 0;
        g.cameraRig.lockTarget = b;
        const I = g.input;
        let parried = false;
        let parryTapped = false;
        // wait for the bite, parry when the jaws arrive
        T.run(8, () => {
          for (const v of b.getAttackVolumes()) {
            const gap = v.center.distanceTo(g.player.hurtbox.center) - v.radius - g.player.hurtbox.radius;
            if (!parryTapped && v.type === 'bite' && gap < 1.4) {
              I.simulate('parry', true);
              I.simulate('parry', false);
              parryTapped = true;
            }
          }
          if (b.ai.state === 'stagger') parried = true;
          return parried;
        });
        if (!parried) return { parried: false, st: b.ai.state, kind: b.ai.kind };
        const head0 = b.getMouthPosition().clone();
        let headMax = 0;
        let hits = 0;
        const C = { lockCd: 99, atkCd: 0, cyc: 0, heavyHold: 0, distHist: [0, 0, 0, 0, 0, 0], states: {} };
        const off = g.events.on('enemy:hit', (e) => {
          if (e.enemy === b && b.ai.state === 'stagger') hits++;
        });
        T.run(4, () => {
          if (b.ai.state !== 'stagger') return true;
          headMax = Math.max(headMax, b.getMouthPosition().distanceTo(head0));
          T.chaseTick(C);
          return false;
        });
        off?.();
        for (const a of ['forward', 'dodge', 'heavy']) I.simulate(a, false);
        return { parried, staggerHits: hits, headMoved: T.r2(headMax), staggerTime: b.ai.cfg.staggerTime };
      }));
    }
    out('boss-parry-punish', tries);
  }

  // ------------------------------------------------------------------ module regression: existing AI scenario
  const ai = await import(new URL('./enemies-ai-scenario.mjs', import.meta.url).href);
  await ai.default(page, { ...ctx, shot: async () => {} });
}
