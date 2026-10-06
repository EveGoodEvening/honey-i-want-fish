// Pass/fail checks for the render module (PostFX + AmbientLife). Launches nothing
// itself; run it through the heavy-gate, stepped, on a production build:
//
//   npx vite build && ~/.claude/bin/heavy-gate -n 1 -l render -- node scripts/smoke.mjs --dist --step \
//     --params 'autostart&fixeddt&god' --wait 300 --shots 0 \
//     --scenario scripts/render-checks.mjs --out .smoke/render-checks
//
// Logs one `render-checks` JSON line ({ results: { <check>: { pass, ... } } }):
//  bootWarmup   fresh high-quality title page (real rAF loop): after the first frame,
//               no frame compiles a program, and no long task from the warm-up
//               (between the first frame and the end of the title hold) is > 200 ms.
//               On lavapipe each task holds one program's first use (two in the
//               dry render), ≈ 20–60 ms on an idle machine but 100–340 ms when the
//               CPU is saturated (load ≥ core count): check `uptime` before
//               reading a failure here.
//  godRaysFirst first look-up after the title: god rays draw without new programs
//               or synchronous GL queries
//  fishCut      a hard camera cut onto a culled fish school draws it on that frame
//  dodgeBlur    dodge → perfect dodge: peak radial blur ≤ 1.0 (they replace, not stack)
//  lookupShallow / lookupDeep  look-up exposure at -20 m (≤ 5 % of canvas pixels with
//               luma > 215) and -41 m (≥ 5 % with luma > 150); canvas rows 100..650,
//               read back in the page (no HUD)
//  revealWave0  production page (/?quality=high: real rAF loop, no fixeddt — a stepped run
//               syncs the GPU every frame and hides first-use stalls): wait on the title
//               until every species is built and warmed, startGame(0), skip the intro,
//               then over the wave card and the great white's reveal (spawn frame + 60):
//               no long task > 100 ms, < 5 ms of synchronous GL queries in all, no program
//               compiled while playing, no held run of frames > 1.1 s on the title or
//               card after the boot warm-up (PostFX holds them while a warm-up finishes),
//               and no title task > 200 ms after the boot warm-up (`titleLongMax`).
//  revealCold   same page with every prefetch blocked: startGame(2, skipIntro) as soon as
//               the boot warm-up is done, so the megalodon is built, warmed and primed
//               behind its card; same criteria at its reveal.
//               Both report `gaps` (rAF intervals around the reveal: a GPU-side stall shows
//               there, not as a long task). On lavapipe each page takes 1–2 min.
// Set RENDER_CHECKS_TITLE_MS to change how long the title page runs (default 8000);
// RENDER_CHECKS_SKIP=reveal skips the two real-rAF reveal pages.

// Init script for the title page: frame / program / sync-query / long-task probes.
function titleProbe() {
  const now = () => performance.now();
  const P = (window.__rc = { longtasks: [], frames: [], newProgs: [], syncMs: 0 });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.longtasks.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* no long-task API */ }
  const proto = window.WebGL2RenderingContext?.prototype;
  for (const name of ['getProgramParameter', 'getProgramInfoLog', 'getShaderInfoLog', 'getActiveUniform', 'getUniformLocation']) {
    const f = proto?.[name];
    if (!f) continue;
    proto[name] = function (...a) {
      const s = now();
      try { return f.apply(this, a); } finally { P.syncMs += now() - s; }
    };
  }
  let G;
  Object.defineProperty(window, '__game', {
    configurable: true,
    get: () => G,
    set(v) {
      G = v;
      const R = v.renderer;
      let frame = 0;
      const rbd = R.renderBufferDirect;
      R.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
        const p0 = R.info.programs?.length ?? 0;
        const res = rbd.call(this, camera, scene, geometry, material, object, group);
        if ((R.info.programs?.length ?? 0) !== p0 && P.newProgs.length < 100) {
          P.newProgs.push({ frame, shadow: scene === null, obj: object?.name || object?.type, mat: material?.name || material?.type });
        }
        return res;
      };
      const f = v.frame;
      v.frame = function () {
        frame++;
        const p0 = R.info.programs?.length ?? 0;
        const s = now();
        f.call(this);
        P.frames.push([frame, s, now() - s, (R.info.programs?.length ?? 0) - p0, this.post?._holdUntil > 0]);
      };
    },
  });
}

// Init script for the real-rAF reveal pages: per-frame records (duration, state,
// programs built, synchronous GL query ms, whether PostFX drew or held it, sharks),
// long tasks, every program's first use (getUniforms > 1 ms), warm-up jobs, and
// optionally every species prefetch blocked.
function revealProbe(opts) {
  const now = () => performance.now();
  const P = (window.__rv = { longtasks: [], frames: [], newProgs: [], syncMs: 0, firstUse: [], warms: [], blocked: 0 });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.longtasks.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* no long-task API */ }
  Element.prototype.requestPointerLock = function () {
    return Promise.reject(new DOMException('pointer lock disabled', 'NotSupportedError'));
  };
  const COMPLETION_STATUS_KHR = 0x91b1; // polled, never blocks
  const proto = window.WebGL2RenderingContext?.prototype;
  for (const name of ['getProgramParameter', 'getProgramInfoLog', 'getShaderInfoLog', 'getShaderParameter', 'getActiveUniform', 'getUniformLocation', 'getActiveAttrib', 'getAttribLocation']) {
    const f = proto?.[name];
    if (!f) continue;
    proto[name] = function (...a) {
      if (name === 'getProgramParameter' && a[1] === COMPLETION_STATUS_KHR) return f.apply(this, a);
      const s = now();
      try { return f.apply(this, a); } finally { P.syncMs += now() - s; }
    };
  }
  let G;
  Object.defineProperty(window, '__game', {
    configurable: true,
    get: () => G,
    set(v) {
      G = v;
      const R = v.renderer;
      const wrap = (prog) => {
        const gu = prog.getUniforms;
        prog.getUniforms = function () {
          const s = now();
          const r = gu.call(this);
          const d = now() - s;
          if (d > 1 && P.firstUse.length < 200) P.firstUse.push([s, +d.toFixed(1), this.name, G.state, G.time.frame]);
          return r;
        };
      };
      const progs = R.info.programs;
      progs.forEach(wrap);
      const push = progs.push;
      progs.push = function (...a) {
        a.forEach(wrap);
        return push.apply(this, a);
      };
      const rbd = R.renderBufferDirect;
      R.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
        const p0 = R.info.programs.length;
        const res = rbd.call(this, camera, scene, geometry, material, object, group);
        if (R.info.programs.length !== p0 && P.newProgs.length < 100) {
          P.newProgs.push({ t: now(), state: G.state, shadow: scene === null, obj: object?.name || object?.type, mat: material?.name || material?.type });
        }
        return res;
      };
      const f = v.frame;
      v.frame = function () {
        const p0 = R.info.programs.length;
        const sy0 = P.syncMs;
        P.held = false;
        const s = now();
        f.call(this);
        if (P.frames.length < 20000) {
          P.frames.push([this.time.frame, s, now() - s, this.state, R.info.programs.length - p0, P.syncMs - sy0, P.held ? 0 : 1, this.enemies?.enemies?.length ?? 0]);
        }
      };
      let enemies;
      Object.defineProperty(v, 'enemies', {
        configurable: true,
        enumerable: true,
        get: () => enemies,
        set(e) {
          enemies = e;
          if (opts?.blockPrefetch) {
            e.assets.prefetch = () => {
              P.blocked++;
            };
          }
        },
      });
      let post;
      Object.defineProperty(v, 'post', {
        configurable: true,
        enumerable: true,
        get: () => post,
        set(p) {
          post = p;
          const hf = p._holdFrame.bind(p);
          p._holdFrame = () => (P.held = hf());
          const w = p.warmup.bind(p);
          p.warmup = (obj) => {
            const rec = { obj: obj ? obj.name || obj.type : 'scene', at: now(), state: G.state };
            P.warms.push(rec);
            const res = w(obj);
            Promise.resolve(res).then(() => {
              rec.ms = +(now() - rec.at).toFixed(0);
            });
            return res;
          };
        },
      });
    },
  });
}

// Page side: the reveal window after t0 (performance.now() before startGame).
function revealReport(t0) {
  const P = window.__rv;
  const g = window.__game;
  const F = P.frames.filter((f) => f[1] >= t0);
  const i0 = F.findIndex((f) => f[7] > 0); // the frame that spawned the wave
  const W = i0 >= 0 ? F.slice(i0, i0 + 61) : [];
  const wStart = W.length ? W[0][1] - 1 : Infinity;
  const wEnd = W.length ? W[W.length - 1][1] + W[W.length - 1][2] : -Infinity;
  const lt = P.longtasks.filter((t) => t[0] + t[1] >= wStart && t[0] <= wEnd);
  const gaps = [];
  for (let i = Math.max(1, i0 - 10); i >= 1 && i < F.length && i < i0 + 61; i++) gaps.push(+(F[i][1] - F[i - 1][1]).toFixed(0));
  // held runs (frames PostFX did not draw) on hold screens after t0, and on the title before it
  const runs = (frames) => {
    const out = [];
    let start = null;
    for (const f of frames) {
      const held = !f[6] && (f[3] === 'title' || f[3] === 'intro' || f[3] === 'transition');
      if (held && start === null) start = f;
      if (!held && start !== null) {
        out.push([start[3], +(f[1] - start[1]).toFixed(0)]);
        start = null;
      }
    }
    return out;
  };
  const before = P.frames.filter((f) => f[1] < t0);
  const titleRuns = runs(before);
  // title tasks after the boot warm-up's hold (the species warm-ups' holds, primes, dry renders)
  const h0 = before.findIndex((f) => !f[6]);
  const h1 = h0 >= 0 ? before.findIndex((f, i) => i > h0 && f[6]) : -1;
  const bootEnd = h1 >= 0 ? before[h1][1] : Infinity;
  const titleTasks = P.longtasks.filter((t) => t[0] >= bootEnd && t[0] < t0);
  return {
    spawnFrame: i0 >= 0 ? F[i0][0] : null,
    revealFrame: i0 >= 0 ? { ms: +F[i0][2].toFixed(1), syncMs: +F[i0][5].toFixed(1) } : null,
    windowMaxFrame: W.length ? +Math.max(...W.map((f) => f[2])).toFixed(1) : null,
    windowSyncMs: +W.reduce((s, f) => s + f[5], 0).toFixed(1),
    longtasks: lt.map((t) => [+(t[0] - t0).toFixed(0), +t[1].toFixed(0)]),
    longMax: Math.max(0, ...lt.map((t) => t[1])),
    firstUse: P.firstUse.filter((x) => x[0] >= t0).map((x) => [+(x[0] - t0).toFixed(0), x[1], x[2], x[3], x[4]]),
    newProgsPlaying: P.newProgs.filter((x) => x.t >= t0 && x.state === 'playing').map((x) => `${x.shadow ? 'shadow:' : ''}${x.obj}:${x.mat}`),
    newProgsCard: P.newProgs.filter((x) => x.t >= t0 && x.state !== 'playing').length,
    gaps,
    holdRuns: runs(F.filter((f) => i0 < 0 || f[1] < F[i0][1])),
    titleHoldRuns: titleRuns,
    titleLongMax: Math.max(0, ...titleTasks.map((t) => t[1])),
    titleLongN: titleTasks.length,
    warms: P.warms.map((w) => [w.obj, +(w.at - t0).toFixed(0), w.state, w.ms ?? null]),
    blocked: P.blocked,
    enemies: (g.enemies?.enemies ?? []).map((e) => e.type),
    state: g.state,
    settling: g.post._settling.length,
  };
}

// One real-rAF reveal page; `start` runs in the page once the title has settled
// (every species in `ready` built, no warm-up pending) and returns its t0.
async function revealPage(page, origin, { blockPrefetch = false, ready = [], start, skipIntroAfter = 0 }) {
  const p = await page.context().browser().newPage({ viewport: { width: 1280, height: 720 } });
  p.setDefaultTimeout(240000);
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  try {
    await p.addInitScript(revealProbe, { blockPrefetch });
    await p.goto(`${origin}/?quality=high`, { waitUntil: 'load', timeout: 60000 });
    await p.waitForFunction(() => window.__game?.state === 'title' && window.__game.time.frame > 2, null, { timeout: 180000 });
    const t0w = Date.now();
    while (Date.now() - t0w < 180000) {
      const st = await p.evaluate((types) => {
        const g = window.__game;
        return { ready: types.map((t) => g.enemies.assets.isReady(t)), settling: g.post._settling.length, hold: g.post._holdUntil > 0 };
      }, ready);
      if (st.ready.every(Boolean) && !st.settling && !st.hold && Date.now() - t0w > 4000) break;
      await p.waitForTimeout(500);
    }
    await p.waitForTimeout(1500);
    const titleWaitMs = Date.now() - t0w;
    const t0 = await p.evaluate(start);
    if (skipIntroAfter > 0) {
      await p.waitForTimeout(skipIntroAfter); // inside the intro's black veil
      await p.evaluate(() => window.__game.director.skipIntro());
    }
    const ts = Date.now();
    let spawned = null;
    while (Date.now() - ts < 200000) {
      const r = await p.evaluate(() => ({ n: window.__game.enemies.enemies.length, frame: window.__game.time.frame }));
      if (r.n > 0 && spawned === null) spawned = r.frame;
      if (spawned !== null && r.frame - spawned > 62) break;
      await p.waitForTimeout(400);
    }
    const r = await p.evaluate(revealReport, t0);
    r.titleWaitMs = titleWaitMs;
    r.errors = errs;
    const lateHolds = r.holdRuns.concat(r.titleHoldRuns.slice(1)); // the first title run is the boot warm-up
    r.maxHoldMs = Math.max(0, ...lateHolds.map((x) => x[1]));
    r.pass = r.spawnFrame !== null && r.longMax <= 100 && r.windowSyncMs < 5 && !r.newProgsPlaying.length && r.maxHoldMs <= 1100 && r.titleLongMax <= 200 && !errs.length;
    return r;
  } catch (err) {
    return { pass: false, error: String(err?.stack || err).slice(0, 600), errors: errs };
  } finally {
    await p.close();
  }
}

export default async function renderChecks(page, { log }) {
  const results = {};
  const origin = new URL(page.url()).origin;

  // ---------------------------------------------------------------- boot warm-up (title)
  {
    const p = await page.context().browser().newPage({ viewport: { width: 1280, height: 720 } });
    p.setDefaultTimeout(180000);
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
    p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
    await p.addInitScript(titleProbe);
    await p.goto(`${origin}/?fixeddt&quality=high`, { waitUntil: 'load', timeout: 60000 });
    await p.waitForFunction(() => window.__game?.state === 'title' && window.__game.time.frame > 2, null, { timeout: 180000 });
    await p.waitForTimeout(+(process.env.RENDER_CHECKS_TITLE_MS ?? 8000));
    const r = await p.evaluate(() => {
      const P = window.__rc;
      const f1 = P.frames[0];
      const held = P.frames.filter((f) => f[4]);
      const holdEnd = held.length ? held[held.length - 1][1] + 1 : f1[1] + f1[2];
      // tasks that start after frame 1 and up to ~0.5 s past the hold: the warm-up's
      const warm = P.longtasks.filter((t) => t[0] > f1[1] + f1[2] - 1 && t[0] < holdEnd + 500);
      const late = P.frames.filter((f) => f[0] > 1 && f[3] > 0).map((f) => [f[0], +f[2].toFixed(1), f[3]]);
      return {
        heldFrames: held.length,
        holdMs: held.length ? +(holdEnd - held[0][1]).toFixed(0) : 0,
        framesWithNewPrograms: late,
        programsAfterFrame1: P.newProgs.filter((x) => x.frame > 1).map((x) => `${x.shadow ? 'shadow:' : ''}${x.obj}:${x.mat}`),
        warmLongtasks: warm.map((t) => [+(t[0] - f1[1]).toFixed(0), +t[1].toFixed(0)]),
        maxWarmTask: Math.max(0, ...warm.map((t) => t[1])),
      };
    });
    r.pass = r.framesWithNewPrograms.length === 0 && r.maxWarmTask <= 200 && !errs.length;
    r.errors = errs;
    results.bootWarmup = r;
    results.godRaysFirst = await p.evaluate(() => {
      const g = window.__game;
      const P = window.__rc;
      g.renderer.setAnimationLoop(null);
      const s0 = P.syncMs;
      const p0 = g.renderer.info.programs.length;
      g.cameraRig.update = () => { g.camera.position.set(0, -22, 12); g.camera.lookAt(0, 0, 0); g.camera.updateMatrixWorld(); };
      let drawn = false;
      for (let i = 0; i < 6; i++) {
        g.frame();
        drawn = drawn || g.post.godRaysPass.enabled;
      }
      const newPrograms = g.renderer.info.programs.length - p0;
      const syncMs = +(P.syncMs - s0).toFixed(1);
      return { pass: drawn && newPrograms === 0 && syncMs < 5, drawn, newPrograms, syncMs };
    });
    await p.close();
  }

  // ---------------------------------------------------------------- stepped checks (autostart page)
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const fast = (n) => ev((n) => {
    const g = window.__game;
    const r = g.post.render;
    g.post.render = () => {};
    try {
      for (let i = 0; i < n; i++) g.frame();
    } finally {
      g.post.render = r;
    }
  }, n);
  await fast(20);
  await ev(() => {
    for (const e of window.__game.enemies.enemies) {
      e.freeze = true;
      e.position.set(0, -400, 0);
      e.velocity.set(0, 0, 0);
    }
  });
  await fast(30);

  results.fishCut = await ev(() => {
    const g = window.__game;
    const fish = g.ambient.fish;
    const cam = g.camera;
    const rig = g.cameraRig.update;
    // just above the seabed, looking straight down: every school is out of view
    const floor = g.env.getSeabedHeight(0, 12);
    const away = () => { cam.position.set(0, floor + 1, 12); cam.lookAt(0, floor - 10, 12.01); cam.updateMatrixWorld(); };
    const out = [];
    for (let s = 0; s < fish.schools.length; s++) {
      g.cameraRig.update = away;
      g.frame();
      const sc = fish.schools[s];
      const culledBefore = !sc.visible;
      const c = sc.center.clone();
      const from = c.clone();
      from.y += 2;
      from.z += 14;
      g.cameraRig.update = () => { cam.position.copy(from); cam.lookAt(c); cam.updateMatrixWorld(); };
      g.frame();
      // the school's first fish is among the instances drawn on this very frame
      const arr = fish.mesh.instanceMatrix.array;
      const m = fish._mat;
      const i0 = sc.start * 16;
      let drawn = false;
      for (let k = 0; k < fish.mesh.count && !drawn; k++) drawn = arr[k * 16 + 12] === m[i0 + 12] && arr[k * 16 + 14] === m[i0 + 14];
      out.push({ school: s, culledBefore, visible: sc.visible, drawn });
    }
    g.cameraRig.update = rig;
    return { pass: out.every((x) => x.culledBefore && x.visible && x.drawn), schools: out };
  });

  results.dodgeBlur = await ev(() => {
    const g = window.__game;
    const u = g.post.underwaterPass.uniforms.uRadialBlur;
    const peaks = {};
    for (const delay of [0, 3, 8, 16]) {
      for (let i = 0; i < 90; i++) g.frame();
      let peak = 0;
      g.events.emit('player:dodge', {});
      for (let i = 0; i < 70; i++) {
        if (i === delay) g.events.emit('player:perfectDodge', { enemy: g.enemies.enemies[0] });
        g.frame();
        peak = Math.max(peak, u.value);
      }
      peaks[delay] = +peak.toFixed(3);
    }
    const max = Math.max(...Object.values(peaks));
    return { pass: max <= 1.0, max, peaks };
  });

  // look-up exposure: luma stats of the canvas (read back right after the render)
  const lookup = async (y, pitch) => {
    await ev(([y, pitch]) => {
      const g = window.__game;
      g.player.position.set(0, y, 12);
      g.player.velocity.set(0, 0, 0);
      g.cameraRig.yaw = -0.35;
      g.cameraRig.pitch = pitch;
    }, [y, pitch]);
    await fast(10);
    return ev(() => {
      const g = window.__game;
      g.camera.updateMatrixWorld();
      g.post._update(6); // let eye adaptation settle
      g.post._update(6);
      g.frame();
      const gl = g.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      g.renderer.setRenderTarget(null); // keep three's cached binding in step
      const y0 = Math.round((100 / 720) * h);
      const y1 = Math.round((650 / 720) * h);
      let n = 0;
      let clip = 0;
      let bright = 0;
      let sum = 0;
      for (let row = y0; row < y1; row++) {
        const r = h - 1 - row; // GL rows are bottom-up
        for (let x = 0; x < w; x++) {
          const o = (r * w + x) * 4;
          const l = 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
          n++;
          sum += l;
          if (l > 215) clip++;
          if (l > 150) bright++;
        }
      }
      return {
        camY: +g.camera.position.y.toFixed(1),
        exposure: +g.post._exposure.toFixed(3),
        clipPct: +((100 * clip) / n).toFixed(2),
        brightPct: +((100 * bright) / n).toFixed(2),
        mean: +(sum / n).toFixed(1),
      };
    });
  };
  const shallow = await lookup(-20, 1.0);
  results.lookupShallow = { pass: shallow.clipPct <= 5, ...shallow };
  const deep = await lookup(-38, 1.0);
  results.lookupDeep = { pass: deep.brightPct >= 5, ...deep };

  // ---------------------------------------------------------------- real-rAF reveals
  if (!/\breveal\b/.test(process.env.RENDER_CHECKS_SKIP ?? '')) {
    results.revealWave0 = await revealPage(page, origin, {
      ready: ['greatWhite', 'tiger', 'megalodon'],
      skipIntroAfter: 2500,
      start: () => {
        const g = window.__game;
        g.debug.god = true;
        const t = performance.now();
        g.director.startGame(0);
        return t;
      },
    });
    results.revealCold = await revealPage(page, origin, {
      blockPrefetch: true,
      start: () => {
        const g = window.__game;
        g.debug.god = true;
        const t = performance.now();
        g.director.startGame(2, { skipIntro: true });
        return t;
      },
    });
  }

  log('render-checks', JSON.stringify({ results }));
}
