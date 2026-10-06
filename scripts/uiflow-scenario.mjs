// UI / Director walkthrough for scripts/smoke.mjs — screenshots every screen.
// Launches a browser via smoke.mjs, so run it through the gate:
//
//   ~/.claude/bin/heavy-gate -n 1 -l uiflow -- node scripts/smoke.mjs \
//     --params "fixeddt&god" --wait 6500 --shots 0 \
//     --scenario scripts/uiflow-scenario.mjs --out .smoke/uiflow
//
// Env UIFLOW_ONLY=title,intro,card,hud,boss,pause,grab,death,victory limits the steps.
// Works against the stub modules as well as the real ones: enemies are frozen
// in place (their update() is replaced) so the camera-relative layout is stable.

const ONLY = (process.env.UIFLOW_ONLY || '').split(',').filter(Boolean);
const want = (step) => !ONLY.length || ONLY.includes(step);

export default async function scenario(page, { shot, wait, evaluate, log }) {
  // Helpers living in the page.
  await evaluate(`(() => {
    const g = window.__game;
    const cam = () => {
      g.camera.updateMatrixWorld();
      const m = g.camera.matrixWorld.elements;
      return {
        pos: [m[12], m[13], m[14]],
        right: [m[0], m[1], m[2]],
        fwd: [-m[8], -m[9], -m[10]],
      };
    };
    window.__ui = {
      // Place an enemy relative to the camera and freeze its AI.
      place(e, f, r, u = 0) {
        const c = cam();
        e.update = () => {};
        e.position.set(
          c.pos[0] + c.fwd[0] * f + c.right[0] * r,
          c.pos[1] + c.fwd[1] * f + c.right[1] * r + u,
          c.pos[2] + c.fwd[2] * f + c.right[2] * r,
        );
        for (const hb of e.hurtboxes || []) hb.center.copy(e.position);
        // The threat arcs also test the jaws: collapse them onto the body too.
        e.getMouthPosition?.()?.copy?.(e.position);
      },
      state: () => g.state,
    };
  })()`);

  const waitState = async (state, timeout = 60000) => {
    await page.waitForFunction((s) => window.__game?.state === s, state, { timeout });
  };

  // ---------------------------------------------------------------- title
  if (want('title')) {
    await shot('01-title');
    // Replay the ink reveal and catch it mid-way.
    await evaluate(`__game.ui.title.show()`);
    await wait(1300);
    await shot('01b-title-reveal');
    await wait(3500);
    // Open and close the controls panel through the real menu.
    await page.click('.fish-title [data-act="controls"]');
    await wait(900);
    await shot('02-controls');
    await page.keyboard.press('Escape');
    await wait(700);
  }

  // ---------------------------------------------------------------- intro
  if (want('intro')) {
    await page.click('.fish-title [data-act="start"]');
    await waitState('intro');
    // Headless frame pacing makes the Director's cue times drift from wall
    // time, so drive the lines explicitly for the screenshots.
    await evaluate(`__game.director.timeline.stop(); __game.events.emit('subtitle', { speaker: '', text: '［ 手机震动 ］', duration: 4 })`);
    await wait(1600);
    await shot('03-intro-caption');
    await evaluate(`__game.events.emit('subtitle', { speaker: '老婆', text: '老公，我想吃鱼了。', duration: 6 })`);
    await wait(1400);
    await shot('04-intro-line');
    await evaluate(`__game.events.emit('cinematic', { name: 'dive' }); __game.events.emit('subtitle', { speaker: '老公', text: '好嘞，晚饭交给我！', duration: 6 })`);
    await wait(1800);
    await shot('05-intro-dive');
  }

  // ----------------------------------------------------------------- card
  if (want('card')) {
    await evaluate(`__game.state === 'intro' ? __game.director.skipIntro() : __game.director.beginWave(0)`);
    await waitState('transition');
    await wait(2600);
    await shot('06-wave-card');
    await evaluate(`__game.director.beginWave(2)`);
    await wait(2800);
    await shot('07-wave-card-boss');
  }

  // ------------------------------------------------------------------ hud
  if (want('hud')) {
    // First wave: single bar + the one-time control tips line.
    await evaluate(`__game.director.beginWave(0, { immediate: true })`);
    await wait(500);
    await evaluate(`__ui.place(__game.enemies.enemies[0], 30, 26, 4)`);
    await wait(1600);
    await shot('08a-hud-first-wave');
    // Two tigers: one ahead (locked), one off-screen left and telegraphing.
    await evaluate(`__game.director.beginWave(1, { immediate: true })`);
    await wait(500);
    await evaluate(`(() => {
      const g = __game;
      const [a, b] = g.enemies.enemies;
      __ui.place(a, 18, 3, -1);
      __ui.place(b, 3, -22, 2);
      a.health = a.maxHealth * 0.55;
      g.cameraRig.lockTarget = a;
      g.player.health = 52;
      g.events.emit('player:hit', { damage: 20, health: 52, sourcePosition: b.position.clone(), heavy: true });
      g.events.emit('enemy:hit', { enemy: a, damage: 40, part: 'eye', position: a.position.clone(), critical: true, killed: false, attackType: 'light' });
      g.events.emit('enemy:telegraph', { enemy: b, type: 'bite', duration: 3 });
    })()`);
    await wait(260);
    await shot('08-hud-tigers');
    await evaluate(`__game.events.emit('player:parry', { success: true, enemy: __game.enemies.enemies[0] })`);
    await wait(300);
    await shot('09-hud-parry');
  }

  if (want('boss')) {
    await evaluate(`__game.director.beginWave(2, { immediate: true })`);
    await wait(500);
    await evaluate(`(() => {
      const g = __game;
      const m = g.enemies.enemies[0];
      __ui.place(m, -10, 6, -3); // behind the camera → bottom edge arrow
      m.health = m.maxHealth * 0.48;
      g.cameraRig.lockTarget = null;
      g.player.health = 22; // low-HP heartbeat border
      g.events.emit('enemy:telegraph', { enemy: m, type: 'ram', duration: 3 });
      g.events.emit('player:perfectDodge', { enemy: m });
    })()`);
    await wait(350);
    await shot('10-hud-boss');
  }

  // ---------------------------------------------------------------- pause
  if (want('pause')) {
    await evaluate(`__game.player.health = 70; __game.director.pause()`);
    await wait(900);
    await shot('11-pause');
    await evaluate(`__game.director.resume()`);
    await wait(300);
  }

  // ----------------------------------------------------------------- grab
  if (want('grab')) {
    await evaluate(`(() => {
      const g = __game;
      g.events.emit('grab:start', { enemy: g.enemies.enemies[0] });
      g.events.emit('grab:progress', { value: 0.45 });
    })()`);
    await wait(500);
    await shot('12-grab');
    await evaluate(`__game.events.emit('grab:end', { success: true, enemy: __game.enemies.enemies[0] })`);
    await wait(250);
    await shot('13-grab-escaped');
  }

  // ---------------------------------------------------------------- death
  if (want('death')) {
    await evaluate(`__game.debug.god = false; __game.player.takeHit({ damage: 999 })`);
    await waitState('dead');
    await wait(4000); // the death card reveal is delayed ~1.2 s so the death camera reads first
    await shot('14-death');
    log('death state', await evaluate(`__game.state`));
    // Retry via Enter (keyboard path through the death menu).
    await page.keyboard.press('Enter');
    await waitState('playing', 15000);
    log('after retry', await evaluate(`JSON.stringify({ s: __game.state, hp: __game.player.health, wave: __game.director.waveIndex })`));
  }

  // -------------------------------------------------------------- victory
  if (want('victory')) {
    await evaluate(`(() => {
      const d = __game.director;
      Object.assign(d.stats, { time: 412.4, damage: 4875, parries: 7, perfectDodges: 4, grabs: 3, grabsEscaped: 2, deaths: 1 });
      d._victory();
    })()`);
    await wait(7200); // the panel waits 3 s for the payoff shot; the menu rises at 5.6 s
    await shot('15-victory');
  }
}
