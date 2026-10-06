// Smoke scenario for the render module (PostFX + AmbientLife).
// Launches nothing itself; run it through the smoke harness *via the gate*:
//
//   ~/.claude/bin/heavy-gate -n 1 -l render -- node scripts/smoke.mjs \
//       --params "autostart&fixeddt&god" --wait 4000 --shots 0 \
//       --scenario scripts/render-scenario.mjs --out .smoke/render
//
// Shots: the composited frame, looking up (god rays + eye adaptation), every
// PostFX pulse type, the enemy wind-up tunnel (enemy:telegraph), low-HP
// heartbeat vignette, a fish school close-up, a blood-triggered scatter, a
// jellyfish and the sperm-whale pass. Logs the shader warm-up result (no
// program may be compiled twice under the same name).
// Timing is frame-based (use ?fixeddt), so results are deterministic-ish even
// on slow SwiftShader.

async function ready(evaluate, wait, minFrame = 20) {
  // The Vite dev server may reload the page once while optimising deps.
  for (let i = 0; i < 600; i++) {
    try {
      const f = await evaluate('window.__game ? window.__game.time.frame : -1');
      if (f >= minFrame) return f;
    } catch {
      /* page navigating */
    }
    await wait(100);
  }
  throw new Error('game never became ready');
}

export default async function renderScenario(page, { shot, wait, evaluate, log }) {
  await ready(evaluate, wait);
  const frames = async (n) => {
    const start = await evaluate('__game.time.frame');
    for (let i = 0; i < 600; i++) {
      await wait(30);
      if ((await evaluate('__game.time.frame')) - start >= n) return;
    }
  };
  // freeze the (stub or real) enemies far away so shots are stable
  const parkEnemies = `(() => { for (const e of __game.enemies.enemies) { e.position.set(90, -30, 90); e.update = () => {}; } })()`;

  await frames(30);
  await shot('render-play');

  await evaluate('__game.cameraRig.pitch = 0.75; __game.cameraRig.yaw = 0.35');
  await frames(40);
  await shot('render-lookup');
  await evaluate('__game.cameraRig.pitch = -0.1; __game.cameraRig.yaw = 0');
  await frames(40);

  for (const [type, delay] of [['hit', 4], ['heavyHit', 4], ['parry', 5], ['kill', 20], ['dodge', 4], ['roar', 14], ['perfectDodge', 6]]) {
    await evaluate(`__game.post.pulse('${type}')`);
    await frames(delay);
    await shot(`render-pulse-${type}`);
    await frames(90);
  }
  await evaluate('__game.post._isGrabHeld = () => true; __game.post.pulse("grab")');
  await frames(40);
  await shot('render-pulse-grab');
  await evaluate('delete __game.post._isGrabHeld');
  await frames(90);

  // enemy wind-up: the vignette squeezes over the telegraph, lets go on the attack
  const vig = '+__game.post.gradePass.uniforms.uVignette.value.x.toFixed(3)';
  const vigBefore = await evaluate(vig);
  // the first enemy, frozen 8 m ahead so it never attacks: exercises the failsafe release
  await evaluate(`(() => { const g = __game; const e = g.enemies.enemies[0]; if (!e) return;
    e.freeze = true; e.position.copy(g.player.position); e.position.z -= 8;
    g.events.emit('enemy:telegraph', { enemy: e, type: 'bite', duration: 0.8 }); })()`);
  await frames(46);
  const vigEnd = await evaluate(vig);
  await shot('render-telegraph');
  await frames(60);
  await evaluate('for (const e of __game.enemies.enemies) e.freeze = false');
  log('telegraph vignette', JSON.stringify({ before: vigBefore, end: vigEnd, after: await evaluate(vig) }));
  log('programs', JSON.stringify(await evaluate(`(() => { const by = {}; for (const p of __game.renderer.info.programs) by[p.name] = (by[p.name] ?? 0) + 1;
    return { n: __game.renderer.info.programs.length, dup: Object.entries(by).filter(([k, v]) => k && v > 1) }; })()`)));

  await evaluate('__game.player.health = 14');
  await frames(30);
  await shot('render-lowhp');
  await evaluate('__game.player.health = __game.player.maxHealth');

  await evaluate(parkEnemies);
  await evaluate(`(() => { const g = __game; g.player.object3d.visible = false;
    const c = g.ambient.fish.getSchoolCenter(0); g.player.position.set(c.x + 1, c.y + 1.5, c.z + 6);
    g.cameraRig.yaw = 0; g.cameraRig.pitch = -0.2; })()`);
  await frames(3);
  await shot('render-school');
  await evaluate(`(() => { const g = __game; const c = g.ambient.fish.getSchoolCenter(0);
    g.events.emit('enemy:hit', { position: c.clone(), damage: 30, critical: true }); })()`);
  await frames(12);
  await evaluate(`(() => { const g = __game; const c = g.ambient.fish.getSchoolCenter(0); g.player.position.set(c.x, c.y + 1.5, c.z + 12); g.cameraRig.pitch = -0.1; })()`);
  await frames(2);
  await shot('render-school-scatter');

  await evaluate(`(() => { const g = __game; const j = g.ambient.jellies.jellies[0];
    g.player.position.set(j.pos.x, j.pos.y - 0.8, j.pos.z + 4.5); g.cameraRig.yaw = 0; g.cameraRig.pitch = 0.12; })()`);
  await frames(3);
  await shot('render-jelly');

  await evaluate(`(() => { const g = __game; g.player.position.set(0, -20, 12); g.cameraRig.yaw = 0; g.cameraRig.pitch = -0.1; })()`);
  await frames(5);
  log('whale', JSON.stringify(await evaluate(`(() => { let got = false; __game.events.once('ambient:whale', () => { got = true; });
    const ok = __game.ambient.triggerWhale(); return { ok, got }; })()`)));
  const look = `(() => { const g = __game; const w = g.ambient.whale.position; const p = g.player.position;
    const dx = w.x - p.x, dy = w.y - p.y, dz = w.z - p.z; const d = Math.hypot(dx, dy, dz);
    g.cameraRig.yaw = Math.atan2(-dx, -dz); g.cameraRig.pitch = Math.asin(dy / d); return +d.toFixed(1); })()`;
  await evaluate('__game.ambient.whale.t = 0.5');
  await frames(2);
  log('whale distance', await evaluate(look));
  await frames(3);
  await shot('render-whale');
  await evaluate(`__game.player.position.lerp(__game.ambient.whale.position, 0.55)`);
  await frames(2);
  await evaluate(look);
  await frames(3);
  await shot('render-whale-close');
}
