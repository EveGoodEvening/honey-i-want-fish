// Behaviour test for the enemies module. Fast-forwards the simulation inside
// the page (no rendering between steps, so SwiftShader speed does not matter),
// logs each shark's state timeline and the enemy events, and checks the
// contract: telegraph before attack, grab hold/release, megalodon roars,
// death/wave-clear emitted once.
//
//   ~/.claude/bin/heavy-gate -n 1 -l enemies -- node scripts/smoke.mjs \
//       --params "autostart&fixeddt&god" --wait 3000 --shots 0 \
//       --scenario scripts/enemies-ai-scenario.mjs --out .smoke/enemies/ai
export default async function scenario(page, { shot, wait, log }) {
  await page.evaluate(() => {
    const g = window.__game;
    window.__events = [];
    for (const name of ['enemy:spawn', 'enemy:telegraph', 'enemy:attack', 'enemy:roar', 'enemy:death', 'wave:clear']) {
      g.events.on(name, (e) => {
        window.__events.push({
          t: +g.time.elapsed.toFixed(2),
          name,
          type: e.type ?? e.enemy?.type ?? '',
          who: e.enemy ? g.enemies.enemies.indexOf(e.enemy) : -1,
          duration: e.duration !== undefined ? +e.duration.toFixed(2) : undefined,
        });
      });
    }
    // Step the simulation without rendering.
    window.__ff = (seconds, dt = 1 / 30) => {
      const timeline = g.enemies.enemies.map(() => []);
      const n = Math.round(seconds / dt);
      for (let i = 0; i < n; i++) {
        g.time.elapsed += dt;
        g.time.dt = dt;
        g.player.update(dt);
        g.enemies.update(dt);
        g.combat.update(dt);
        g.enemies.enemies.forEach((e, k) => {
          const tl = timeline[k];
          if (!tl) return;
          const last = tl[tl.length - 1];
          if (!last || last.s !== e.state) {
            tl.push({ s: e.state, t: +g.time.elapsed.toFixed(1), d: +e.position.distanceTo(g.player.position).toFixed(1) });
          }
        });
      }
      return timeline.map((tl) => tl.map((x) => `${x.s}@${x.t}(${x.d}m)`).join(' > '));
    };
  });

  // ---- wave 0: great white, natural behaviour for 60 s of game time
  let r = await page.evaluate(() => {
    const g = window.__game;
    g.enemies.spawnWave(0);
    const s = g.enemies.enemies[0];
    const d0 = +s.position.distanceTo(g.player.position).toFixed(1);
    const tl = window.__ff(60);
    return { spawnDist: d0, tl, danger: s.getDangerLevel().toFixed(2) };
  });
  log('GW spawnDist', r.spawnDist, 'danger', r.danger);
  log('GW timeline', r.tl[0]);

  // ---- grab flow
  r = await page.evaluate(() => {
    const g = window.__game;
    const s = g.enemies.enemies[0];
    s.startGrab(g.player);
    g.player.setGrabbed(s);
    window.__ff(1.5);
    const held = +g.player.position.distanceTo(s.getMouthPosition()).toFixed(3);
    const stGrab = s.state;
    s.releaseGrab(true);
    const stAfter = s.state;
    const grabbedBy = g.player.grabbedBy === null;
    window.__ff(3);
    return { held, stGrab, stAfter, grabbedBy, later: s.state };
  });
  log('grab', JSON.stringify(r));

  // ---- parry → stagger
  r = await page.evaluate(() => {
    const g = window.__game;
    const s = g.enemies.enemies[0];
    s.onParried();
    const st = s.state;
    const vuln0 = s.vulnerable;
    window.__ff(0.2);
    const res = s.takeHit({ damage: 10, part: 'body', point: s.position.clone(), direction: s.forward.clone(), attackType: 'light' });
    return { st, vuln: s.vulnerable || vuln0, dealt: res.damage };
  });
  log('parry', JSON.stringify(r));

  // ---- kill → death + wave clear once
  r = await page.evaluate(() => {
    const g = window.__game;
    const s = g.enemies.enemies[0];
    s.takeHit({ damage: 9999, part: 'gills', point: s.position.clone(), direction: s.up.clone() });
    s.takeHit({ damage: 9999, part: 'gills', point: s.position.clone(), direction: s.up.clone() });
    const tl = window.__ff(25);
    return { tl, y: +s.position.y.toFixed(2), roll: +s.pose.roll.toFixed(2), state: s.state };
  });
  log('death', JSON.stringify(r));

  // ---- wave 1: tigers (flanking)
  r = await page.evaluate(() => {
    const g = window.__game;
    g.enemies.spawnWave(1);
    const d = g.enemies.enemies.map((e) => +e.position.distanceTo(g.player.position).toFixed(1));
    const tl = window.__ff(60);
    return { d, tl };
  });
  log('tigers spawnDist', JSON.stringify(r.d));
  log('tiger0', r.tl[0]);
  log('tiger1', r.tl[1]);

  // ---- wave 2: megalodon phases
  r = await page.evaluate(() => {
    const g = window.__game;
    g.enemies.spawnWave(2);
    const s = g.enemies.enemies[0];
    const d = +s.position.distanceTo(g.player.position).toFixed(1);
    const tl1 = window.__ff(30);
    s.takeHit({ damage: Math.round(s.maxHealth * 0.45), part: 'body', point: s.position.clone(), direction: s.up.clone() });
    const tl2 = window.__ff(30);
    s.takeHit({ damage: Math.round(s.maxHealth * 0.35), part: 'body', point: s.position.clone(), direction: s.up.clone() });
    const tl3 = window.__ff(40);
    return { d, tl1, tl2, tl3, phase: s.ai.phase, minDanger: s.getDangerLevel().toFixed(2) };
  });
  log('mega spawnDist', r.d, 'phase', r.phase, 'danger', r.minDanger);
  log('mega P1', r.tl1[0]);
  log('mega P2', r.tl2[0]);
  log('mega P3', r.tl3[0]);

  // ---- megalodon wake: a fast pass 3 m from the player pushes them
  r = await page.evaluate(() => {
    const g = window.__game;
    g.enemies.spawnWave(2);
    const s = g.enemies.enemies[0];
    const p = g.player.position;
    const V = p.constructor;
    g.player.velocity.set(0, 0, 0);
    s.placeAt(new V(p.x - 3, p.y + 3, p.z), new V(0, 0, 1));
    s.speed = 10;
    for (let i = 0; i < 6; i++) s._wake(1 / 30);
    return { pushed: +g.player.velocity.length().toFixed(2) };
  });
  log('mega wake', JSON.stringify(r));

  // ---- CPU cost of EnemyManager.update (two tigers, then the megalodon)
  r = await page.evaluate(() => {
    const g = window.__game;
    const out = {};
    for (const wave of [1, 2]) {
      g.enemies.spawnWave(wave);
      for (let i = 0; i < 60; i++) g.enemies.update(1 / 60); // warm up
      const t0 = performance.now();
      const N = 600;
      for (let i = 0; i < N; i++) {
        g.time.elapsed += 1 / 60;
        g.enemies.update(1 / 60);
      }
      out[`wave${wave}`] = +((performance.now() - t0) / N).toFixed(3);
    }
    return out;
  });
  log('enemies.update ms/frame', JSON.stringify(r));

  const events = await page.evaluate(() => window.__events);
  const counts = {};
  for (const e of events) counts[`${e.name}:${e.type}`] = (counts[`${e.name}:${e.type}`] ?? 0) + 1;
  log('event counts', JSON.stringify(counts));
  log('telegraph durations', JSON.stringify(events.filter((e) => e.name === 'enemy:telegraph').map((e) => `${e.type}:${e.duration}`)));
  await wait(500);
  await shot('ai-end');
}
