// Player parry / guard balance checks for scripts/smoke.mjs — real sharks, god off where it
// matters, no rendering between checks (fast). Needs --step and ?autostart&fixeddt&god:
//
//   ~/.claude/bin/heavy-gate -n 1 -l player -- node scripts/smoke.mjs --dist --step \
//       --params 'autostart&fixeddt&god&quality=high' --wait 300 --shots 0 \
//       --scenario scripts/player-parry-scenario.mjs --out .smoke/player-parry
//
// Logs one `### <check> {json}` line per check:
//   guard      idle 老公 vs a circling great white: mean guard per (AI state, distance band) —
//              within 15 m he should hold the knife-ready guard (guardHi ≈ 1)
//   cue        parry on the enemy:strike cue (bite, ram) and at the telegraph end, each from a
//              fresh wave: every trial that had a cue should parry. Then a panicked press
//              0.6 / 0.45 / 0.3 / 0.15 s before the telegraph ends (it whiffs) followed by a
//              press on the cue — neither the cooldown nor the whiff recovery may swallow
//              the second press (a lone miss is retried, Player PARRY_RETRY; ≥ 2/3 should
//              parry) — and a whiff at the telegraph start (≈0.8 s early) followed by the
//              on-cue press. Per trial: `pre` = when the early press went in, `cue` =
//              enemy:strike time (both relative to the telegraph end), `presses` = parries
//              started (2 = the on-cue press was accepted), `f` / `cd` = fatigue / cooldown
//              left at that press, `win` = the last parry's window (shortened by fatigue)
//   whiff      one isolated whiff: stamina cost, regen pause, recovery lock, fatigue; a press
//              inside that first whiff's recovery is a retry (a new parry at once); once the
//              retry whiffs too (fatigue ≈ 2) a press inside the recovery is dropped;
//              attack / dodge cancel it
//   cancel     parry pressed on the strike cue while charging a heavy, in a light wind-up and
//              in a heavy wind-up (great white bite, god off): each should parry (3/3)
//   riposte    great white ×3 and megalodon ×3: parry on the cue → light attack 0.2 s later is
//              a riposte that lands on a vital
//   heavyRiposte  great white / tiger / megalodon: parry on the cue → heavy pressed 0.1 s later,
//              released at 0.6 s (charge level 1) is a homing riposte (`heavy(R)`) that lands
//   spam       parry pressed every 0.4 s (mashing out of grabs, never attacking) vs an idle
//              player, per wave and seed (same seeded Math.random for both): mean death time
//              ratio spam / idle should stay ≲ 1.3; `spamNoFatigue` is the control with the
//              fatigue switched off (which also leaves every whiff retryable, so it skips the
//              cooldown as well: ≈2–3×). With 4 seeds one outlier run moves a mean by ±0.3 (tigers:
//              1.46 with a 1.9× seed); scripts/core-parry-spam.mjs (16 seeds, medians) is the
//              balance reference
// Env: PARRY_CD=<s>[,<s>…] overrides PLAYER.parryCooldown (from the press) to try other
// values — the first one for every check, and the cue check's early-press sets run once per
// listed value; SEEDS=<n> seeds per wave (default 4); SKIP=<comma list> of checks to leave out.
export default async (page, { evaluate, log }) => {
  const ev = (js) => evaluate(js);
  const out = (k, v) => log(`### ${k} ${JSON.stringify(v)}`);
  const skip = new Set((process.env.SKIP || '').split(',').filter(Boolean));
  const cds = process.env.PARRY_CD ? process.env.PARRY_CD.split(',').map(Number) : [null];
  const cd = cds[0];
  const seeds = Math.max(1, +(process.env.SEEDS || 4));
  const check = async (name, fn) => {
    if (skip.has(name)) return;
    try {
      await fn();
    } catch (e) {
      log(`### ${name} THREW ${String(e?.stack || e).slice(0, 800)}`);
    }
  };

  await ev(`(() => {
    const g = __game, P = g.player;
    g.renderer.setAnimationLoop(null);
    const T = (window.__T = { evs: [], tele: null, kind: 'bite', strikes: [], cd: ${cd}, noFatigue: false });
    const r3 = (v) => +(+v).toFixed(3);
    for (const n of ['enemy:telegraph', 'enemy:attack', 'enemy:strike', 'player:parry', 'player:hit', 'grab:start', 'enemy:hit', 'player:attack']) {
      g.events.on(n, (p = {}) => {
        const e = { n, t: r3(g.time.elapsed) };
        if (p.type) e.type = p.type;
        if (p.success) e.success = true;
        if (p.attempt) e.attempt = true;
        if (p.whiff) e.whiff = true;
        if (p.riposte) e.riposte = true;
        if (p.damage !== undefined) e.dmg = p.damage;
        if (p.part) e.part = p.part;
        T.evs.push(e);
        if (n === 'enemy:telegraph') T.tele = { t: g.time.elapsed, dur: p.duration, type: p.type, enemy: p.enemy };
        if (n === 'enemy:strike') T.strikes.push({ t: g.time.elapsed, type: p.type, eta: p.eta });
      });
    }
    // T.cd: cooldown override (null = PLAYER.parryCooldown); T.noFatigue: every parry gets
    // the full window (the control for the spam fatigue)
    const tryParry = P._tryParry;
    P._tryParry = function () {
      if (T.noFatigue) P._parryFatigue = 0;
      const ok = tryParry.call(P);
      if (ok) {
        if (T.cd != null) P._parryCooldown = T.cd;
        T.lastWin = P._parryWin;
      }
      return ok;
    };
    T.seed = (s) => {
      let a = s >>> 0;
      Math.random = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    };
    T.shark = () => g.enemies.enemies.find((e) => e.alive) ?? g.enemies.enemies[0];
    T.dist = (e) => Math.min(e.position.distanceTo(P.position), e.getMouthPosition().distanceTo(P.position));
    T.frames = (n, pred, hook) => {
      const r = g.post.render; g.post.render = () => g.scene.updateMatrixWorld();
      let i = 0;
      try { for (; i < n; i++) { hook?.(i); g.frame(); if (pred?.()) { i++; break; } } } finally { g.post.render = r; }
      return i;
    };
    T.tap = (a) => { g.input.simulate(a, true); g.input.simulate(a, false); };
    T.release = () => { for (const a of ['forward', 'back', 'left', 'right', 'dodge', 'heavy', 'attack', 'parry', 'up', 'down']) g.input.simulate(a, false); };
    T.resetWave = (wave, god) => {
      g.combat?.qte?.end?.(false, 'test');
      g.debug.god = god;
      P.reset();
      g.cameraRig.lockTarget = null;
      g.director.beginWave(wave, { immediate: true });
      T.release();
    };
    // Steer the shark into an attack of kind T.kind soon (approach, telegraph, lunge, combat
    // and grab stay real): no feints, no tail swipes, a short decision timer.
    T.nudge = () => {
      const s = T.shark(); if (!s?.alive) return;
      const ai = s.ai;
      ai._chooseAttack = () => T.kind;
      ai.feints = 0; ai._firstDecisionDone = true; ai._firstCommitDone = true;
      if (ai.state === 'circle') ai.decisionTimer = Math.min(ai.decisionTimer, 0.2);
      ai.tailCd = 99;
    };
    // One attack of kind T.kind. opts.offset: press parry at telegraph end + offset;
    // opts.strikeDelay: press this long after enemy:strike; opts.pre: an earlier extra press.
    T.trial = (opts = {}) => {
      const s = T.shark();
      T.tele = null;
      const res = { ...opts };
      const n0 = T.evs.length;
      T.frames(60 * 40, () => T.tele && T.tele.type === T.kind && T.tele.enemy === s, () => T.nudge());
      if (!T.tele) return { ...res, err: 'no telegraph' };
      const teleEnd = T.tele.t + T.tele.dur;
      res.mouthDist = +s.getMouthPosition().distanceTo(P.position).toFixed(1);
      let end = null, pressed = false, pre = false, strikeAt = null;
      const s0 = T.strikes.length;
      T.frames(60 * 4, () => {
        if (strikeAt === null && T.strikes.length > s0) strikeAt = T.strikes[s0].t - teleEnd;
        if (g.combat.grab) { end = 'grab'; return true; }
        const evs = T.evs.slice(n0);
        if (evs.some((e) => e.n === 'player:parry' && e.success)) { end = 'parry'; return true; }
        if (evs.some((e) => e.n === 'player:hit')) end = 'hit';
        if (['recover', 'stagger', 'circle'].includes(s.ai.state)) { end = end || 'shark:' + s.ai.state; return true; }
        return false;
      }, () => {
        const t = g.time.elapsed - teleEnd;
        // (a pre earlier than the telegraph start goes in on its first frame)
        if (opts.pre !== undefined && !pre && t >= opts.pre - 1 / 120) { T.tap('parry'); pre = true; res.pre = r3(t); }
        if (pressed) return;
        let go = false;
        if (opts.offset !== undefined) go = t >= opts.offset - 1 / 120;
        if (opts.strikeDelay !== undefined && strikeAt !== null) go = t >= strikeAt + opts.strikeDelay - 1 / 120;
        if (go) { T.tap('parry'); pressed = true; res.pressedAt = r3(t); res.f = r3(P._parryFatigue); res.cd = r3(P._parryCooldown); }
      });
      res.cue = strikeAt === null ? null : r3(strikeAt);
      res.presses = T.evs.slice(n0).filter((e) => e.n === 'player:parry' && e.attempt).length;
      res.end = end;
      res.win = r3(T.lastWin ?? 0);
      res.ok = end === 'parry';
      return res;
    };
    T.mash = (every, max = 60 * 6) => {
      let acc = 0;
      return T.frames(max, () => !g.combat.grab, () => { if (++acc >= every) { acc = 0; T.tap('attack'); } });
    };
  })()`);
  await ev(`__T.frames(30)`);

  await check('guard', async () => {
    out('guard', await ev(`(() => {
      const g = __game, T = __T, P = g.player;
      T.seed(7);
      T.resetWave(0, true);
      const B = {};
      T.frames(60 * 50, null, (i) => {
        const s = T.shark(); if (i < 60 || !s?.alive) return;
        const d = T.dist(s);
        const k = s.ai.state + ' ' + (d < 10 ? '<10' : d < 15 ? '10-15' : d < 20 ? '15-20' : '>20');
        const b = (B[k] ??= { n: 0, guard: 0, hi: 0, danger: 0 });
        b.n++; b.guard += P._guard; b.danger += g.danger; if (P._guard > 0.8) b.hi++;
      });
      const o = {};
      for (const [k, b] of Object.entries(B)) o[k] = { n: b.n, guard: +(b.guard / b.n).toFixed(2), guardHi: +(b.hi / b.n).toFixed(2), danger: +(b.danger / b.n).toFixed(2) };
      return o;
    })()`));
  });

  await check('cue', async () => {
    const set = async (name, kind, opts, n) => {
      const rs = [];
      for (let i = 0; i < n; i++) {
        rs.push(await ev(`(() => {
          const T = __T, P = __game.player;
          T.seed(${300 + i}); T.resetWave(0, false); T.kind = '${kind}';
          return T.trial(${JSON.stringify(opts)});
        })()`));
      }
      const cued = rs.filter((r) => r.cue !== null);
      out(`cue ${name}`, { ok: `${rs.filter((r) => r.ok).length}/${rs.length}`, okWithCue: `${cued.filter((r) => r.ok).length}/${cued.length}`, rs });
    };
    await set('bite on strike', 'bite', { strikeDelay: 0 }, 4);
    await set('bite at telegraph end', 'bite', { offset: 0 }, 4);
    await set('ram on strike', 'ram', { strikeDelay: 0 }, 3);
    for (const c of cds) {
      await ev(`__T.cd = ${c}`);
      const tag = c === null ? '' : ` [cooldown ${c}]`;
      await set(`bite: panic press 0.6 s early, then on strike${tag}`, 'bite', { pre: -0.6, strikeDelay: 0 }, 6);
      await set(`ram: panic press 0.6 s early, then on strike${tag}`, 'ram', { pre: -0.6, strikeDelay: 0 }, 3);
      await set(`bite: whiff at telegraph start, then on strike${tag}`, 'bite', { pre: -5, strikeDelay: 0 }, 3);
      // the old dead zone: the window closes before the jaws arrive and the on-cue press
      // falls into the whiff recovery / cooldown
      for (const pre of [0.45, 0.3, 0.15]) {
        await set(`bite: panic press ${pre} s early, then on strike${tag}`, 'bite', { pre: -pre, strikeDelay: 0 }, 3);
      }
    }
    await ev(`__T.cd = ${cd}`);
  });

  await check('whiff', async () => {
    out('whiff', await ev(`(() => {
      const g = __game, T = __T, P = g.player;
      T.resetWave(0, true);
      T.frames(60);
      P.stamina = 100;
      const n0 = T.evs.length;
      T.tap('parry');
      const trace = [];
      T.frames(42, null, (i) => { if (i % 6 === 0) trace.push({ f: i, state: P.state, parrying: P.isParrying(), st: +P.stamina.toFixed(1), lock: +P._parryLock.toFixed(2), fatigue: +P._parryFatigue.toFixed(2) }); });
      const evs = T.evs.slice(n0).map((e) => e.n + (e.whiff ? '(whiff)' : e.attempt ? '(attempt)' : ''));
      const inRecovery = () => P.state === 'parry' && P._parryWhiffed && P._parryLock > 0.05;
      const pressNow = () => {
        const a0 = T.evs.filter((e) => e.attempt).length;
        const f = +P._parryFatigue.toFixed(2);
        T.tap('parry'); T.frames(2);
        const fresh = T.evs.filter((e) => e.attempt).length > a0;
        return { f, state: P.state, newParry: fresh, parryT: +P._parryT.toFixed(3) };
      };
      // a press inside a lone (unfatigued) whiff's recovery is a retry: a new parry at once
      T.frames(150); T.tap('parry'); T.frames(40, inRecovery);
      const retryInFirstRecovery = pressNow();
      // the retry whiffs too (fatigue ≈ 2): a press inside this recovery is dropped even
      // with no cooldown left
      T.frames(40, inRecovery);
      P._parryCooldown = 0;
      const pressInFatiguedRecovery = pressNow();
      T.frames(120); T.tap('parry'); T.frames(20); T.tap('attack'); T.frames(1);
      const attackInRecovery = P.state;
      T.frames(120); T.tap('parry'); T.frames(20); T.tap('dodge'); T.frames(1);
      const dodgeInRecovery = P.state;
      T.frames(60);
      return { trace, evs, retryInFirstRecovery, pressInFatiguedRecovery, attackInRecovery, dodgeInRecovery };
    })()`));
  });

  await check('cancel', async () => {
    // Parry on the strike cue out of a heavy charge / a light or heavy wind-up. `at` is the
    // player's state (and attack phase) when parry was pressed.
    const res = {};
    for (const how of ['charge', 'lightWindup', 'heavyWindup']) {
      const rs = [];
      for (let i = 0; i < 3; i++) {
        rs.push(await ev(`(() => {
          const g = __game, T = __T, P = g.player;
          T.seed(${500 + i}); T.resetWave(0, false); T.kind = 'bite';
          const s = T.shark();
          g.cameraRig.lockTarget = s;
          T.tele = null;
          T.frames(60 * 40, () => T.tele && T.tele.type === 'bite' && T.tele.enemy === s, () => T.nudge());
          if (!T.tele) return { err: 'no telegraph' };
          const teleEnd = T.tele.t + T.tele.dur;
          const n0 = T.evs.length, s0 = T.strikes.length;
          let cueF = -1, k = 0, at = null, holding = false, end = null;
          T.frames(60 * 4, () => {
            const evs = T.evs.slice(n0);
            if (evs.some((e) => e.n === 'player:parry' && e.success)) { end = 'parry'; return true; }
            if (g.combat.grab) { end = 'grab'; return true; }
            if (evs.some((e) => e.n === 'player:hit')) { end = 'hit'; return true; }
            if (['recover', 'circle'].includes(s.ai.state)) { end = 'shark:' + s.ai.state; return true; }
            return false;
          }, () => {
            const t = g.time.elapsed - teleEnd;
            const how = '${how}';
            if (!holding && ((how === 'charge' && t >= -0.5) || (how === 'heavyWindup' && t >= -0.7))) { g.input.simulate('heavy', true); holding = true; }
            if (cueF < 0 && T.strikes.length > s0) cueF = k;
            if (cueF >= 0) {
              const d = k - cueF;
              if (how === 'charge' && d === 0) { at = P.state; T.tap('parry'); }
              if (how === 'lightWindup') { if (d === 0) T.tap('attack'); if (d === 2) { at = P.state + '/' + P._phaseName; T.tap('parry'); } }
              if (how === 'heavyWindup') { if (d === 0) g.input.simulate('heavy', false); if (d === 2) { at = P.state + '/' + P._phaseName; T.tap('parry'); } }
            }
            k++;
          });
          T.release();
          return { at, end, ok: end === 'parry' };
        })()`));
      }
      res[how] = { ok: `${rs.filter((r) => r.ok).length}/${rs.length}`, rs };
    }
    out('cancel', res);
  });

  await check('riposte', async () => {
    const res = [];
    for (let k = 0; k < 3; k++) {
      res.push(await ev(`(() => {
        const g = __game, T = __T, P = g.player;
        T.seed(${400 + k}); T.resetWave(0, true); T.kind = 'bite';
        g.cameraRig.lockTarget = T.shark();
        const r = T.trial({ strikeDelay: 0 });
        if (!r.ok) return { parried: false, end: r.end };
        const n0 = T.evs.length;
        T.frames(11); T.tap('attack'); T.frames(60);
        const evs = T.evs.slice(n0);
        return { parried: true, swing: evs.filter((e) => e.n === 'player:attack').map((a) => a.type + (a.riposte ? '(R)' : '')), hits: evs.filter((e) => e.n === 'enemy:hit').map((h) => h.part + ':' + h.dmg) };
      })()`));
    }
    for (let k = 0; k < 3; k++) {
      res.push(await ev(`(() => {
        const g = __game, T = __T, P = g.player;
        T.resetWave(2, true);
        const b = g.enemies.getBoss();
        const p = P.position, V3 = p.constructor;
        b.placeAt(new V3(p.x, p.y, p.z - 20), new V3(0, 0, 1));
        b.speed = 5; b.ai.kind = 'bite'; b.ai._enter('approach'); b.ai.tailCd = 99; b.ai.feints = 0;
        b.ai._chooseAttack = () => 'bite';
        g.cameraRig.lockTarget = b;
        const s0 = T.strikes.length; let pressed = false;
        T.frames(60 * 10, () => b.ai.state === 'stagger' || !!g.combat.grab || b.ai.state === 'recover', () => {
          if (!pressed && T.strikes.length > s0) { T.tap('parry'); pressed = true; }
        });
        if (b.ai.state !== 'stagger') return { boss: true, parried: false, st: b.ai.state };
        const n0 = T.evs.length;
        T.frames(12); T.tap('attack'); T.frames(54);
        const evs = T.evs.slice(n0);
        T.release();
        return { boss: true, parried: true, swing: evs.filter((e) => e.n === 'player:attack').map((a) => a.type + (a.riposte ? '(R)' : '')), hits: evs.filter((e) => e.n === 'enemy:hit').map((h) => h.part + ':' + h.dmg) };
      })()`));
    }
    out('riposte', res);
  });

  await check('heavyRiposte', async () => {
    // parry on the cue (god on), heavy pressed 0.1 s later and released at 0.6 s (charge
    // level 1); counts knife hits on the parried shark while it staggers
    const res = {};
    for (const [wave, name] of [[0, 'greatWhite'], [1, 'tiger'], [2, 'megalodon']]) {
      const rs = [];
      for (let k = 0; k < 3; k++) {
        rs.push(await ev(`(() => {
          const g = __game, T = __T, P = g.player;
          T.seed(${600 + 10 * wave + k}); T.resetWave(${wave}, true); T.kind = 'bite';
          // tigers: park the second one so only the parried shark is around
          const es = g.enemies.enemies, V3 = P.position.constructor;
          for (let i = 1; i < es.length; i++) { es[i].placeAt(new V3(P.position.x + 60, P.position.y, P.position.z + 60), new V3(1, 0, 0)); es[i].freeze = true; }
          const s = es[0];
          g.cameraRig.lockTarget = s;
          const r = T.trial({ strikeDelay: 0 });
          if (!r.ok) return { parried: false, end: r.end };
          const n0 = T.evs.length;
          let f = 0;
          T.frames(60 * 3, () => s.ai.state !== 'stagger', () => {
            if (f === 6) g.input.simulate('heavy', true);
            if (f === 36) g.input.simulate('heavy', false);
            f++;
          });
          T.release();
          const evs = T.evs.slice(n0);
          return { parried: true, swing: evs.filter((e) => e.n === 'player:attack').map((a) => a.type + (a.riposte ? '(R)' : '')),
            hits: evs.filter((e) => e.n === 'enemy:hit').map((h) => h.part + ':' + h.dmg) };
        })()`));
      }
      const landed = rs.filter((r) => r.hits?.length).length;
      res[name] = { landed: `${landed}/${rs.filter((r) => r.parried).length}`, rs };
    }
    out('heavyRiposte', res);
  });

  await check('spam', async () => {
    const SEC = 140;
    const all = {};
    for (const wave of [0, 1, 2]) {
      for (let s = 0; s < seeds; s++) {
        for (const [name, every, noFatigue] of [['idle', 0, false], ['spam', 24, false], ['spamNoFatigue', 24, true]]) {
          const r = await ev(`(() => {
            const g = __game, T = __T, P = g.player;
            T.noFatigue = ${noFatigue};
            T.seed(${101 * (s + 1)});
            T.resetWave(${wave}, false);
            const n0 = T.evs.length; const t0 = g.time.elapsed; let k = 0, m = 0, deathAt = null;
            T.frames(60 * ${SEC}, () => { if (!P.alive) { deathAt = +(g.time.elapsed - t0).toFixed(1); return true; } return false; }, () => {
              if (g.combat.grab) { if (++m % 4 === 0) T.tap('attack'); return; }
              if (${every} > 0 && ++k % ${every} === 0) T.tap('parry');
            });
            T.noFatigue = false;
            const evs = T.evs.slice(n0);
            return { deathAt, parries: evs.filter((e) => e.n === 'player:parry' && e.success).length, whiffs: evs.filter((e) => e.whiff).length,
              attacks: evs.filter((e) => e.n === 'enemy:attack').length, hits: evs.filter((e) => e.n === 'player:hit').length };
          })()`);
          log(`spam w${wave} seed${s} ${name} ${JSON.stringify(r)}`);
          ((all[`w${wave}`] ??= {})[name] ??= []).push(r.deathAt ?? SEC);
        }
      }
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const ratio = {};
    for (const [w, v] of Object.entries(all)) {
      const idle = mean(v.idle);
      ratio[w] = { idleDeath: +idle.toFixed(1), spam: +(mean(v.spam) / idle).toFixed(2), spamNoFatigue: +(mean(v.spamNoFatigue) / idle).toFixed(2) };
    }
    out('spam deathAt (cap ' + SEC + ' s)', all);
    out('spam / idle death time', ratio);
  });

  log('### moduleErrors ' + JSON.stringify(await ev(`[...__game._moduleErrors]`)));
};
