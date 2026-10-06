// Core module checks. Run through the gate (launches Chromium):
//   npm run build
//   ~/.claude/bin/heavy-gate -n 1 -l core -- node scripts/smoke.mjs --dist --step \
//       --params 'autostart&fixeddt&god&stats' --wait 300 --shots 0 \
//       --scenario scripts/core-scenario.mjs --out .smoke/core
// Logs one PASS / FAIL / INFO line per check (summary.logs) and a final tally.
//   input   mouse buttons are ignored while 'playing' without pointer lock; a menu click
//           (继续 / 重新开始本关 / 再来一次) doesn't leak a slash into play; a click still
//           skips the intro
//   frame   a pause pressed inside a frame (Director) skips that frame's simulation
//   quality harness default (or the ?quality the harness URL sets), saved choice, ?quality
//           override, GPU detection
//   boot    splash paints at once, staged init has no task over 1 s, splash goes after frame 1
import { resolve } from 'node:path';

export default async (page, { log, evaluate }) => {
  const tally = { pass: 0, fail: 0 };
  const check = (name, ok, detail) => {
    tally[ok ? 'pass' : 'fail']++;
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  };
  const info = (name, detail) => log(`INFO ${name} ${JSON.stringify(detail)}`);
  const startUrl = page.url();
  const origin = new URL(startUrl).origin;
  const outArg = process.argv.indexOf('--out');
  const outDir = resolve(outArg > 0 ? process.argv[outArg + 1] : '.smoke');
  const load = async (path, state = 'title') => {
    await page.goto(origin + path, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction((s) => window.__game?.state === s && window.__game.time.frame > 2, state, { timeout: 180000 });
    return page.evaluate(() => ({ quality: __game.quality, source: __game.qualitySource, gpu: __game.gpu }));
  };

  // The checks below step many frames: skip the render (slow on software GL and
  // irrelevant to them). __coreQuiet(fn) runs fn with post.render stubbed. Many
  // rendered frames inside one evaluate also leave seconds of queued GPU work on
  // lavapipe, which stalls the page's rAF — and so Playwright's "stable" check
  // before a click; __coreDrain() waits for the GPU (1×1 readPixels barrier).
  await evaluate(() => {
    const g = window.__game;
    window.__coreQuiet = (fn) => {
      const render = g.post.render;
      g.post.render = () => {};
      try {
        return fn();
      } finally {
        g.post.render = render;
      }
    };
    window.__coreDrain = () => {
      const gl = g.renderer.getContext();
      const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
    };
  });

  // ------------------------------------------------------------ input (core-2)
  const m = await evaluate(() => window.__coreQuiet(() => {
    const g = window.__game;
    const canvas = g.renderer.domElement;
    let attacks = 0;
    const off = g.events.on('player:attack', () => attacks++);
    const fire = (type, button) => canvas.dispatchEvent(new MouseEvent(type, { button, bubbles: true, cancelable: true }));
    const out = { state: g.state, freeMouse: g.debug.freeMouse };
    // player:attack fires when the swing goes live, after its ~0.13 s wind-up.
    g.input.pointerLocked = false;
    fire('mousedown', 0);
    out.unlocked = { pressed: g.input.pressed('attack'), down: g.input.isDown('attack') };
    g.frame();
    fire('mouseup', 0);
    fire('mousedown', 2);
    out.unlocked.heavyDown = g.input.isDown('heavy');
    fire('mouseup', 2);
    for (let i = 0; i < 40; i++) g.frame();
    out.unlocked.attacks = attacks;
    out.unlocked.playerState = g.player.state;
    g.input.pointerLocked = true;
    attacks = 0;
    fire('mousedown', 0);
    out.locked = { pressed: g.input.pressed('attack') };
    g.frame();
    fire('mouseup', 0);
    for (let i = 0; i < 40; i++) g.frame();
    out.locked.attacks = attacks;
    g.input.pointerLocked = false;
    off();
    return out;
  }));
  check('input: playing + unlocked mousedown(0) does not press attack', m.state === 'playing' && !m.freeMouse && !m.unlocked.pressed && !m.unlocked.down && m.unlocked.attacks === 0, m.unlocked);
  check('input: playing + unlocked mousedown(2) does not charge heavy', !m.unlocked.heavyDown);
  check('input: pointer-locked mousedown(0) attacks', m.locked.pressed && m.locked.attacks >= 1, m.locked);

  // ------------------------------------------- pause inside a frame (core-r1)
  // P / Esc is read by Director.update, the first update of the frame. The
  // simulation modules after it must not run in that frame with state 'paused'
  // (SharkAI read that as "not playing" and dropped a grab Combat still held).
  const pz = await evaluate(() => window.__coreQuiet(() => {
    const g = window.__game;
    const names = ['player', 'enemies', 'combat', 'vfx', 'ambient', 'env'];
    const seen = [];
    const saved = names.map((n) => [n, Object.prototype.hasOwnProperty.call(g[n], 'update'), g[n].update]);
    for (const [n, , u] of saved) {
      g[n].update = function (dt) {
        seen.push(g.state);
        return u.call(this, dt);
      };
    }
    const press = (a) => {
      g.input.simulate(a, true);
      g.frame();
      g.input.simulate(a, false);
    };
    const out = {};
    try {
      for (let i = 0; i < 3; i++) g.frame();
      const e0 = g.time.elapsed;
      seen.length = 0;
      press('pause');
      out.pauseFrame = { state: g.state, updates: seen.slice(), elapsedStep: +(g.time.elapsed - e0).toFixed(5) };
      seen.length = 0;
      for (let i = 0; i < 30; i++) g.frame(); // > Director's resume guard (0.3 s)
      out.paused = { updates: seen.length };
      seen.length = 0;
      press('pause');
      out.resumeFrame = { state: g.state, updates: seen.slice() };
      seen.length = 0;
      g.frame();
      out.next = { updates: seen.slice() };
    } finally {
      for (const [n, own, u] of saved) {
        if (own) g[n].update = u;
        else delete g[n].update;
      }
    }
    return out;
  }));
  check(
    'frame: pause pressed inside a frame → no simulation update that frame, no game time',
    pz.pauseFrame.state === 'paused' && pz.pauseFrame.updates.length === 0 && pz.pauseFrame.elapsedStep === 0,
    pz.pauseFrame,
  );
  check('frame: paused frames run no simulation update', pz.paused.updates === 0, pz.paused);
  check(
    'frame: resume pressed inside a frame → simulation runs again from the next frame, never "paused"',
    pz.resumeFrame.state === 'playing' && pz.resumeFrame.updates.length === 0 &&
      pz.next.updates.length === 6 && pz.next.updates.every((s) => s === 'playing'),
    { resumeFrame: pz.resumeFrame, next: pz.next },
  );

  // ----------------------------------------------- menu clicks (core-r3)
  // A menu button's mousedown and click land between the same two frames (always
  // under --step), so a mouse 'attack' pressed on a menu screen would survive
  // into the first frame of play and slash.
  const countAttacks = () =>
    evaluate(() => {
      const g = window.__game;
      window.__atk = { n: 0, off: g.events.on('player:attack', () => window.__atk.n++) };
    });
  const attacksAfter = () =>
    evaluate(() => window.__coreQuiet(() => {
      const g = window.__game;
      const state = g.state;
      for (let i = 0; i < 30; i++) g.frame();
      window.__atk.off?.();
      return { state, attacks: window.__atk.n, playerState: g.player.state };
    }));
  const menuClick = async (name, selector, toMenu, armMs) => {
    try {
      const st = await evaluate(toMenu);
      await evaluate(() => window.__coreDrain());
      await page.waitForTimeout(armMs); // menu arm delay (wall clock)
      await countAttacks();
      await page.click(selector, { timeout: 15000 });
      const r = await attacksAfter();
      check(`input: ${name} → no player:attack within 30 frames`, st !== 'playing' && r.state === 'playing' && r.attacks === 0, { menuState: st, ...r });
    } catch (err) {
      check(`input: ${name} → no player:attack within 30 frames`, false, String(err).slice(0, 600));
    }
  };
  const toPause = () => window.__coreQuiet(() => {
    const g = window.__game;
    g.director.pause();
    for (let i = 0; i < 3; i++) g.frame();
    return g.state;
  });
  await menuClick('pause menu 继续 click', '.fish-pause [data-act="resume"]', toPause, 800);
  await menuClick('pause menu 重新开始本关 click', '.fish-pause [data-act="restart"]', toPause, 800);
  await menuClick(
    'death screen 再来一次 click',
    '.fish-death [data-act="retry"]',
    () => window.__coreQuiet(() => {
      const g = window.__game;
      const god = g.debug.god;
      g.debug.god = false;
      for (let i = 0; i < 120 && g.player.alive; i++) {
        g.player.takeHit({ damage: 999, knockback: 0 });
        g.frame();
      }
      g.debug.god = god;
      for (let i = 0; i < 60 * 6 && g.state !== 'dead'; i++) g.frame();
      return g.state;
    }),
    3000, // DeathScreen arms 2.5 s after it shows
  );
  // A click still skips the intro (Director reads the mouse 'attack' there).
  const sk = await evaluate(() => window.__coreQuiet(() => {
    const g = window.__game;
    g.director.startGame(0); // plays the intro (autostart only skips it at boot)
    for (let i = 0; i < 72; i++) g.frame(); // past the 0.6 s skip grace
    return g.state;
  }));
  await page.mouse.click(640, 400);
  const sk2 = await evaluate(() => window.__coreQuiet(() => {
    const g = window.__game;
    for (let i = 0; i < 3; i++) g.frame();
    const after = g.state;
    for (let i = 0; i < 60 * 6 && g.state !== 'playing'; i++) g.frame();
    return { after, final: g.state };
  }));
  check('input: a click skips the intro', sk === 'intro' && sk2.after === 'transition' && sk2.final === 'playing', { before: sk, ...sk2 });

  // ----------------------------------------------------------- quality (core-1)
  const q0 = await evaluate(() => ({ quality: __game.quality, source: __game.qualitySource, gpu: __game.gpu }));
  const urlQ = new URL(startUrl).searchParams.get('quality');
  if (urlQ) check(`quality: harness ?quality=${urlQ} → ${urlQ} (url)`, q0.quality === urlQ && q0.source === 'url', q0);
  else check('quality: autostart/fixeddt harness run stays on high', q0.quality === 'high' && q0.source === 'debug', q0);

  let q = await load('/?quality=medium');
  check('quality: ?quality=medium → medium (url)', q.quality === 'medium' && q.source === 'url', q);
  await page.evaluate(() => localStorage.setItem('fish.quality', 'low'));
  q = await load('/');
  check('quality: saved "low", no params → low (saved)', q.quality === 'low' && q.source === 'saved', q);
  q = await load('/?quality=medium');
  check('quality: ?quality=medium beats saved low', q.quality === 'medium' && q.source === 'url', q);
  q = await load('/?autostart&fixeddt', 'playing');
  check('quality: saved choice also applies to autostart runs', q.quality === 'low' && q.source === 'saved', q);
  await page.evaluate(() => localStorage.removeItem('fish.quality'));
  q = await load('/');
  check('quality: nothing saved → detected from the GPU', q.source === 'detected' && ['low', 'medium', 'high'].includes(q.quality), q);
  if (/llvmpipe|SwiftShader/i.test(q.gpu)) check('quality: software rasteriser detected as low', q.quality === 'low', q);

  // Title-screen choice → reload without params. Persisting is the TitleScreen's
  // job (uiflow); reported as INFO so this scenario runs before/after that lands.
  try {
    await page.waitForTimeout(1500); // Menu arm delay (real time)
    await Promise.all([
      page.waitForURL(/quality=medium/, { timeout: 30000 }),
      page.click('.fish-title [data-q="medium"]', { timeout: 10000 }),
    ]);
    await page.waitForFunction(() => window.__game?.time?.frame > 2, null, { timeout: 180000 });
    const saved = await page.evaluate(() => localStorage.getItem('fish.quality'));
    q = await load('/');
    info('quality: title pick "中" then reload without params', { saved, ...q, persisted: q.quality === 'medium' && q.source === 'saved' });
  } catch (err) {
    info('quality: title pick flow failed', String(err).slice(0, 200));
  }
  await page.evaluate(() => localStorage.removeItem('fish.quality'));

  // -------------------------------------------------------------- boot (core-3)
  await page.addInitScript(() => {
    const B = (window.__boot = { longtasks: [], paints: [], frames: [], idle: [] });
    // Attribute long tasks: time every game frame (first 40) and every idle callback over 50 ms.
    let G;
    Object.defineProperty(window, '__game', {
      configurable: true,
      get: () => G,
      set(v) {
        G = v;
        const f = v.frame;
        v.frame = function () {
          const s = performance.now();
          f.call(this);
          if (B.frames.length < 40) B.frames.push([+s.toFixed(1), +(performance.now() - s).toFixed(1), this.state, this.renderer.info.programs?.length ?? 0]);
        };
      },
    });
    const ric = window.requestIdleCallback?.bind(window);
    if (ric) {
      window.requestIdleCallback = (cb, o) =>
        ric((dl) => {
          const s = performance.now();
          cb(dl);
          const d = performance.now() - s;
          if (d > 50) B.idle.push([+s.toFixed(1), +d.toFixed(1)]);
        }, o);
    }
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) B.longtasks.push([+e.startTime.toFixed(1), +e.duration.toFixed(1)]);
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* unsupported */ }
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) B.paints.push([e.name, +e.startTime.toFixed(1)]);
      }).observe({ type: 'paint', buffered: true });
    } catch { /* unsupported */ }
  });
  await page.goto(origin + '/?fixeddt&quality=high', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const early = await page.evaluate(() => {
    const el = document.getElementById('boot-splash');
    const cs = el && getComputedStyle(el);
    return { state: window.__game?.state ?? null, splash: !!el, opacity: cs?.opacity, text: el?.textContent.replace(/\s+/g, ' ').trim() };
  });
  await page.screenshot({ path: resolve(outDir, 'boot-splash.png') });
  check('boot: splash in the DOM while booting', early.splash && early.opacity === '1' && early.text.includes('下水中'), early);
  await page.waitForFunction(() => window.__game?.state === 'title' && window.__game.time.frame > 2, null, { timeout: 180000 });
  const gone = await page
    .waitForFunction(() => !document.getElementById('boot-splash'), null, { timeout: 20000 })
    .then(() => true, () => false);
  check('boot: splash removed after the first frame', gone);
  await page.waitForTimeout(3500); // title ink reveal
  await page.screenshot({ path: resolve(outDir, 'boot-title.png') });
  const b = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paints = Object.fromEntries(window.__boot.paints);
    return {
      dcl: +nav.domContentLoadedEventEnd.toFixed(1),
      fp: paints['first-paint'] ?? null,
      fcp: paints['first-contentful-paint'] ?? null,
      longtasks: window.__boot.longtasks,
      slowFrames: window.__boot.frames.filter((f) => f[1] > 50),
      slowIdle: window.__boot.idle,
      firstFrameAt: window.__boot.frames[0]?.[0] ?? null,
      quality: window.__game.quality,
      moduleErrors: [...window.__game._moduleErrors],
    };
  });
  info('boot: timings (ms) [start, duration(, state, programs)]', b);
  check('boot: FCP (splash) within 300 ms of DOMContentLoaded', b.fcp !== null && b.fcp - b.dcl <= 300, { fcp: b.fcp, dcl: b.dcl });
  // Boot = every task up to and including the first frame (later ones are frame / idle work).
  const bootTasks = b.longtasks.filter((t) => b.firstFrameAt !== null && t[0] <= b.firstFrameAt + 1);
  const maxBoot = Math.max(0, ...bootTasks.map((t) => t[1]));
  check('boot: no boot task (init stages + first frame) over 1000 ms on high', b.quality === 'high' && maxBoot < 1000, { maxBoot, bootTasks });
  // Later title frames / idle work belong to other modules (shader warm-up, species
  // prefetch); reported, not failed here.
  info('boot: longest task in the first seconds on the title', { maxTask: Math.max(0, ...b.longtasks.map((t) => t[1])) });
  check('boot: no module errors', b.moduleErrors.length === 0, b.moduleErrors);

  // Back to the harness page so the smoke summary describes it.
  await page.goto(startUrl, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__game?.time?.frame > 2, null, { timeout: 180000 });
  await page.evaluate(() => window.__game.renderer.setAnimationLoop(null));
  log(`core checks: ${tally.pass} passed, ${tally.fail} failed`);
};
