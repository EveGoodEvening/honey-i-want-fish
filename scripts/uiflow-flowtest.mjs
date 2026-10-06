// End-to-end Director flow test for scripts/smoke.mjs (no shortcuts: real
// intro timeline, real cards, keyboard/mouse through the real menus).
//
//   npx vite build
//   ~/.claude/bin/heavy-gate -n 1 -l uiflow -- node scripts/smoke.mjs --dist --step \
//     --params 'fixeddt&god&stats' --wait 1500 --shots 0 \
//     --scenario scripts/uiflow-flowtest.mjs --out .smoke/uiflow-flow
//
// Works with or without --step. With --step the test drives the frames itself
// (rendering off, so the 11.6 s intro takes seconds instead of minutes);
// without it, it polls the live render loop. Every wait on the game is a
// condition on game state / game clock, never a wall-clock sleep — at 2–9 fps
// on lavapipe wall time and the ?fixeddt game clock differ by 10×. Only the
// menu arming and CSS reveals run on wall time, so those waits stay sleeps.
//
// Logs "FLOW OK" or "FLOW FAIL: …" (and throws on failure so smoke exits 1).

export default async function flowtest(page, { shot, wait, evaluate, log }) {
  const fail = (msg) => {
    log(`FLOW FAIL: ${msg}`);
    throw new Error(msg);
  };

  // --step stops the page's render loop: detect it (no frame advances).
  let stepping = true;
  const f0 = await evaluate('__game.time.frame');
  for (let i = 0; i < 16 && stepping; i++) {
    await wait(250);
    if ((await evaluate('__game.time.frame')) !== f0) stepping = false;
  }
  log(`flowtest mode: ${stepping ? 'step (frames driven by the test)' : 'live render loop'}`);

  /**
   * Advance the game until the JS expression `pred` is true.
   * Live loop: poll every 100 ms for `timeout` wall-ms.
   * --step: run up to `frames` simulation frames in-page with rendering off.
   */
  const until = async (pred, what, { timeout = 90000, frames = 60 * 90 } = {}) => {
    if (!stepping) {
      try {
        await page.waitForFunction(pred, null, { timeout, polling: 100 });
      } catch {
        fail(`timed out waiting for ${what} (state ${await evaluate('__game.state')})`);
      }
      return;
    }
    const ok = await page.evaluate(
      ({ pred, frames }) => {
        const g = window.__game;
        const test = new Function(`return (${pred});`);
        const post = g.post;
        const render = post.render;
        post.render = () => g.scene.updateMatrixWorld();
        try {
          for (let i = 0; i < frames; i++) {
            if (test()) return true;
            g.frame();
          }
          return !!test();
        } finally {
          post.render = render;
        }
      },
      { pred, frames },
    );
    if (!ok) fail(`no ${what} within ${frames} frames (state ${await evaluate('__game.state')})`);
  };
  const waitState = (state, opts) => until(`window.__game?.state === ${JSON.stringify(state)}`, `state "${state}"`, opts);
  /** Let `n` frames run (live: wait for them; step: run them). */
  const frames = async (n) => {
    const f = await evaluate('__game.time.frame');
    await until(`__game.time.frame >= ${f + n}`, `${n} frames`, { timeout: 30000, frames: n });
  };
  const killAll = () => evaluate(`for (const e of __game.enemies.enemies) { e.health = 0; e.alive = false; }`);

  await evaluate(`(() => {
    const g = window.__game;
    window.__flow = [];
    for (const name of ['game:state', 'subtitle', 'cinematic', 'wave:start', 'game:victory', 'grab:end', 'player:attack']) {
      g.events.on(name, (p) => {
        const s = name === 'game:state' ? p.from + '>' + p.to
          : name === 'subtitle' ? (p.speaker || '-') + ':' + p.text
          : name === 'cinematic' ? p.name
          : name === 'wave:start' ? String(p.index) + (p.retry ? ' retry' : '')
          : name === 'grab:end' ? JSON.stringify({ success: p.success, interrupted: p.interrupted })
          : name === 'player:attack' ? String(p.type) + ' @' + g.time.frame
          : JSON.stringify(p.stats);
        window.__flow.push(name + ' ' + s);
      });
    }
    // Black dips (UI.dip): which state changes cut to black.
    const dip = g.ui.dip.bind(g.ui);
    g.ui.dip = (s) => {
      window.__flow.push('dip ' + s + ' ' + g.state);
      return dip(s);
    };
  })()`);
  const mark = () => evaluate('__flow.length');
  const since = (m, prefix) => evaluate(`__flow.slice(${m}).filter((l) => l.startsWith(${JSON.stringify(prefix)}))`);
  // A menu click that returns to play must not also press 'attack' (Menu stops the mousedown).
  const noSlash = async (m, what) => {
    await frames(30); // player:attack fires when the swing goes live (~8 frames after the press)
    const hits = await since(m, 'player:attack');
    if (hits.length) fail(`${what} leaked a slash into play: ${JSON.stringify(hits)}`);
  };
  /**
   * Click a menu button the way a player does: cursor free, after the screen's
   * reveal has played (finite CSS animations under `screen` done — they run on
   * the wall clock and can lag far behind on a loaded software-GL box), with a
   * real mouse press at the button's centre. page.click's actionability check
   * proved flaky here (it reported the screen <section> over its own button
   * after a pointer-lock round trip), so this goes through page.mouse.
   */
  const clickMenu = async (screen, act) => {
    await evaluate(`document.pointerLockElement && document.exitPointerLock()`);
    await page.waitForFunction(() => !document.pointerLockElement, null, { timeout: 10000 }).catch(() => {});
    await page
      .waitForFunction(
        (s) => document.getAnimations().every((a) => {
          const t = a.effect?.target;
          if (!t?.closest?.(s) || a.playState !== 'running') return true;
          return a.effect.getComputedTiming().endTime === Infinity;
        }),
        screen,
        { timeout: 60000, polling: 100 },
      )
      .catch(() => log(`clickMenu: ${screen} reveal still running after 60 s`));
    const box = await page.locator(`${screen} [data-act="${act}"]`).boundingBox();
    if (!box) fail(`no ${screen} [data-act="${act}"] button`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  const grabCls = () => evaluate(`(() => { const c = document.querySelector('.fish-grab').classList; return { on: c.contains('is-on'), paused: c.contains('is-paused') }; })()`);

  if ((await evaluate('__game.state')) !== 'title') fail('did not boot to title');

  // Title → Enter on the focused 「下水」.
  await page.keyboard.press('Enter');
  await waitState('intro', { timeout: 10000, frames: 120 });
  await until(`document.querySelector('.fish-introveil')?.classList.contains('is-on')`, 'intro veil', { frames: 5 });
  const introMark = await mark();
  await waitState('transition'); // the whole intro plays out
  // The plunge arrives at the follow pose: the card fades in over it, no black dip.
  const introDips = await since(introMark, 'dip');
  if (introDips.length) fail(`played-out intro dipped to black: ${JSON.stringify(introDips)}`);
  const subs = await evaluate(`__flow.filter((l) => l.startsWith('subtitle')).length`);
  if (subs < 3) fail(`expected 3 intro subtitles, got ${subs}`);
  if (!(await evaluate(`__flow.includes('cinematic dive')`))) fail('no cinematic dive cue');
  if (await evaluate(`document.querySelector('.fish-introveil').classList.contains('is-on')`)) fail('intro veil stuck on');
  await waitState('playing');
  if ((await evaluate('__game.enemies.enemies.length')) !== 1) fail('wave 0 did not spawn one enemy');

  // Pause with Esc, resume with Esc. The Director ignores a resume press within
  // FLOW.resumeGuard of the pause on the game clock, so wait on that clock.
  await frames(20);
  await page.keyboard.press('Escape');
  await waitState('paused', { timeout: 5000, frames: 30 });
  await until('__game.time.realElapsed - __game.director._pausedAt > 0.35', 'the resume guard', { timeout: 30000, frames: 60 });
  await page.keyboard.press('Escape');
  await waitState('playing', { timeout: 5000, frames: 30 });

  // Pause again and resume by clicking 继续: no slash on the way back. (Paused
  // through the Director: the Esc resume above may have taken pointer lock, and
  // headless Esc-while-locked handling is not what this checks.)
  await frames(5);
  await evaluate('__game.director.pause()');
  await waitState('paused', { timeout: 5000, frames: 5 });
  await wait(400); // PauseMenu armDelay 0.2 s (wall clock)
  const resumeMark = await mark();
  await clickMenu('.fish-pause', 'resume');
  await waitState('playing', { timeout: 5000, frames: 5 });
  await noSlash(resumeMark, 'clicking 继续');

  // Paused mid-grab: the QTE prompt steps aside for the pause menu and comes
  // back on resume.
  await evaluate(`__game.player.health = 64; __game.combat.qte.start(__game.enemies.enemies[0])`);
  await frames(3);
  if (!(await evaluate('!!__game.combat.grab'))) fail('could not start a grab');
  const g0 = await grabCls();
  if (!g0.on || g0.paused) fail(`grab prompt not shown while grabbed ${JSON.stringify(g0)}`);
  await evaluate('__game.director.pause()');
  await waitState('paused', { timeout: 5000, frames: 5 });
  await frames(1);
  const g1 = await grabCls();
  if (!g1.on || !g1.paused) fail(`grab prompt not stepped aside while paused ${JSON.stringify(g1)}`);
  await evaluate('__game.director.resume()');
  await waitState('playing', { timeout: 5000, frames: 5 });
  await frames(1);
  const g2 = await grabCls();
  if (!(await evaluate('!!__game.combat.grab'))) fail('grab lost over pause/resume');
  if (!g2.on || g2.paused) fail(`grab prompt not back after resume ${JSON.stringify(g2)}`);

  // Retry from the pause menu while grabbed: the grab ends silently, the
  // attempt restarts clean (no post-grab i-frames, full HP shown at once).
  await evaluate('__game.director.pause()');
  await waitState('paused', { timeout: 5000, frames: 5 });
  await evaluate('__game.ui.retry()');
  const rg = await evaluate(`({ grab: !!__game.combat.grab, grabbedBy: !!__game.player.grabbedBy, grace: __game.player._grace,
    state: __game.state, hp: __game.player.health, retryStart: __flow[__flow.length - 1] })`);
  if (rg.grab || rg.grabbedBy || rg.grace > 0 || rg.state !== 'playing' || rg.hp !== 100) fail(`bad grab retry ${JSON.stringify(rg)}`);
  if (rg.retryStart !== 'wave:start 0 retry') fail(`expected a retry wave:start, got ${rg.retryStart}`);
  await frames(2);
  const hud = await evaluate(`({ num: document.querySelector('.fish-player__num').textContent,
    fill: document.querySelector('.fish-bar--hp .fish-bar__fill').style.transform,
    grab: document.querySelector('.fish-grab').classList.contains('is-on') })`);
  if (hud.num !== '100' || hud.fill !== 'scaleX(1)' || hud.grab) fail(`HUD not reset on retry ${JSON.stringify(hud)}`);
  if (await evaluate('!!__game.combat.grab || __game.player._grace > 0')) fail('grab came back after retry');

  // Clear wave 0 hurt → heal on the next card.
  await evaluate(`__game.player.health = 50`);
  await killAll();
  await waitState('transition');
  const healed = await evaluate('__game.player.health');
  if (Math.abs(healed - 85) > 0.5) fail(`expected heal to 85, got ${healed}`);
  await waitState('playing');
  if ((await evaluate('__game.enemies.enemies.length')) !== 2) fail('wave 1 did not spawn two tigers');

  // Clear wave 1 → long breather → megalodon.
  await killAll();
  await waitState('transition');
  await waitState('playing');

  // Die → death screen → click 「再来一次」.
  await evaluate(`__game.debug.god = false; __game.player.takeHit({ damage: 999 })`);
  await waitState('dead');
  await wait(3000); // the menu arms after the reveal (wall clock, DeathScreen armDelay 2.5 s)
  const retryMark = await mark();
  await clickMenu('.fish-death', 'retry');
  await waitState('playing', { timeout: 10000, frames: 30 });
  await evaluate(`__game.debug.god = true`);
  await noSlash(retryMark, 'clicking 再来一次 (death)');
  const retry = await evaluate(`({ hp: __game.player.health, wave: __game.director.waveIndex, deaths: __game.director.stats.deaths })`);
  if (retry.hp !== 100 || retry.wave !== 2 || retry.deaths !== 1) fail(`bad retry state ${JSON.stringify(retry)}`);

  // Kill the boss → victory with stats.
  await evaluate(`__game.events.emit('enemy:hit', { enemy: __game.enemies.enemies[0], damage: 123, critical: true })`);
  await killAll();
  await waitState('victory');
  const victory = await evaluate(`__flow.find((l) => l.startsWith('game:victory'))`);
  if (!victory || !victory.includes('"damage":123')) fail(`bad victory payload ${victory}`);
  await wait(6000); // the menu rises at 5.6 s (wall clock, VictoryScreen armDelay 5.4 s)
  await shot('flow-victory');
  const againMark = await mark();
  await clickMenu('.fish-victory', 'again');
  await waitState('transition', { timeout: 10000, frames: 30 });
  if ((await evaluate('__game.director.waveIndex')) !== 0) fail('play again did not restart at wave 0');
  await waitState('playing');
  await noSlash(againMark, 'clicking 再来一次 (victory)');

  // A skipped intro jumps the camera: that exit still dips to black.
  await evaluate('__game.director.startGame(0)');
  await waitState('intro', { timeout: 10000, frames: 5 });
  await until('__game.director.stateTime > 1.0', 'the intro skip grace', { timeout: 30000, frames: 120 });
  const skipMark = await mark();
  await page.keyboard.press('Enter');
  await waitState('transition', { timeout: 5000, frames: 5 });
  const skipDips = await since(skipMark, 'dip');
  if (!(await evaluate('__game.director.introSkipped'))) fail('skip did not mark introSkipped');
  if (skipDips.length !== 1) fail(`skipped intro should dip once, got ${JSON.stringify(skipDips)}`);

  log('flow:', JSON.stringify(await evaluate('__flow')));
  log('FLOW OK');
}
