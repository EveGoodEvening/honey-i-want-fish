# AGENTS.md

3D underwater action game 「老公，我想吃鱼了」 — three.js + Vite, plain ES modules
(no TypeScript, no framework). Read `docs/DESIGN.md` first: it is the module
contract every file implements.

## Commands

- `npm run dev` — dev server on 127.0.0.1
- `npm run build` — production build to `dist/`
- Headless smoke test / screenshots (launches Chromium — always through the gate,
  in the background):
  `~/.claude/bin/heavy-gate -n 1 -l smoke -- node scripts/smoke.mjs --params 'autostart&fixeddt&god' --wait 6000 --shots 2 --out <dir>`
  See the header of `scripts/smoke.mjs` for `--eval` / `--scenario` / `--dist` options.
  The JSON summary lists console errors, `game._moduleErrors`, player/enemy state.
- Per-module scenarios (run with `--shots 0 --scenario <file>`): `scripts/world-scenario.mjs`,
  `scripts/render-scenario.mjs`, `scripts/player-scenario.mjs`, `scripts/enemies-scenario.mjs`,
  `scripts/enemies-ai-scenario.mjs`, `scripts/enemies-live-scenario.mjs`,
  `scripts/combat-scenario.mjs` (logs pass/fail per combat check), `scripts/audio-scenario.mjs`
  (offline-renders every sound and asserts levels), `scripts/uiflow-scenario.mjs`,
  `scripts/uiflow-flowtest.mjs` (end-to-end flow assertions), `scripts/core-scenario.mjs`
  (input incl. menu-click leaks and intro click-skip / pause-inside-a-frame / quality
  precedence / boot splash + long-task checks; navigates itself; accepts `&quality=` in
  `--params`), `scripts/world-rt-check.mjs` (world into a linear float target).
- Stepped scenarios — `npx vite build` first, then (through the gate, in the background)
  `node scripts/smoke.mjs --dist --step --params 'autostart&fixeddt&god&quality=high' --wait 300
  --shots 0 --scenario <file> --out <dir>` (each header has its exact command); results are
  `log` lines in the JSON summary:
  `scripts/core-parry-spam.mjs` (parry-spam bots vs an idle player, seeded per run;
  `PARRY_SEEDS` / `PARRY_BOTS` / `PARRY_CD=a,b` compare cooldowns; see header),
  `scripts/player-parry-scenario.mjs` (guard, on-cue parries, panic press then on-cue press,
  whiff costs + retry, parry out of a charge / wind-up (`cancel`), light and heavy ripostes,
  spam; `PARRY_CD=a,b` runs the early-press sets per cooldown, `SEEDS=`, `SKIP=`),
  `scripts/enemies-pressure-scenario.mjs` (pacing / pressure / boss set pieces),
  `scripts/enemies-strike-scenario.mjs` (close-range bites: no contact before the telegraph
  end, strike cue ≥ 0.22 s (SharkAI `STRIKE_LEAD`) before contact, on-cue parries),
  `scripts/render-checks.mjs` (render pass/fail: boot warm-up, god rays, fish-school cut, dodge
  blur, look-up exposure, and `revealWave0` / `revealCold`: two production pages on the
  *real* rAF loop — no long task > 100 ms and < 5 ms of synchronous GL queries at the
  great white's / a cold megalodon's reveal, title / card holds ≤ 1.1 s; 1–2 min each on
  lavapipe, `RENDER_CHECKS_SKIP=reveal` skips them; check `uptime` before trusting a
  `bootWarmup` failure),
  `scripts/uiflow-guidance.mjs` (no autostart: `--params 'fixeddt&god&stats&quality=high'`;
  first-time guidance and HUD layout — strike hint on the first two wave-0 cues, tips,
  QTE text, controls panel, intro phone, card / HUD vs the letterbox, centre-word overlap;
  prints `GUIDANCE OK`).
- `node scripts/enemies-sim.mjs [check …] [--runs N] [--quality high|low]` — no browser, no
  gate: the real Player / EnemyManager / CombatSystem / CameraRig on a stub game, ≈20× faster
  than a stepped browser run (pacing checks: `boss-p1`, `gw-idle`, `tiger-idle`, `chase-N`, …,
  `gw-cadence` (wave-0 attacks/min under the great white's murk swings, ≥ 4.3), `boss-snap`
  (the side-snap's `ai.snapping` / cue point), and the strike-cue fairness checks
  `strike-close` / `strike-natural`, `late` = a cue lead under 0.22 s; `STRIKE_KIND=ram` for
  rams; list in its header).
  Good for sweeps over many seeds; the browser scenarios stay the acceptance reference. `node scripts/core-parry-sim.mjs [spam] [cue] [--seeds N] [--cd a,b]
  [--variants file.json]` is the same stub game running the parry-spam bots and the
  early-press cue trials, with cooldown / fatigue / retry variants patched onto the player
  (`{"retry": false}` = no round-3 retry after a lone whiff).
- More no-browser, no-gate checks (Node, real modules on stubs, seeded):
  `node scripts/combat-camsim.mjs [whip|dying|bosscue|bossboom|victory|victorywall|breather …] [--seeds N]`
  (CameraRig + cinematics on the enemies-sim stub at 1280×720: lock whip-pans, the dying
  beat, boss jaw framing at close cues, the boom near the seabed under the boss, the victory
  shot from a chase-bot kill — `victorywall` moves that kill under the reef wall — with its
  composition (corpse bbox / x / broadside / look-up, 老公's height, sight lines through
  rock), the breather levelling; `## <check> {…, pass}` lines; a fresh stub game per check,
  every species built before the seeded runs, so a check reads the same alone or after others),
  `node scripts/render-whale-sim.mjs [poses=400] [--rmax 50] [--diag]` (share of the boss
  breather the whale pass spends on screen for random follow-camera poses; exits 1 under
  60 %), `node scripts/world-checks.mjs` (the real Environment per quality: every reef-wall
  strip whose shadow comes within 50 m casts, the warm-up frame draws the whole wreck,
  grass min-width attribute, kelp / grass near fade patched in, scenery triangle totals;
  exits 1 on a failure),
  `node scripts/player-headview.mjs [out.png] [--q high] [--views 0,1,2,3,4]`
  (software-rasterised preview of 老公's head with its textures plus a clay row, and its
  build times — iterate on the sculpt in seconds, then judge in game through the gate),
  `node scripts/enemies-sharkview.mjs [out.png] [--species megalodon,greatWhite] [--views
  0,1,2,3,4,5,6] [--fov 55] [--clay]` (the same for the sharks: rest-pose body, fins, teeth
  and painted skin under a rough underwater light — head-on, 3/4, from below, pectoral,
  side, head profile; one row per species).
- `node scripts/core-quality-check.mjs` — no browser: GPU-string → quality mapping and
  URL > saved > debug > detected precedence.
- GPU-synced perf (through the gate): `node scripts/smoke.mjs --dist --perf --perf-q high,medium,low
  --params 'autostart&fixeddt&god' --shots 0` → `perf` in the JSON plus one
  `perf <q>: synced p50 … · frozen p50 …` line per quality on stderr. Compare presets on
  `perf[].frozen` (deterministic view); the fight numbers depend on spawns / AI. Scenarios
  also get a `perf` helper (`perf.frames(n, 'fight')`, `perf.passes(n)`, `perf.info()`,
  `perf.sync()`, `perf.frozen(n)`).

## Conventions

- Each subsystem is one class constructed as `new X(game)` with `update(dt)`;
  cross-module communication goes through `game.events` (see the events table
  in DESIGN.md) or the documented public methods — never reach into another
  module's private (`_`-prefixed) fields.
- Reuse module-level temp vectors in hot paths; no allocations per frame.
  Callers pass reused temp vectors to `vfx.spawn*`, so receivers must copy them.
- All assets (meshes, textures, sounds) are procedural — no binary assets.
- UI text is Chinese.
- Commit messages must not contain Claude/AI attribution lines (a PreToolUse hook blocks such commits).

## Lessons

- README screenshots live in `docs/screenshots/`: actual high-quality game renders,
  1600×900 JPEGs. These are documentation-only; the procedural-assets rule applies to
  runtime meshes, textures and sounds, not screenshots.
- UI naming spans more than selectors: keep the `.fish` root, `fish-*` classes and
  keyframes, SVG filter IDs / CSS URLs, reduced-motion rules and browser scenarios in
  sync. Quality is saved under `fish.quality`; earlier preference namespaces are not imported.
- Native CDP verification needs an existing page target before attachment. In this
  harness, `tab.run`'s `page.evaluate` sees the DOM but not the game's main-world
  `window.__game`; use `tab.evaluate` for game state. Resize an attached page with
  `page.setViewport` rather than relying on `browser.open`'s viewport option.

- Story labels also reach procedural assets and timing: `Wreck._makeNameDecal` paints
  the hull registration, PlayerModel's IBL uniform name must match its injected GLSL,
  and AudioEngine arms the intro fallback only for the husband's subtitle. A story
  migration smoke should exercise both the normal dive cue and the missing-cue fallback.

- Chromium moves itself into its own `app-org.chromium.Chromium-<pid>.scope` via the D-Bus
  session bus, escaping heavy-gate's cgroup and memory cap (one lavapipe browser was
  OOM-killed at 7.7 GB). `scripts/smoke.mjs` launches it with
  `DBUS_SESSION_BUS_ADDRESS=disabled:` and refuses to run if any browser process leaves the
  gate cgroup (`summary.browserCgroups`). Any other launcher must do the same.
- The 7.7 GB growth itself was not a game leak: headless Chromium floods a pointer-locked
  page with ~26k synthetic `pointerrawupdate`/s (browser + renderer +60–80 MB/s each, never
  drained while a `--step` evaluate blocks the renderer). `smoke.mjs` stubs
  `Element.prototype.requestPointerLock` in an init script; custom launchers must too (or
  pass `?freemouse`). Repeated retries / victory loops / 5 min of play stay flat in memory.

- Versions: `three@0.186.1`, `vite@8.3.2`, `playwright@1.63.0` (Chromium revision 1243 is
  already in `~/.cache/ms-playwright`).
- A hook-blocked Bash command runs none of its parts. Don't bundle file edits with a
  `git commit` in one command; if a commit is blocked, re-check that the edits exist.
- Headless Chromium renders WebGL via SwiftShader (`--use-angle=swiftshader
  --enable-unsafe-swiftshader`); use `?fixeddt` in smoke tests so simulation
  advances deterministically even at low real fps. `game.stats.fps` reports the
  real measured frame rate. Under `fixeddt`, game time ≠ wall time: UI input gates and
  CSS animations run on wall time.
- SwiftShader sometimes draws straight-edged cut-outs inside dense alpha-blended particle
  clouds; that's a rasteriser artifact. To judge particle visuals use Mesa lavapipe:
  Chromium flags `--use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist --enable-gpu`
  with `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json` (still through heavy-gate).
- The dev server's optimised-deps cache can reload the page mid-smoke ("504 Outdated
  Optimize Dep") when `node_modules` is shared/symlinked across worktrees; use `--dist`
  after `npm run build`, or wait until `__game.time.frame` advances.
- Smoke JSON logs are prefixed by heavy-gate queue messages; parse from the first `{` line.
  Quote `--params` with single quotes (`'autostart&fixeddt'`).
- Only WenQuanYi Zen Hei is installed for Chinese in headless; screenshots show sans text
  where real machines get the serif stack.
- Never bind Ctrl to a gameplay action: Ctrl+W closes the browser tab.
- three@0.186: `PCFSoftShadowMap` was removed (falls back to `PCFShadowMap` with a console
  warning); use `PCFShadowMap` and soften with `light.shadow.radius`.
- The world module overrides three's fog shader chunks globally (view-dependent water colour).
  Any custom `ShaderMaterial` with `fog: true` must include `<fog_pars_vertex>`/`<fog_vertex>`
  with a `vec4 mvPosition` in scope, as stock three expects.
- Underwater lighting needs a strong diffuse fill (hemisphere ≈ 9× the horizontal water colour)
  next to the sun, or surfaces facing away from the sun render near-black.
- With a dark impulse response, a WebAudio `ConvolverNode` with `normalize=true` boosts lows
  by ~14 dB; normalise the IR by hand to a fixed energy and high-pass the reverb input.
- PostFX: chromatic aberration must run in display space (after tone mapping); in HDR it
  splits bright sparkles into pure R/G/B pixels. `pulse('hit'|'heavyHit')` = player hurt;
  `pulse('strike'|'crit')` = player landed a blow.
- CSS: a `.root h2 {margin:0}` reset beats single-class component rules; use `:where()` for resets.
- In worktree-isolated agent sessions, complex Bash (heredocs, loops, paths outside the
  worktree) may be refused; put helper logic in script files and run simple commands.
  `git -C <other worktree>` is refused too, but other worktrees can be read (`diff -rq`,
  Read). To measure the *merged* behaviour of parallel fixers before the merge (e.g. for
  the docs), extract `git archive HEAD` into the scratchpad, copy each worktree's owned
  files over it in module order, and symlink `node_modules`. The Node sims (`enemies-sim`,
  `core-parry-sim`, `.smoke/*` harnesses importing `../../src`) run there unchanged.
  `.smoke/` is git-ignored and lives only in the main checkout: to run a harness against a
  worktree's code, copy it into that worktree's `.smoke/<dir>/` (same depth).
- Docs written before the parallel fixers merge drift: round 3's docs derived a 0.22–0.32 s
  cue lead from the constants; the merged enemies code measures 0.23–0.40 s (contact often
  comes later than the forecast `eta`). Re-measure on the merged tree before
  quoting numbers — the Node checks take seconds (`enemies-sim strike-close` ≈1.5 s,
  `core-parry-sim spam cue --seeds 16` ≈17 s).
- GPU timing: `gl.finish()` is NOT a sync point in Chromium (it returns at once; the
  backlog then surfaces as multi-second stalls in later `getProgramParameter` calls). Time
  GPU work with a 1×1 `readPixels` barrier from a private RGBA8 renderbuffer FBO
  (`smoke.mjs --perf`), restoring the bindings for three.
- `renderer.setPixelRatio()` + resize does not resize `EffectComposer`: it caches the pixel
  ratio in its constructor and `reset()`; call `composer.setPixelRatio()` too.
- three's `renderer.compile()/compileAsync()` key programs on the currently bound render
  target (tone mapping / output colour space differ between canvas and RT). Warm up with
  PostFX's scene target bound (`post.warmup(object)`), or the first real frame still compiles.
- GLSL `pow(x, y)` with negative `x` is NaN (black/white specks), and MSAA can evaluate
  varyings outside the triangle, i.e. past [0, 1] — clamp before `pow`.
- A `requestAnimationFrame` callback runs *before* that frame's paint; to let the browser
  paint between chunks of work, queue a task from inside the rAF (`Game.init`'s `nextPaint`).
- `game.init()` is async and `window.__game` exists before the modules do: harnesses must
  wait for `__game.time.frame > 2` / a non-`'boot'` state, not just `__game`.
- `player:attack` fires when the swing goes live (after its ≈0.13 s wind-up), not on the
  button press: step ≥ 10 frames before asserting it.
- Quality default: without `?quality`, harness runs stay on `high` only because they pass
  `autostart` or `fixeddt`; a plain headless load (lavapipe/SwiftShader) detects `low`, and a
  `localStorage['fish.quality']` written earlier in the same browser context wins over both.
  Pass `?quality=` explicitly when a check depends on the preset.
- three@0.186 R11F_G11F_B10F render target: set `texture.format = RGBFormat` plus
  `texture.internalFormat = 'R11F_G11F_B10F'` (RGBA is an invalid combination).
- three@0.186 program cache: values that differ per instance/species but are injected via
  `onBeforeCompile` must be uniforms — `customProgramCacheKey` is shared, so baked-in
  constants leak from one material to another.
- three@0.186: MeshStandard/Physical with an `envMap` adds IBL *diffuse* light that ignores
  depth absorption (pale "glove" skin underwater); tint `iblIrradiance`/`radiance` per frame.
- Arena-wide InstancedMeshes are never frustum- or shadow-culled. Bake static props per
  spatial cell into merged meshes; per-camera visibility/LOD/`castShadow` toggles belong in
  `scene.onBeforeRender` (Environment chains it — chain, never replace, that handler).
- Lazy culling creates shader-compile hitches for pieces first seen mid-play: warm up with
  one frame that draws everything (`frustumCulled = false`, every LOD material in use).
- Distance fog must not fully veil Snell's window (a wide bright source: in-scatter replaces
  most out-scatter); the fog curve is shared via `FOG_TAU_GLSL` in `src/world/waterShading.js`
  — any hand-written fog (VFX, jellyfish, whale, shafts) must use it.
- Sub-pixel geometry (a knife edge-on) breaks into MSAA dashes; draw it as a screen-space
  ribbon with a fixed pixel width.
- Big-shark AI: test "target inside the turning circle" and brake or head-whip, or a chasing
  player is orbited forever; aim the body axis but judge "lined up" from the jaws. Never
  push the player with the bow wave ahead of the jaws (it shoves them out of every bite).
- Chrome's DynamicsCompressorNode adds automatic make-up gain (~+6 dB on a −16 dB/3:1 glue);
  trim into the master chain instead of chasing individual sound levels.
- `smoke.mjs --dist` (vite preview) doesn't serve `/src/*`; scenarios that import source
  modules must `page.route` them (only dependency-free modules such as `src/audio/*`).
- In `--step` scenarios: drive time with `__game.frame()` (rAF never fires), wait on game
  state / game clock, not wall-clock sleeps (except wall-clock menu arming and CSS reveals);
  after a `page.goto` inside a scenario, call `__game.renderer.setAnimationLoop(null)` again.
  For pixel A/B shots, render the same frame twice with `game.time.realDt = 0`.
- Don't rebuild `dist/` while a gate-queued `--dist` run hasn't loaded its page yet.
- Wait for a gated background run with `timeout N tail -f log | grep -m1 '^{'` (foreground
  `sleep` is blocked). The gate hook also blocks commands that merely *name* the browser
  script (e.g. `node --check scripts/smoke.mjs`) or contain browser-launch text in a heredoc;
  edit such files with the Edit/Write tools.
- In Playwright, `page.context().newPage()` throws for a page made by `browser.newPage()`;
  use `page.context().browser().newPage({ viewport })`.
- Many rendered `__game.frame()` calls inside one `page.evaluate` queue seconds of GPU work
  on lavapipe; until it drains the page's rAF stalls, so a following `page.click` times out
  on "waiting for element to be visible, enabled and stable". Stub `post.render` for
  simulation-only stepping, or drain with a 1×1 `readPixels` before clicking.
- Simulation-only stepping (`post.render` stubbed) runs ≈2.5 s wall per 100 s of game time
  (high, lavapipe), so balance questions can afford 8+ seeded runs per cell (seed
  `Math.random` per run, e.g. mulberry32). Single runs vary ±30 % — never tune on one.
- `Game.frame` re-reads `game.state` after `director.update`: a pause pressed inside a frame
  skips that frame's simulation (dt 0, no `time.elapsed` step), so simulation modules never
  see `'paused'`. `time.elapsed` advances after `director.update`.
- Input ignores mouse buttons on menu screens (title / pause / death / victory) but must
  keep them in `'intro'`: the intro's click-to-skip is the Director reading mouse `attack`.
  Don't gate mouse input to `'playing'` only.
- Parry spam: a bot's parried share ≈ (window + 0.5 m / lunge speed) / press period, and its
  survival ≈ 1 / (1 − share) × idle — a cooldown-paced masher can beat that against some
  patterns (phase-locks with the tiger pair). With whiff costs, the spam fatigue — not the
  cooldown — sets the ceiling: under round 2's fatigue (no grace, drain 1/s) a press every
  1.3 s kept full windows and lasted ≈1.3–1.4× idle at *any* cooldown, and at cooldown 0.6 a
  masher reached 1.4–1.8×. Once fatigue cuts windows to ≈0.05 s, the 0.5 m parry
  generosity (2–5 frames of lunge) dominates, so only a longer press period helps further:
  the cooldown (masher vs tigers ≈1.3× at 0.45 s, ≈1.2× at 0.6 s). A whiff recovery growing
  0.15 s per fatigue changed nothing (Node, 128 seeds at 0.45 s: 15–20 % parried either way): it
  stayed under the cooldown. A long cooldown double-punishes a single panicked press: it
  swallows the on-cue press (cooldown 1.2: a press 0.6 s before a great white's telegraph
  ends → 0/6 parried). Even at 0.6 s a press 0.10–0.55 s before the telegraph end doomed
  the on-cue press: the cooldown *and* the 0.15 s whiff lock bind, so waiving only the
  cooldown moved the edge by ≈0.1 s. Round 3's fix is a retry rule (the first press after
  a lone, unfatigued whiff skips both), not a shorter cooldown: in Node the masher and the
  0.4 s bot stayed ≤ 1.23× with it (`core-parry-sim.mjs`, 16 seeds; `{"retry": false}`
  variant for the A/B; ≤ 1.22× on the merged round-3 tree, seeds 1–32).
  Never-attacking spammer history: 3–5× at cooldown 0.4 with no whiff costs.
- Close-range bites used to land on the first attack frame with no `enemy:strike`: the bite
  wind-up kept swimming at 老公 (cruise × 0.5 plus approach momentum), so jaws that started
  2–4 m off already overlapped him when the volume went live, and Combat's gap/speed cue
  needs `d > rr` (and underestimates an accelerating lunge or a head whip). Fix: SharkAI
  forecasts its strike (`getStrikeCue()`), Combat cues at eta ≤ `STRIKE_ETA`, and the volume
  goes live only `STRIKE_LEAD` after the cue; close wind-ups hover, then gape. Round 2 used
  0.25 / 0.16 s: fair, but the reaction budget was 0.15–0.2 s, so a bot reacting in 0.2 s
  (a typical human cue reaction is 0.2–0.25 s) lost the tigers 5/16 and the boss 15/16.
  Round 3: 0.32 / 0.22 s, gape up to 0.3 s; contact then comes 0.23–0.40 s after the cue
  (not 0.22–0.32: `eta` is a forecast, and gapes / changes of course land later), and a
  press up to 0.2 s after the cue parries every species and kind. Never activate a bite /
  ram volume directly in `_startAttack` again. Measuring "contact before the telegraph
  end" from a pre-frame hook reads one frame early; take times from Combat's own
  resolution (wrap `combat._hitLedger.add`), as `enemies-sim strike-*` do. Two follow-ups:
  - A gape that brakes to 0.3 m/s and only goes live once it ends lets a diver swimming at
    4–5 m/s slip through the open jaws ("ghost bite", 9 % of great-white swim-ins). Let it
    snap early once the cue has led by `STRIKE_LEAD` with him already in the jaws.
  - `enemy:attack` is read as "the lunge starts" by Audio (lunge rush), CameraRig (attack
    trauma, boss dolly release) and PostFX (tunnel release), so a gaped bite emits it at
    the snap, not at `_startAttack`.
- Forced-kind trials: SharkAI turns a ram into a bite when the jaws are within 7 m during
  the approach (and at the end of the wind-up when the snout is already within the ram's
  reach). A ram placed 2–4 m off never runs as a ram (round 2's `enemies-sim strike-close`
  with `STRIKE_KIND=ram` produced 240 bites and 0 rams), and god-off forced-ram waits get
  killed by bites. Place rams ≥ 8 m off or start the wind-up directly
  (`ai._startTelegraph('ram')`), as `strike-close` now does for rams.
- First-use stalls only show on the *real* rAF loop. `--step` and `--perf` sync the GPU
  every frame, so there is never a backlog. A program's first draw (three's
  `getUniforms` → link check + reflection) waits for every queued frame, which cost 0.7–0.8 s
  at the shark reveal on lavapipe while every stepped harness read 7–27 ms. PostFX only
  primes programs on an idle GPU, and a GPU-bound loop never is, so it holds title, intro
  and card frames for it. Measure on a production page (`/?quality=high`, no `fixeddt`)
  with long tasks, rAF gaps, and time spent in `getProgramParameter` / `getUniformLocation`
  / `getActiveUniform` (wrap the WebGL2 prototype in an init script), as
  `scripts/render-checks.mjs` `revealWave0` / `revealCold` do.
- `renderer.compile()` / `post.warmup()` never builds shadow-depth variants, and three still
  frustum-culls against the shadow camera, whose box differs per preset (±42 m high, ±36 m
  medium). The boot warm frame must draw every caster with culling off. The wreck net (the
  only alpha-tested, double-sided caster) compiled mid-fight on medium only.
- The shark skins are `THREE.ExternalTexture`s around raw GL textures (`SharkAssets`
  uploadTexture), with their pixels dropped. `renderer.info.memory.textures` doesn't count
  them (≈18 MB plus mipmaps per species on high, so texture numbers aren't comparable with
  rounds before enemies-r6), and three can't restore them after a context loss:
  `SharkAssetLibrary` repaints and re-uploads them on `webglcontextrestored` (and never
  binds or deletes a lost GL texture). Anything else built on raw GL textures must do the
  same.
- Objects of a lost context answer nothing after the restore: `getProgramParameter` /
  `getSyncParameter` on them return `null` ("object does not belong to this context"), so a
  warm-up waiting on them never ends. PostFX drops every pending job on `webglcontextlost`
  (never deleting the dead syncs) and re-runs the boot warm-up on restore. Test with
  `WEBGL_lose_context` while a warm-up is pending (a production page with every prefetch
  blocked, as `render-checks` `revealCold`, right after `startGame(2)`). Note a
  `post._settling` job made *in play* stays pending until the next card by design (a
  GPU-bound loop is never idle), so `_settling.length > 0` while playing is not "stuck".
- CSS / WAAPI animations (combat words, wave cards, the victory and death screens, the boot
  splash) run on the wall clock, and a lavapipe screenshot on a shared box can take seconds.
  In `--step` DOM shots, seek them first: `root.getAnimations({subtree: true})` → `pause()`
  → `currentTime = s × 1000`. An animation created inside a long stepping `evaluate` takes
  its start time from the frozen document timeline and may be finished by the next frame;
  pin it in the same evaluate. Paused opacity / transform animations live on the
  compositor, so wait two rAFs before the screenshot. Otherwise "+1.5 s" shots show
  finished panels and stale combat words.
- `Game.frame` runs `env.update` (depth lighting, from `camera.position`) before
  `cameraRig.update`, so the first frame after a *scripted* hard camera cut renders with
  the old depth's water colour. Step one more frame before a pixel check (in play every
  camera change blends).
- Camera tracers that clear their sample array must also reset their "have previous" flag,
  or the first new sample compares against stale values (fake 3 rad / 38 m "snaps").
- Judge the victory shot (and any kill framing) from a realistic kill: a parry then a
  riposte, or the chase bot. An instant 99999-damage kill at range never shows the corpse
  filling the frame or coasting 35–50 m away after a kill at speed.
- Lock-on tracking gain from 3D distance whip-pans (6–9 rad/s) whenever the target is
  within ~4 m or overhead, where its bearing spins: after every grab release and on boss
  passes. Use horizontal distance, cap the turn rate and hold the yaw up close.
- Face-tanking: sharks that bolt when cut let a no-defence lock-on masher win (great white
  8/8, tigers 6/8); escape-stab damage was not the lever (halving it: still 16/16 and 14/16
  in Node). The fix is a counter (bite / tail answer to repeated hits near the head).
- The knife trail is `vfx.trail.ribbons[]` (two `Ribbon`s, each with a `mesh`); there is
  no `vfx.trail.mesh`.
- `enemy:strike`'s `eta` is in game seconds; Audio schedules in real seconds, so under
  slow-mo / hitstop a sound timed to eta peaks early.
- Balance sweeps: `scripts/core-parry-sim.mjs` (the `enemies-sim` stub game, seeded with
  mulberry32, variants patched onto the player instance) runs 32 seeds × 30 bot cells in
  ≈4 min without the gate. Cells can still disagree with the browser (same seeds, different
  fights: a cooldown-0.6 masher vs the tiger pair under round 2's fatigue parried 23 % in
  Node, 40 % in the browser), so narrow in Node, accept in the browser with ≥ 16 seeds;
  even 16-seed browser medians move ±0.1–0.15× (the same 2 s bot, where the cooldown never
  binds, read 1.16× and 1.34× in one run). Seeding doesn't make runs repeatable: the idle
  baseline of the same seed moves too (state carried over from earlier runs, e.g. game time),
  so compare cells within one run and pool runs before deciding.
- `player-parry-scenario.mjs` trials start pressing at the telegraph start: a `pre` earlier
  than the wind-up (great white bite 0.78 s) goes in on its first frame.
- Shark heads that read as a dolphin / beluga: an elliptical nose cap that ends flat while
  the profile keeps widening behind it leaves a crease ring (a beak), a white snout
  underside reads as a pale muzzle, gill slits reaching −50° wrap under the throat like
  whale pleats, and markings sized × body length (the axillary spot) blow up on the 16 m
  boss. Give markings absolute sizes; preview with `scripts/enemies-sharkview.mjs` (Node,
  seconds) before spending a gated run on frozen shots.
- A side-snap cues on its first attack frame, so `getStrikeCue()` is null for the rest of
  it; anything framing a snap reads `ai.snapping` / `ai.snapPoint`.
- Node sims: a shark species' first build draws on `Math.random`, so whichever seeded run
  builds it shifts every later fight, and the camera steers the simulation too (treading
  老公 turns with it): any camera change reshuffles the fights. Round 4's `combat-camsim`
  passed `bossboom` alone and failed it after `whip dying` (老公 shoved against the reef
  wall, the boom wedged at 0.45 m — the baseline does it too, ~1 seed in 48). Build every
  species before seeding, use a fresh stub per check, and judge camera changes over 24–48
  seeds.
- Boss side-snap framing: 老公 sits beside the gills (≈1 m behind the head pivot, 2 m out,
  2 m under), so the body-centre lock looks at the boss head-on and the cocked snout (the
  reticle's head hurtbox, 2.3 m ahead of the pivot) hangs over the lens. Centring a point
  between the pivot and 老公 doesn't help (it lies nearly straight above him, so the yaw
  solve is ill-conditioned), nor does FOV alone; what worked: look across the head from his
  flank and pull the boom out (dolly-in → 8 m) — 61 → 92–95 % of close cues.
- Victory-shot occlusion: test sight lines to several spheres along the corpse, not its
  centroid with a generous end margin — a corpse sliding down the reef-wall face behind the
  plateau lip showed one fin over a sand ridge while the centroid line "cleared" (browser,
  kill on the plateau near the surface). The shot is also re-checked twice a second (corpse
  hidden / out of frame / sunk), since the pick at the cut can't foresee the slide. Stub-env
  camsim runs miss the reef wall's crags (only its heightfield ramp exists there), so
  cinematics' `solidAt` adds a margin in front of `cliffRadius`.
- three@0.186 `material.alphaToCoverage`: drops the `OPAQUE` define (the fragment alpha is
  written and becomes MSAA coverage), does nothing on a single-sampled target (low preset,
  `noPost` canvas: dither + `discard` there), and makes WebGLShadowMap set `alphaTest = 0.5`
  on that mesh's shadow-depth material — a `customDepthMaterial` too — i.e. another
  depth-program variant. Keep camera-distance fades out of shadow-depth shaders (they'd be
  measured from the light's camera and cut holes in the shadow).
- Near-camera foliage fade: a vertex taper (blades narrowed to their centre line) was tried
  against the dithered alpha-to-coverage fade and lost — long near blades became dark
  1–2 px hairlines across the frame. Judge such fades on stills of one frame rendered with
  the fade uniform on / off (`env.vegetation.uniforms.uKelpNear` / `uGrassNear`); lavapipe
  frame times swing ±15 % between runs, so don't read a cost from one cross-run comparison.
- Published third-party license notices live in `public/THIRD_PARTY_NOTICES.txt`:
  Vite copies this file to the root of `dist/`, and Pages publishes only `dist/`.
  Keep the three.js version and complete upstream `node_modules/three/LICENSE` text
  in sync when upgrading three; a repository-root notice alone is not published.
  The title's license panel fetches it through `import.meta.env.BASE_URL`: Pages
  builds with a repository subpath, so a hard-coded root URL would miss the file.
