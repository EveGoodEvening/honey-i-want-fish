// Close-range strike fairness in the real game (scripts/smoke.mjs scenario; the
// browserless twin is `node scripts/enemies-sim.mjs strike-close strike-natural`).
// Needs --step and ?autostart&fixeddt&god:
//
//   ~/.claude/bin/heavy-gate -n 1 -l strike -- node scripts/smoke.mjs --dist --step \
//       --params 'autostart&fixeddt&god&quality=low' --wait 300 --shots 0 \
//       --scenario scripts/enemies-strike-scenario.mjs --out .smoke/strike
//
// Per species (great white, tiger, megalodon) one bite per placed start: the jaws
// 2–4 m from 老公, heading straight at him or 40° off, 老公 idle or swimming at the
// jaws (god on). Every bite / ram telegraph is checked: no contact (Combat resolving
// the volume: hit or parry) before the announced telegraph has run out, and an
// enemy:strike cue ≥ 0.22 s (SharkAI STRIKE_LEAD) before the contact. Then `parry` trials: god off, parry
// pressed 0.1 s after the cue — every one should parry (no grab).
// Logs `### strike <species> {summary}`, `### parry <species> {…}`, `### moduleErrors`.
export default async (page, { evaluate, log }) => {
  const ev = (js) => evaluate(js);
  const out = (k, v) => log(`### ${k} ${JSON.stringify(v)}`);

  await ev(`(() => {
    const g = __game, P = g.player, V3 = P.position.constructor;
    g.renderer.setAnimationLoop(null);
    const S = (window.__S = { teles: [], cues: [], contacts: [], V3 });
    const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
    S.r2 = r2;
    const led = g.combat._hitLedger;
    const add = led.add.bind(led);
    led.add = (enemy, id) => {
      const vol = enemy.getAttackVolumes().find((v) => v.id === id);
      if (vol && (vol.type === 'bite' || vol.type === 'ram')) S.contacts.push({ t: g.time.elapsed, enemy, id, parried: false });
      add(enemy, id);
    };
    const parry = g.combat._parry.bind(g.combat);
    g.combat._parry = (player, enemy, vol) => {
      const c = S.contacts[S.contacts.length - 1];
      if (c && c.enemy === enemy && c.id === vol.id) c.parried = true;
      parry(player, enemy, vol);
    };
    g.events.on('enemy:telegraph', ({ enemy, type, duration }) => {
      if (type === 'bite' || type === 'ram') S.teles.push({ t: g.time.elapsed, enemy, type, dur: duration });
    });
    g.events.on('enemy:strike', ({ enemy, type, eta }) => S.cues.push({ t: g.time.elapsed, enemy, type, eta }));
    S.clear = () => { S.teles.length = 0; S.cues.length = 0; S.contacts.length = 0; };
    S.rows = () => S.teles.map((te, i) => {
      const next = S.teles.slice(i + 1).find((x) => x.enemy === te.enemy);
      const until = next ? next.t : Infinity;
      const end = te.t + te.dur;
      const c = S.contacts.find((x) => x.enemy === te.enemy && x.t >= te.t && x.t < until);
      const cue = S.cues.find((x) => x.enemy === te.enemy && x.t >= te.t && x.t < until);
      return { type: te.type, contact: c ? c.t - end : null, parried: !!c?.parried, cue: cue ? cue.t - end : null,
        lead: c && cue && cue.t <= c.t ? c.t - cue.t : null };
    });
    S.seed = (s) => {
      let a = s >>> 0;
      Math.random = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    };
    S.frames = (n, pred) => {
      const r = g.post.render; g.post.render = () => g.scene.updateMatrixWorld();
      let i = 0;
      try { for (; i < n; i++) { g.frame(); if (pred?.(i)) { i++; break; } } } finally { g.post.render = r; }
      return i;
    };
    S.release = () => { for (const a of ['forward', 'back', 'left', 'right', 'dodge', 'heavy', 'attack', 'parry', 'up', 'down']) g.input.simulate(a, false); };
    // One placed close-range bite. opts: { wave, D, yaw, swimIn, god, parryAfter }
    S.trial = ({ wave, D, yaw, swimIn = false, god = true, parryAfter = null }) => {
      g.combat?.qte?.end?.(false, 'test');
      g.debug.god = god;
      P.reset();
      g.cameraRig.lockTarget = null;
      g.director.beginWave(wave, { immediate: true });
      S.release();
      S.frames(2);
      S.clear();
      const mgr = g.enemies;
      const [sh, ...rest] = mgr.enemies;
      for (const o of rest) { o.freeze = true; o.placeAt(new V3(P.position.x + 60, P.position.y, P.position.z + 60), new V3(1, 0, 0)); }
      const fwd = new V3(0, 0, 1).applyAxisAngle(new V3(0, 1, 0), (yaw * Math.PI) / 180);
      const pos = P.hurtbox.center.clone();
      sh.placeAt(pos, fwd);
      const off = sh.getMouthPosition().clone().sub(pos);
      pos.copy(P.hurtbox.center).add(new V3(0, 0, -D)).sub(off);
      sh.placeAt(pos, fwd);
      sh.speed = sh.spec.stats.cruise * 0.5;
      const ai = sh.ai;
      ai._chooseAttack = () => 'bite';
      ai.feints = 0; ai._firstDecisionDone = true; ai._firstCommitDone = true; ai.tailCd = 99; ai.kind = 'bite';
      mgr.requestToken(sh);
      ai._enter('approach');
      if (swimIn) { g.cameraRig.lockTarget = sh; g.input.simulate('forward', true); }
      let done = -1, pressAt = null, grabbed = false;
      S.frames(600, (i) => {
        if (swimIn && !['approach', 'telegraph', 'attack'].includes(ai.state)) g.input.simulate('forward', false);
        if (parryAfter !== null && pressAt === null && S.cues.length) pressAt = S.cues[0].t + parryAfter;
        if (pressAt !== null && pressAt > 0 && g.time.elapsed >= pressAt - 1e-6) { g.input.simulate('parry', true); g.input.simulate('parry', false); pressAt = -1; }
        if (g.combat.grab) grabbed = true;
        if (done < 0 && S.teles.length && ai.state !== 'telegraph' && ai.state !== 'attack') done = i;
        return grabbed || (done >= 0 && i > done + 20);
      });
      S.release();
      g.cameraRig.lockTarget = null;
      g.combat?.qte?.end?.(false, 'test');
      for (const o of rest) o.freeze = false;
      return S.rows().map((r) => ({ ...r, D, yaw, swimIn, grabbed, state: ai.state }));
    };
  })()`);
  await ev(`__S.frames(10)`);

  for (const [species, wave] of [['greatWhite', 0], ['tiger', 1], ['megalodon', 2]]) {
    const rows = [];
    let n = 0;
    for (const D of [2, 3, 4]) {
      for (const yaw of [0, 40]) {
        for (const swimIn of [false, true]) {
          rows.push(...(await ev(`(() => { __S.seed(${2000 + n++}); return __S.trial(${JSON.stringify({ wave, D, yaw, swimIn })}); })()`)));
        }
      }
    }
    const con = rows.filter((r) => r.contact !== null);
    const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
    const leads = con.map((r) => r.lead).filter((x) => x !== null);
    out(`strike ${species}`, {
      trials: n,
      telegraphs: rows.length,
      contacts: con.length,
      early: con.filter((r) => r.contact < -1e-6).length,
      uncued: con.filter((r) => r.lead === null).length,
      late: con.filter((r) => r.lead !== null && r.lead < 0.22 - 1e-6).length,
      minLead: leads.length ? r2(Math.min(...leads)) : null,
      contactAfterTeleEnd: con.map((r) => r2(r.contact)).join(' '),
    });
    const pr = [];
    for (const D of [2, 3, 4, 3]) {
      pr.push(await ev(`(() => { __S.seed(${3000 + n++}); return __S.trial(${JSON.stringify({ wave, D, yaw: D === 3 && pr.length === 3 ? 40 : 0, god: false, parryAfter: 0.1 })}); })()`));
    }
    const flat = pr.map((rs) => rs[0] ?? {});
    out(`parry ${species}`, {
      parried: `${flat.filter((r) => r.parried).length}/${flat.length}`,
      grabbed: flat.filter((r) => r.grabbed).length,
      rows: flat.map((r) => `D${r.D} ${r.parried ? 'parry' : r.grabbed ? 'GRAB' : r.contact !== null ? 'hit' : 'miss'} cue${r2(r.cue)} contact${r2(r.contact)}`).join(' | '),
    });
  }
  log('### moduleErrors ' + JSON.stringify(await ev(`[...__game._moduleErrors]`)));
};
