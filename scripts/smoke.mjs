#!/usr/bin/env node
// Headless smoke test / screenshot tool. Launches a browser, so ALWAYS run it
// through the machine's heavy-gate, in the background (see AGENTS.md):
//
//   ~/.claude/bin/heavy-gate -n 1 -l smoke -- node scripts/smoke.mjs \
//       --params 'autostart&wave=0&fixeddt' --wait 6000 --shots 3 --interval 1500
//
// Options:
//   --params <query>     URL query string (without '?'), e.g. 'autostart&god&wave=2'
//   --wait <ms>          wait after the game is running before the first screenshot (default 5000)
//   --shots <n>          number of screenshots (default 1)
//   --interval <ms>      delay between screenshots (default 1000; game-time ms with --step)
//   --out <dir>          output directory (default .smoke)
//   --prefix <name>      screenshot filename prefix (default "shot")
//   --size <WxH>         viewport (default 1280x720)
//   --eval <js>          JS evaluated in the page after --wait (repeatable)
//   --scenario <file>    ESM module: export default async (page, { shot, wait, evaluate, log, step }) => {}
//   --dist               serve the production build in dist/ instead of the dev server
//   --gl <backend>       'lavapipe' (default: Mesa Vulkan, multithreaded — much faster for the
//                        full scene and free of SwiftShader's particle seams) or 'swiftshader'
//   --step               stop the page's render loop; time advances only through step(n)
//                        (calls __game.frame() n times). Use with ?fixeddt.
//   --perf               GPU-synced frame timing (implies --step). After the scenario and
//                        shots, for each quality in --perf-q: (re)load the page with that
//                        ?quality, warm up, then time --perf-frames frames, each bracketed by
//                        a readPixels barrier (gl.finish() does NOT wait in Chromium), plus
//                        per-composer-pass timing and renderer.info. Then a deterministic
//                        `frozen` view (enemies parked, VFX cleared, 老公 at the spawn, rig
//                        yaw -0.35 / pitch 0, the same frame re-rendered with realDt 0) —
//                        the fight view depends on random spawns and the AI, so compare
//                        presets on `frozen`. Adds `perf` to the JSON and prints one
//                        "perf <q>: synced p50 … · frozen p50 …" line per quality on stderr.
//                        "GPU stall due to ReadPixels" console warnings are harmless.
//                        Absolute ms on lavapipe depend on machine load; compare presets.
//   --perf-q <list>      qualities to measure, e.g. 'high,medium,low' (default: the page's own)
//   --perf-frames <n>    measured frames per quality (default 120, after 30 warm-up frames)
//   --perf-drive <name>  input driver while measuring: 'fight' (lock on, light combos, heavy,
//                        dodge — default) or 'idle'
//
// Scenario helpers: { shot, wait, evaluate, log, step, page, perf }. With --step, shot()
// renders one extra frame first so the canvas holds a fresh image. `perf` (needs --step or
// --perf): perf.sync() GPU barrier; perf.frames(n, drive?) → {cpu, synced} stats in ms;
// perf.passes(n) → per-pass synced ms / calls / tris; perf.info() → renderer.info summary;
// perf.frozen(n) → the frozen-view measurement (parks the enemies and resets 老公 for good).
// Prints a JSON summary; exits 1 on page errors / console errors.
import { createServer, preview } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

function parseArgs(argv) {
  const out = {
    params: 'autostart&fixeddt', wait: 5000, shots: 1, interval: 1000, out: '.smoke', prefix: 'shot',
    size: '1280x720', eval: [], scenario: null, dist: false, gl: 'lavapipe', step: false,
    perf: false, perfQ: null, perfFrames: 120, perfDrive: 'fight',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--params') out.params = next();
    else if (a === '--wait') out.wait = +next();
    else if (a === '--shots') out.shots = +next();
    else if (a === '--interval') out.interval = +next();
    else if (a === '--out') out.out = next();
    else if (a === '--prefix') out.prefix = next();
    else if (a === '--size') out.size = next();
    else if (a === '--eval') out.eval.push(next());
    else if (a === '--scenario') out.scenario = next();
    else if (a === '--dist') out.dist = true;
    else if (a === '--gl') out.gl = next();
    else if (a === '--step') out.step = true;
    else if (a === '--perf') out.perf = out.step = true;
    else if (a === '--perf-q') out.perfQ = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--perf-frames') out.perfFrames = Math.max(1, +next() || 120);
    else if (a === '--perf-drive') out.perfDrive = next();
    else throw new Error(`unknown arg ${a}`);
  }
  return out;
}

// In-page perf helpers, installed as window.__perf (serialised by page.evaluate,
// so it must be self-contained).
function installPerf() {
  if (window.__perf) return true;
  const g = window.__game;
  const R = g.renderer;
  const gl = R.getContext();
  const now = () => performance.now();
  const r2 = (x) => +x.toFixed(2);

  // GPU barrier. gl.finish() returns immediately in Chromium (the backlog then
  // surfaces as multi-second stalls in later sync calls); a synchronous 1×1
  // readPixels from a private RGBA8 renderbuffer waits for all queued work.
  // Bindings are restored so three's cached GL state stays valid.
  const rb = gl.createRenderbuffer();
  const prevRb = gl.getParameter(gl.RENDERBUFFER_BINDING);
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, 1, 1);
  gl.bindRenderbuffer(gl.RENDERBUFFER, prevRb);
  const fb = gl.createFramebuffer();
  const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
  gl.framebufferRenderbuffer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
  const px = new Uint8Array(4);
  const sync = () => {
    const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
  };

  const stats = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
    return { n: a.length, avg: r2(a.reduce((x, y) => x + y, 0) / a.length), p50: r2(at(0.5)), p95: r2(at(0.95)), max: r2(s[s.length - 1]) };
  };

  // Input drivers. Taps are held for exactly one frame (Input.tap's setTimeout
  // release never fires inside a synchronous frame loop).
  const held = [];
  const tapNow = (a) => {
    g.input.simulate(a, true);
    held.push(a);
  };
  const drivers = {
    idle: null,
    fight: (i) => {
      const inp = g.input;
      for (const a of held) inp.simulate(a, false);
      held.length = 0;
      if (i === 2 && !g.cameraRig?.lockTarget) tapNow('lock');
      const k = i % 90;
      if (k === 10 || k === 22 || k === 34) tapNow('attack');
      if (k === 50) inp.simulate('heavy', true);
      if (k === 75) inp.simulate('heavy', false);
      if (i % 150 === 140) tapNow('dodge');
      inp.simulate('forward', k < 40);
    },
  };

  // n frames, each timed CPU-only (frame() returns) and GPU-synced (barrier after).
  const frames = (n, drive = null) => {
    const fn = typeof drive === 'string' ? drivers[drive] : drive;
    const cpu = [];
    const synced = [];
    for (let i = 0; i < n; i++) {
      fn?.(i);
      sync();
      const s = now();
      g.frame();
      const c = now();
      sync();
      cpu.push(c - s);
      synced.push(now() - s);
    }
    for (const a of held) g.input.simulate(a, false);
    held.length = 0;
    if (fn) for (const a of ['forward', 'heavy']) g.input.simulate(a, false);
    return { cpu: stats(cpu), synced: stats(synced) };
  };

  // Per-pass timing: barriers around each composer pass (inflates the frame
  // total, so measured in separate frames). renderer.info accumulates over the
  // whole frame (PostFX disables autoReset), so per-pass deltas are valid.
  const passes = g.post?.composer?.passes ?? [];
  const acc = new Map();
  let passOn = false;
  // Name passes by the PostFX field holding them (class names are minified in --dist).
  const fieldOf = new Map();
  for (const [k, v] of Object.entries(g.post ?? {})) if (passes.includes(v) && !fieldOf.has(v)) fieldOf.set(v, k);
  passes.forEach((p, i) => {
    if (p.__perfWrapped) return;
    p.__perfWrapped = true;
    const id = `${i}:${fieldOf.get(p) ?? p.constructor?.name ?? 'pass'}`;
    const orig = p.render;
    p.render = function (...args) {
      if (!passOn) return orig.apply(this, args);
      sync();
      const info = R.info.render;
      const c0 = info.calls;
      const t0 = info.triangles;
      const s = now();
      orig.apply(this, args);
      sync();
      const r = acc.get(id) ?? { n: 0, ms: 0, calls: 0, tris: 0 };
      r.n++;
      r.ms += now() - s;
      r.calls += Math.max(0, info.calls - c0);
      r.tris += Math.max(0, info.triangles - t0);
      acc.set(id, r);
    };
  });
  const passTimes = (n = 10, frame = () => g.frame()) => {
    acc.clear();
    passOn = true;
    try {
      for (let i = 0; i < n; i++) frame();
    } finally {
      passOn = false;
    }
    const out = {};
    for (const [id, r] of acc) out[id] = { ms: r2(r.ms / r.n), calls: Math.round(r.calls / r.n), tris: Math.round(r.tris / r.n) };
    return out;
  };

  const info = () => {
    const i = R.info;
    return {
      calls: i.render.calls, triangles: i.render.triangles, points: i.render.points, lines: i.render.lines,
      geometries: i.memory.geometries, textures: i.memory.textures, programs: (i.programs ?? []).length,
    };
  };

  // Deterministic frozen view, comparable between presets and loads (the fight
  // view depends on random spawns and the AI): enemies parked far below the
  // arena, VFX cleared, no lock-on, 老公 reset to WORLD.playerSpawn and the rig
  // held at yaw -0.35 / pitch 0 (the perf review's canonical spawn view) while
  // `settle` frames run without rendering. Then the same frame is rendered `n`
  // times with realDt = 0 and no simulation update, each one GPU-synced.
  const park = () => {
    for (const e of g.enemies?.enemies ?? []) {
      e.freeze = true; // Shark debug flag: no AI / locomotion
      e.position.set(0, -400, 0); // === object3d.position
      e.velocity?.set(0, 0, 0);
    }
  };
  const frozenView = (n = 30, settle = 60) => {
    const inp = g.input;
    for (const a of [...inp.down]) inp.simulate(a, false);
    held.length = 0;
    const rig = g.cameraRig;
    if (rig) rig.lockTarget = null;
    park();
    g.player?.reset?.();
    g.vfx?.clear?.();
    const post = g.post;
    const render = post.render;
    post.render = () => {};
    try {
      for (let i = 0; i < settle; i++) {
        if (rig) {
          rig.yaw = -0.35; // accessors: writes snap the smoothing
          rig.pitch = 0;
        }
        g.frame();
      }
    } finally {
      post.render = render;
    }
    const t = g.time;
    const frame = () => {
      const rd = t.realDt;
      t.realDt = 0;
      try {
        render.call(post, 0);
      } finally {
        t.realDt = rd;
      }
    };
    frame(); // first draw of this view (culling state, lazy uploads)
    frame();
    const cpu = [];
    const synced = [];
    for (let i = 0; i < n; i++) {
      sync();
      const s = now();
      frame();
      const c = now();
      sync();
      cpu.push(c - s);
      synced.push(now() - s);
    }
    const passesMs = passTimes(Math.min(10, n), frame);
    frame();
    const cam = g.camera.position;
    return {
      frames: n,
      syncedMs: stats(synced),
      cpuMs: stats(cpu),
      passesMs,
      info: info(),
      view: {
        state: g.state,
        camera: [r2(cam.x), r2(cam.y), r2(cam.z)],
        yaw: rig ? r2(rig.yaw) : null,
        pitch: rig ? r2(rig.pitch) : null,
        elapsed: r2(t.elapsed),
      },
    };
  };

  window.__perf = { sync, frames, passTimes, info, stats, frozenView };
  return true;
}

// One quality's standard measurement (page already loaded and stepped): the
// live fight (view depends on spawns / AI), then the deterministic frozen view.
function measurePerf({ frames, warmup, drive }) {
  const g = window.__game;
  const P = window.__perf;
  P.frames(warmup, drive); // first-use shader compiles, asset uploads
  const run = P.frames(frames, drive);
  const passes = P.passTimes(10);
  const info = P.info();
  const state = g.state;
  const frozen = P.frozenView(Math.min(60, Math.max(10, frames >> 2)));
  const canvas = g.renderer.domElement;
  return {
    quality: g.quality, qualitySource: g.qualitySource ?? null, state,
    pixelRatio: g.renderer.getPixelRatio(), canvas: `${canvas.width}x${canvas.height}`,
    shadows: g.renderer.shadowMap.enabled, frames, drive,
    syncedMs: run.synced, cpuMs: run.cpu, passesMs: passes, info,
    frozen,
    moduleErrors: [...(g._moduleErrors ?? [])],
  };
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
    srv.on('error', rej);
  });
}

const GL_BACKENDS = {
  swiftshader: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], env: {} },
  lavapipe: {
    args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu'],
    env: { VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/lvp_icd.json' },
  },
};

const opts = parseArgs(process.argv.slice(2));
const backend = GL_BACKENDS[opts.gl];
if (!backend) throw new Error(`unknown --gl ${opts.gl}`);
const [width, height] = opts.size.split('x').map(Number);
mkdirSync(opts.out, { recursive: true });

const port = await freePort();
const server = opts.dist
  ? await preview({ preview: { port, host: '127.0.0.1', strictPort: true }, logLevel: 'error' })
  : await createServer({ server: { port, host: '127.0.0.1', strictPort: true, hmr: false }, logLevel: 'error' });
if (!opts.dist) await server.listen();

// Chromium asks the systemd user manager (over the D-Bus session bus) to move
// itself into its own app-org.chromium.Chromium-<pid>.scope. That escapes the
// heavy-gate scope and its memory cap — one such browser was OOM-killed at
// 7.7 GB, taking the whole machine's memory down with it. Without a session
// bus it stays in the caller's cgroup; browserCgroupCheck() enforces that.
const browser = await chromium.launch({
  headless: true,
  args: [...backend.args, '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  env: { ...process.env, ...backend.env, DBUS_SESSION_BUS_ADDRESS: 'disabled:' },
});

/** Cgroups of every descendant process of this script (i.e. the browser). */
function descendantCgroups() {
  const children = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(+name);
    } catch {
      /* process exited while scanning */
    }
  }
  const cgroups = new Set();
  const stack = [...(children.get(process.pid) ?? [])];
  while (stack.length) {
    const pid = stack.pop();
    try {
      cgroups.add(readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim());
    } catch {
      /* exited */
    }
    stack.push(...(children.get(pid) ?? []));
  }
  return [...cgroups];
}

// Refuse to run if the browser escaped this process's cgroup (and so the gate's cap).
const ownCgroup = readFileSync('/proc/self/cgroup', 'utf8').trim();
const escaped = descendantCgroups().filter((cg) => cg !== ownCgroup);
if (escaped.length) {
  await browser.close();
  console.error(`smoke: browser left the gate cgroup (${ownCgroup} -> ${escaped.join(', ')}); refusing to run`);
  process.exit(2);
}
const summary = { url: null, gl: null, consoleErrors: [], consoleWarnings: [], pageErrors: [], logs: [], screenshots: [], game: null };
let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(180000);
  // Headless Chromium floods a pointer-locked page with synthetic raw mouse moves
  // (~26k pointerrawupdate/s): browser + renderer grow 60-80 MB/s while locked, without
  // bound while a --step evaluate blocks the renderer (a 7.7 GB OOM). Never grant it;
  // Input.requestPointerLock swallows the rejection and the game runs unlocked.
  await page.addInitScript(() => {
    Element.prototype.requestPointerLock = function () {
      return Promise.reject(new DOMException('pointer lock disabled in smoke runs', 'NotSupportedError'));
    };
  });
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') summary.consoleErrors.push(text);
    else if (msg.type() === 'warning') summary.consoleWarnings.push(text);
    else if (summary.logs.length < 60) summary.logs.push(text);
  });
  page.on('pageerror', (err) => summary.pageErrors.push(String(err?.stack || err)));
  const url = `http://127.0.0.1:${port}/?${opts.params}`;
  summary.url = url;
  // Loads `target` and waits until the game loop runs (init is async and staged).
  const open = async (target) => {
    await page.goto(target, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__game?.time?.frame > 2, null, { timeout: 180000 });
    if (opts.step) await page.evaluate(() => window.__game.renderer.setAnimationLoop(null));
  };
  await open(url);
  // Re-check containment now that the GPU/renderer processes exist too.
  summary.browserCgroups = descendantCgroups();
  if (summary.browserCgroups.some((cg) => cg !== ownCgroup)) {
    throw new Error(`browser left the gate cgroup: ${summary.browserCgroups.join(', ')}`);
  }
  summary.gl = await page.evaluate(() => {
    const gl = window.__game.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  await page.waitForTimeout(opts.wait);

  // Advance the simulation n frames synchronously (only meaningful with --step).
  const step = (n = 1) => page.evaluate((count) => {
    for (let i = 0; i < count; i++) window.__game.frame();
  }, n);
  let shotIndex = 0;
  const shot = async (name) => {
    const file = resolve(opts.out, `${name ?? `${opts.prefix}-${shotIndex}`}.png`);
    shotIndex++;
    if (opts.step) await step(1);
    await page.screenshot({ path: file, timeout: 180000 });
    summary.screenshots.push(file);
    return file;
  };
  const evaluate = (js) => page.evaluate(js);
  const wait = (ms) => page.waitForTimeout(ms);
  const log = (...a) => summary.logs.push(a.map(String).join(' '));
  // Perf helpers for scenarios (installed on first use; re-installed after a navigation).
  const perfCall = async (fn, arg) => {
    await page.evaluate(installPerf);
    return page.evaluate(fn, arg);
  };
  const perf = {
    sync: () => perfCall(() => window.__perf.sync()),
    frames: (n, drive = null) => perfCall(([count, d]) => window.__perf.frames(count, d), [n, drive]),
    passes: (n = 10) => perfCall((count) => window.__perf.passTimes(count), n),
    info: () => perfCall(() => window.__perf.info()),
    frozen: (n = 30) => perfCall((count) => window.__perf.frozenView(count), n),
  };

  for (const js of opts.eval) {
    const r = await page.evaluate(js);
    if (r !== undefined) log('eval ->', JSON.stringify(r));
  }
  if (opts.scenario) {
    const mod = await import(pathToFileURL(resolve(opts.scenario)).href);
    await mod.default(page, { shot, wait, evaluate, log, step, page, perf });
  }
  for (let i = 0; i < opts.shots; i++) {
    if (i > 0) {
      if (opts.step) await step(Math.max(1, Math.round(opts.interval / (1000 / 60))));
      else await page.waitForTimeout(opts.interval);
    }
    await shot();
  }
  summary.game = await page.evaluate(() => {
    const g = window.__game;
    if (!g) return null;
    const v = (p) => p && [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)];
    return {
      state: g.state,
      quality: g.quality,
      stats: g.stats,
      danger: +g.danger.toFixed(3),
      moduleErrors: [...g._moduleErrors],
      player: g.player && { pos: v(g.player.position), health: g.player.health, state: g.player.state },
      enemies: (g.enemies?.enemies ?? []).map((e) => ({ type: e.type, pos: v(e.position), health: e.health, state: e.state, alive: e.alive })),
    };
  });
  if (summary.pageErrors.length || summary.consoleErrors.length || summary.game?.moduleErrors?.length) exitCode = 1;

  if (opts.perf) {
    summary.perf = [];
    const qualities = opts.perfQ ?? [summary.game?.quality ?? 'high'];
    for (const q of qualities) {
      if (!['low', 'medium', 'high'].includes(q)) throw new Error(`--perf-q: unknown quality ${q}`);
      // Fresh load per quality (the scenario may have navigated or changed state).
      const u = new URL(url);
      u.searchParams.set('quality', q);
      await open(u.toString().replace(/=(?=&|$)/g, ''));
      await page.waitForTimeout(1500); // idle time: species prefetch, deferred uploads
      await page.evaluate(installPerf);
      const r = await page.evaluate(measurePerf, { frames: opts.perfFrames, warmup: 30, drive: opts.perfDrive === 'idle' ? null : opts.perfDrive });
      summary.perf.push(r);
      if (r.moduleErrors.length) exitCode = 1;
      const s = r.syncedMs;
      const f = r.frozen;
      console.error(
        `perf ${q}: synced p50 ${s.p50} ms (p95 ${s.p95}, max ${s.max}) · cpu p50 ${r.cpuMs.p50} ms · ` +
          `${r.info.calls} calls · ${(r.info.triangles / 1000).toFixed(0)}k tris · ${r.canvas} @${r.pixelRatio} · ` +
          `frozen p50 ${f.syncedMs.p50} ms (${f.info.calls} calls, ${(f.info.triangles / 1000).toFixed(0)}k tris)`,
      );
    }
    if (summary.pageErrors.length || summary.consoleErrors.length) exitCode = 1;
  }
} catch (err) {
  summary.pageErrors.push(`smoke harness: ${err?.stack || err}`);
  exitCode = 1;
} finally {
  await browser.close();
  if (opts.dist) server.httpServer.close();
  else await server.close();
}
console.log(JSON.stringify(summary, null, 2));
process.exit(exitCode);
