// Captures live AI moments for the enemies module: fast-forwards the
// simulation until a moment of interest (telegraph, lunge, megalodon pass),
// freezes the shark and frames the shot from near the player.
//
//   ~/.claude/bin/heavy-gate -n 1 -l enemies -- node scripts/smoke.mjs \
//       --params "autostart&fixeddt&god" --wait 3000 --shots 0 \
//       --scenario scripts/enemies-live-scenario.mjs --out .smoke/enemies/live
export default async function scenario(page, { shot, wait, log }) {
  await page.evaluate(() => {
    const g = window.__game;
    g.cameraRig.update = () => {};
    const V = g.camera.position.constructor;
    window.__V = V;
    // Step the simulation (no rendering) until `pred()` is true or `max` seconds pass.
    window.__ffUntil = (pred, max = 60, dt = 1 / 60) => {
      const n = Math.round(max / dt);
      for (let i = 0; i < n; i++) {
        g.time.elapsed += dt;
        g.player.update(dt);
        g.enemies.update(dt);
        g.combat.update(dt);
        if (pred()) return +g.time.elapsed.toFixed(2);
      }
      return -1;
    };
    window.__camBehindPlayer = (target, back = 4, up = 1.0, side = 1.2) => {
      const p = g.player.position;
      const dir = target.clone().sub(p).normalize();
      const right = new V(-dir.z, 0, dir.x).normalize();
      g.camera.position.copy(p).addScaledVector(dir, -back).addScaledVector(right, side);
      g.camera.position.y += up;
      g.camera.lookAt(p.clone().lerp(target, 0.6));
    };
  });

  // ---- great white: telegraph seen from over the player's shoulder
  let r = await page.evaluate(() => {
    const g = window.__game;
    g.enemies.spawnWave(0);
    const s = g.enemies.enemies[0];
    s.ai.feints = 0;
    s.ai.decisionTimer = 0.2;
    s.ai.aggression = 1;
    s.ai.tailCd = 99;
    const t = window.__ffUntil(() => s.ai.state === 'telegraph' && s.ai.kind === 'bite' && s.ai.t > s.ai.teleDur * 0.8, 60);
    s.freeze = true;
    window.__camBehindPlayer(s.getMouthPosition(), 3.5, 0.8, 1.0);
    return { t, kind: s.ai.kind, d: +s.getMouthPosition().distanceTo(g.player.position).toFixed(1) };
  });
  log('gw telegraph', JSON.stringify(r));
  await wait(1500);
  await shot('live-gw-telegraph');

  r = await page.evaluate(() => {
    const g = window.__game;
    const s = g.enemies.enemies[0];
    s.freeze = false;
    const t = window.__ffUntil(() => s.ai.state === 'attack' && s.getMouthPosition().distanceTo(g.player.position) < 2.6, 3);
    s.freeze = true;
    // Side-on view of the lunge.
    const p = g.player.position;
    g.camera.position.set(p.x + s.right.x * 7, p.y + 1.2, p.z + s.right.z * 7);
    g.camera.lookAt(p.clone().lerp(s.position, 0.4));
    return { t, jaw: +s.pose.jaw.toFixed(2), eye: +s.pose.eyeRoll.toFixed(2) };
  });
  log('gw lunge', JSON.stringify(r));
  await wait(1500);
  await shot('live-gw-lunge');

  // ---- tigers: pincer
  r = await page.evaluate(() => {
    const g = window.__game;
    g.enemies.spawnWave(1);
    const [a, b] = g.enemies.enemies;
    for (const s of [a, b]) {
      s.ai.feints = 0;
      s.ai.tailCd = 99;
      s.ai.aggression = 1;
    }
    a.ai.decisionTimer = 0.2;
    b.ai.decisionTimer = 30;
    window.__ffUntil(() => a.ai.state === 'approach', 20);
    if (b.ai.state !== 'flank') b.ai.beginFlank(a); // the 30 % "hang back" roll is random
    const t = window.__ffUntil(() => b.ai.state === 'telegraph' && b.ai.t > 0.3, 40);
    a.freeze = true;
    b.freeze = true;
    // Frame both sharks and the player from above and to the side.
    const p = g.player.position;
    const ab = b.position.clone().sub(a.position);
    const side = new window.__V(-ab.z, 0, ab.x).normalize();
    const center = a.position.clone().add(b.position).add(p).multiplyScalar(1 / 3);
    const span = Math.max(ab.length(), 8);
    g.camera.position.copy(center).addScaledVector(side, span * 0.9);
    g.camera.position.y += span * 0.45;
    g.camera.lookAt(center);
    return { t, a: a.ai.state, b: b.ai.state, da: +a.position.distanceTo(p).toFixed(1), db: +b.position.distanceTo(p).toFixed(1) };
  });
  log('tiger pincer', JSON.stringify(r));
  await wait(1500);
  await shot('live-tiger-pincer');

  // ---- megalodon pass overhead, from the player's eye
  r = await page.evaluate(() => {
    const g = window.__game;
    g.enemies.spawnWave(2);
    const s = g.enemies.enemies[0];
    s.ai.tailCd = 99;
    s.ai.feints = 1;
    s.ai.decisionTimer = 0.2;
    s.ai.cfg = { ...s.ai.cfg, feintChance: 1 };
    let minD = 1e9;
    const t = window.__ffUntil(() => {
      const d = s.position.distanceTo(g.player.position);
      minD = Math.min(minD, d);
      return s.ai.state === 'feint' && d < 14;
    }, 60);
    s.freeze = true;
    const p = g.player.position;
    g.camera.position.set(p.x, p.y - 0.5, p.z);
    g.camera.lookAt(s.getMouthPosition());
    g.camera.fov = 70;
    g.camera.updateProjectionMatrix();
    return { t, minD: +minD.toFixed(1), state: s.ai.state, pvel: g.player.velocity.length().toFixed(2) };
  });
  log('mega pass', JSON.stringify(r));
  await wait(1500);
  await shot('live-mega-pass');
}
