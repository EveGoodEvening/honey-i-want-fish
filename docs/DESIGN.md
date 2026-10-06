# 老公，我想吃鱼了 — Design & Module Contract

A 3D underwater action brawler built with three.js (WebGL, `three@0.186.1`, Vite 8).
老婆 calls with a dinner request — *"老公，我想吃鱼了。"* — and 老公 takes it far too
seriously: he dives into the East China Sea with a fish-gutting knife to fetch an
absurdly large dinner. The couple are independent fictional characters; the story
is a domestic errand turned underwater adventure. He can breathe underwater
indefinitely; there are no air/oxygen mechanics.

All characters are original procedural models — no actor likenesses, no
external art assets. Everything (meshes, textures, audio) is generated in code.

## Pillars

1. **Realistic underwater look.** Light absorption (reds die first, everything
   shifts teal → blue-black with distance and depth), exponential fog with
   ~50 m visibility, sun shafts piercing from the surface, caustics rippling
   over the seabed and bodies, drifting marine snow, suspended particulate
   catching light, Snell's window on the surface overhead. ACES tone mapping,
   physically based materials, no cartoon colours. Blood at depth reads dark
   green-black, not bright red (red light is absorbed).
2. **Tension and pressure.** You rarely see the whole threat. Sharks circle at
   the edge of visibility as silhouettes, then commit. Telegraphs are readable
   but fast. Heartbeat, low drones, vignette and muffled sound rise with the
   `game.danger` level. The megalodon is *huge* (≈16 m) — the camera, audio
   and screen effects must sell its scale (it blocks the light when it passes
   overhead, its wake pushes you, its jaws fill the screen).
3. **Weighty melee.** Hitstop, camera trauma, knife trails, blood clouds,
   water-resisted motion (everything has drag and inertia), parry → punish,
   perfect dodge slow-mo, a grab QTE where 老公 stabs the shark's eye to escape.

## Story / flow (Director + UI)

- **Title**: dark water, light shafts, the phrase 「老公，我想吃鱼了」 in large
  serif type, the subtitle 「深海 · 晚餐」 and location 「东海 · 外海」; a button 「下水」
  (dive), controls and quality options. 「第三方许可」 opens a scrollable panel displaying
  the complete published `THIRD_PARTY_NOTICES.txt`; Esc / Enter / 返回 closes it.
- **Intro** (skippable, ~10 s): phone-call subtitles —
  老婆：「老公，我想吃鱼了。」 → 老公：「好嘞，晚饭交给我！」 → camera dives with
  bubbles into the arena. The caller shown on the phone is 老婆.
- **Waves** (`WAVES` in `src/core/config.js`):
  1. 第一条鱼 · 大白鲨 (great white, ~6 m)
  2. 第二条鱼 · 虎鲨群 (two tiger sharks, ~4.5 m, faster, flanking)
  3. 最后一条鱼 · 巨齿鲨 (megalodon boss, ~16 m, multi-phase)
  Between waves: a short breather (title card + subtitle), heal 35 % of max HP.
  In the breather before the megalodon wave a sperm whale crosses the camera's view
  ~30 m out — fogged, nearly water-coloured, about a third of the frame wide — while the
  camera levels toward the horizon to show it (ambient, non-combat — "something even
  bigger lives down here").
  老公 reacts: 「这条……家里的锅装得下吗？」; the boss card reads 「这条，够吃一整年。」.
- **Death**: 「鱼没吃上。」 → retry the current wave (Enter / click).
- **Victory**: 「老婆，开饭了！」 / 「今晚吃鱼 · 明天也吃鱼」 + stats (time, damage dealt, parries).

## Controls (`src/core/Input.js` — already implemented)

| Action | Keys | Notes |
|---|---|---|
| forward/back/left/right | WASD / arrows | camera-relative; forward includes camera pitch (true 3D swimming) |
| up / down | Space / C | vertical swim |
| dodge | Shift | burst dash with i-frames; costs stamina |
| attack | LMB / J | light knife slash, 3-hit combo |
| heavy | RMB / K | hold to charge a thrust stab, release to strike |
| parry | E / L | short window; a parried bite/ram stuns the enemy; cancels a heavy charge and a swing's wind-up / recovery (see Parry) |
| lock | Q / Tab / MMB | toggle: lock on to the on-screen enemy nearest the screen centre within 60 m (else the nearest within 60 m), or release the lock (it never cycles targets; no new lock while 老公 is dead) |
| pause | Esc / P | |
| confirm | Enter | menus |

During a **grab**, mash `attack` (LMB / J) to stab the shark's eye and break free.

Mouse buttons only act in play (`'playing'` / `'transition'`) while the pointer is locked
(or with `?freemouse`), and in the intro, where a click skips it. Play can be running
unlocked — resuming the pause menu with Esc can't re-lock, because browsers don't grant
pointer lock from a key press — and then the first click on the canvas only re-captures the
mouse (UI requests the lock); it does not also slash. On menu screens (title, pause, death,
victory) mouse buttons press nothing: a menu button's mousedown and click land between the
same two frames, so a pressed `attack` would otherwise slash on the first frame after
继续 / 再来一次 / 重新开始本关. Mouse-ups always release.

## Coordinate system & world

- Y up, metres. Water surface plane at `WORLD.surfaceY = 0`.
- Seabed around `WORLD.floorY = -46` with relief; query `env.getSeabedHeight(x, z)`.
- Arena: soft horizontal radius `WORLD.arenaRadius = 110` around the origin.
  Player spawns at `WORLD.playerSpawn` (y = -20).
- Player body ≈ 1.75 m. Great white ≈ 6 m. Tiger ≈ 4.5 m. Megalodon ≈ 16 m.
- three.js `Object3D.lookAt` on non-camera objects points +Z at the target.
  Each module must document its own model's forward axis and keep
  `forward` vectors in world space.

## Frame order (`src/core/Game.js` — already implemented, do not edit)

```
director.update(dt)            // always (also when paused)
player.update(dt)              // skipped while paused
enemies.update(dt)
combat.update(dt)
vfx.update(dt)
ambient.update(dt)
env.update(dt)
cameraRig.update(dt)           // always
audio.update(dt)               // always
ui.update(dt)                  // always
post.render(dt)                // always — performs the actual render
input.endFrame()
```

- `dt` is scaled by hitstop/slow-mo (`game.time.timeScale`) and is 0 while
  paused. Unscaled: `game.time.realDt`. Totals: `game.time.elapsed` (scaled),
  `game.time.realElapsed`.
- The Director can pause or resume inside its own update (P / Esc, a pause requested
  during the wave card), so Game reads the state again after it: the simulation updates
  (player … env, danger) are skipped in **any** frame that was paused at some point — the
  frame a pause is pressed in (its `dt` and `elapsed` step become 0 too) and the frame a
  resume is pressed in. No simulation module ever updates with state `'paused'`.
  `time.elapsed` is advanced after `director.update`.
- `game.hitstop(duration, scale=0.02)` and `game.slowmo(duration, scale=0.3)`
  are the only ways to change time scale.
- `game.danger` (0..1) is computed by Game from `max(enemy.getDangerLevel())`,
  smoothed. Audio, PostFX, UI and CameraRig read it.
- Each module's `update` is wrapped in try/catch by Game; errors are logged
  once (`game._moduleErrors`). A module must never throw every frame.
- Systems run in every state (title, intro, playing, …); modules check
  `game.state` themselves (e.g. Player ignores input unless `'playing'`,
  enemy AI only attacks while `'playing'`).

### Game states (`game.state`, change with `game.setState(s)`)

`'boot' → 'title' → 'intro' → 'playing' ⇄ 'paused'`, `'playing' → 'transition'
(between waves) → 'playing'`, `'playing' → 'dead' → 'playing'`, `'playing' →
'victory'`. Only the Director calls `setState`.

### Debug URL params (`game.debug`)

`autostart` (skip title + intro, start playing at once), `wave=N`, `god`
(player invulnerable), `fixeddt` (dt = 1/60 every frame — use in headless
smoke tests), `freemouse` (mouse look without pointer lock), `nopost`
(PostFX should render the scene directly), `mute`, `stats` (UI shows fps),
`quality=low|medium|high` (`game.quality`; see below).

**Quality** (`src/core/quality.js`, resolved in the Game constructor before any module
exists): `?quality=` wins for that load and is never saved → else the title screen's last
choice, saved in `localStorage['fish.quality']` right before it reloads → else `'high'` when
`autostart` or `fixeddt` is set (keeps harness baselines) → else a guess from the unmasked
GPU name of the game's own high-performance context: software rasterisers, Intel / AMD
APU / mobile GPUs and entry-level GeForce MX/GT → `low`; Radeon 680M/780M-class APUs and
base Apple M1/M2 → `medium`; `navigator.deviceMemory ≤ 4` or a phone UA caps at `low`;
anything else → `high`. `game.qualitySource` is `'url' | 'saved' | 'debug' | 'detected'`,
`game.gpu` the renderer string. (Measured synced frame cost on lavapipe: high ≈ 7–10× low.)
The storage namespace is a clean cutover: earlier saved preferences are not imported.
Without a new saved choice, the normal URL / debug / GPU precedence applies.

`window.__game` exposes the Game instance for scripted tests
(`__game.input.simulate('attack', true)`, `__game.input.tap('dodge')`,
`__game.input.addMouse(dx, dy)`, teleport entities, etc.). It is assigned when
`game.init()` begins, before the modules exist: wait for `__game.time.frame > 0` or a
`__game.state` other than `'boot'` before touching modules.

### Boot

`main.js` constructs `Game` and calls `game.init()`, which is **async**: modules are
built in stages with a paint between them (env | player | enemies + vfx + combat | the
rest, then every `start()`, `director.boot()` and the frame loop), so no main-thread
task approaches the old ~2 s (lavapipe, high: 0.1 / 0.7 / 0.9 / 0.1 / 0.15 s, then the
first frame ≈0.5 s) and the static splash in `index.html` (`#boot-splash`:
「老公，我想吃鱼了」 · 下水中…) shows at once. Game fades the splash out after the first
frame. Because construction spans several tasks, a constructor must not schedule
callbacks (timers, rAF, idle callbacks) that touch modules built later — do that in
`start()`. Boot failures (no WebGL 2, a throwing constructor) are written on the splash.

## Module contracts

Every module is a class constructed as `new X(game)`; it may implement an
optional `start()` called once after all modules exist. Modules may only
reference modules constructed earlier in their constructor (order:
env, player, enemies, vfx, combat, cameraRig, ambient, post, audio, ui,
director); anything else must be resolved lazily in `start()`/`update()`.

### Environment — `src/world/Environment.js`
```
bounds: { surfaceY, floorY, radius }
waterColor: THREE.Color            // fog/background colour near the player
sunDirection: THREE.Vector3        // unit vector pointing toward the light (up-ish)
sun: THREE.DirectionalLight        // casts shadows (quality ≠ low)
getSeabedHeight(x, z): number      // must be cheap (called many times per frame)
patchMaterial(material): material  // optional: inject caustics + depth absorption
                                   // into a MeshStandard/Physical material
update(dt)
```
Owns: scene.background, scene.fog, lighting, seabed terrain, rocks, kelp,
coral, a sunken fishing-boat wreck, water surface seen from below (Snell's
window), god rays / light shafts, caustics, marine snow.

### AmbientLife — `src/world/AmbientLife.js`
```
update(dt)
```
Schools of small fish (instanced, flocking) that scatter away from enemies and
blood; a sperm-whale silhouette with whale song cue (`events.emit('ambient:whale',
{position})`) once the tiger wave is cleared, before the megalodon wave; jellyfish. The
whale's pass (`src/world/ambient/SpermWhale.js`) is a gentle Bézier laid out around the
camera's view ray (pitch clamped to ±0.2 rad, height to the water column): it emerges
~45 m out already inside the frame, crosses ~30 m from the camera and fades again; it is
kept clear of the reef wall and the seabed (over the trench is fine), coming nearer or
swinging off the view ray only when it has to (`node scripts/render-whale-sim.mjs`).

### PostFX — `src/render/PostFX.js`
```
render(dt)                          // renders game.scene with game.camera
setSize(w, h)
flash(color, intensity, duration)  // full-screen tint, e.g. red when hurt
pulse(type)                         // 'hit' | 'heavyHit' | 'parry' | 'grab' | 'kill' | 'dodge' | 'roar'
```
Reads `game.danger`, `game.player.health/maxHealth`. Underwater distortion,
chromatic aberration, vignette (tightens with danger, reddens at low HP),
bloom, film grain, colour grading, optional screen-space god rays from
`env.sunDirection`. Respects `game.debug.noPost` and `game.quality`.
Must handle tone mapping/output colour space correctly (OutputPass).

### Player — `src/player/Player.js`
```
object3d: THREE.Group (added to scene by Player)
position: THREE.Vector3 (=== object3d.position)
velocity: THREE.Vector3
radius: number
health, maxHealth, stamina, maxStamina
alive: boolean
state: 'swim' | 'attack' | 'heavyCharge' | 'dodge' | 'parry' | 'hurt' | 'grabbed' | 'dead'
hurtbox: { center: Vector3, radius }            // updated every frame
grabbedBy: Enemy | null
forward(): Vector3                               // world-space facing (do not mutate)
isInvulnerable(): boolean                        // dodge i-frames, god mode, cutscenes
isParrying(): boolean                            // inside the parry window
getActiveAttack(): null | {
  id: number,                 // unique per swing
  type: 'light' | 'heavy' | 'grabStab',
  damage: number,
  base: Vector3, tip: Vector3,// knife segment in world space, updated every frame
  radius: number,             // sweep radius around the segment
  knockback: number,
  hitEnemies: Set<Enemy>,     // CombatSystem adds enemies already hit by this swing
  reach?: number,             // (optional) metres `tip` is extended past the real blade
                              // tip; visible tip = tip − reach·normalize(tip − base)
}
takeHit({ damage, sourcePosition, knockback, heavy }): boolean   // false if ignored
setGrabbed(enemy | null)
heal(amount)
reset()                       // full health/stamina at WORLD.playerSpawn
update(dt)
```
Emits: `player:attack {type, combo}`, `player:dodge {}`, `player:parry
{attempt:true}` (a press that starts a parry), `player:parry {whiff:true}` (its window
closed on nothing; see Parry), `player:hit {damage, health,
sourcePosition, heavy}`, `player:death {}`, `player:heavyCharge {level}`.
Stays inside the arena: below surface (−1.2 m), above seabed (+0.7 m), within
`arenaRadius`.

### Enemies — `src/enemies/EnemyManager.js` (+ any files under `src/enemies/`)
```
EnemyManager:
  enemies: Enemy[]           // current wave (dead ones remain until next spawn)
  waveIndex: number
  spawnWave(index): Enemy[]  // clears previous, spawns WAVES[index].enemies
  clear()
  getAlive(): Enemy[]
  getBoss(): Enemy | null
  getNearest(position, maxDist): Enemy | null
  update(dt)                 // updates enemies; emits enemy:death once per enemy
                             // and wave:clear once when all are dead

Enemy:
  type: 'greatWhite' | 'tiger' | 'megalodon'
  name: string               // Chinese display name
  isBoss: boolean
  object3d, position (=== object3d.position), velocity, forward (world unit Vector3)
  length: number             // metres nose→tail
  health, maxHealth, alive, state: string
  hurtboxes: [{ center: Vector3, radius, part: 'eye'|'gills'|'head'|'body'|'fin'|'tail' }]
  update(dt)
  takeHit({ damage, part, point, direction, attackType }): { damage, killed }
  getAttackVolumes(): [{ id, center: Vector3, radius, damage,
                         type: 'bite'|'ram'|'tail'|'shockwave',
                         canGrab: boolean, knockback, parryable: boolean }]
  onParried()                // stagger + open for punishment
  startGrab(player)          // bite connected: hold player in jaws
  releaseGrab(success)       // success = player stabbed free (enemy reels, takes damage via combat)
  getMouthPosition(): Vector3 // world position for grab attachment
  getDangerLevel(): number   // 0..1
  dispose()
```
Emits: `enemy:spawn {enemy}`, `enemy:telegraph {enemy, type, duration}`
(right before an attack becomes active — audio/UI/camera react),
`enemy:attack {enemy, type}` (the strike starts: lunge, ram, tail or shockwave — a gaped
close bite emits it at the snap, not when the jaws open; Audio's lunge rush, the camera's
attack trauma and PostFX's tunnel release key on it), `enemy:roar {enemy}` (megalodon phase change),
`enemy:death {enemy}`, `wave:clear {index}`.
Owns: procedural fish meshes (SkinnedMesh or vertex-shader swim), AI, attack
timing, death animation (sinks, trails blood via `game.vfx`).

### CombatSystem — `src/combat/CombatSystem.js`
```
grab: null | { enemy, progress: 0..1, timeLeft }
update(dt)
```
Each frame while `playing`: player attack segment vs enemy hurtboxes (once per
attack id per enemy; damage × `PART_MULTIPLIER[part]`), enemy attack volumes vs
player hurtbox (once per volume id), parry resolution, dodge (perfect dodge =
attack whiffs during i-frames → `game.slowmo`), grab QTE (mash `attack`),
soft body separation player↔enemies. Calls `game.hitstop`, `cameraRig.addTrauma`,
`post.pulse/flash`, `vfx.*`.
Emits: `enemy:hit {enemy, damage, part, position, critical, killed, attackType}`,
`player:parry {success:true, enemy}`, `player:perfectDodge {enemy}`,
`grab:start {enemy}`, `grab:progress {value}`, `grab:end {success, enemy}`.

### CameraRig — `src/camera/CameraRig.js`
```
yaw, pitch
lockTarget: Enemy | null
getMoveBasis(): { forward, right, up }  // forward includes pitch; right is horizontal
addTrauma(amount)                       // 0..1 shake, decays
kickFov(deltaDegrees, duration)
toggleLock()
update(dt)
```
Third-person over-the-shoulder, mouse look, lock-on framing, collision with
seabed/surface, underwater sway, title/intro/death/victory cinematic cameras
driven by `game.state`, scale-selling framing for the megalodon.

### VFX — `src/vfx/VFX.js`
```
spawnBlood(position, direction, amount)        // amount ~0.2..3
spawnBubbles(position, count, { speed, size })
spawnImpact(position, normal, { strength })
spawnShockwave(position, radius, { })          // pressure ring (tail slam / roar)
spawnSlashTrail(...)  // optional; VFX may instead read player.getActiveAttack()
update(dt)
```
GPU-friendly pooled particles (instanced/Points, no per-frame allocation).
Knife trail ribbon, depth-correct blood colour, bubble streams from player
movement and wounds, sediment clouds when things hit the seabed.

### AudioEngine — `src/audio/AudioEngine.js`
```
ready: boolean
unlock()                 // called from the UI start gesture; creates AudioContext
play(name, opts)         // one-shots; unknown names are ignored silently
update(dt)
```
100 % procedural WebAudio (no files). Everything sounds underwater (low-passed,
reverberant). Listens to events itself. Layers: ambience (deep rumble, distant
creaks, bubbles), tension music driven by `game.danger` (low strings/drone,
original motif — do **not** copy the *Jaws* theme), heartbeat, shark
telegraph sting, bite crunch, knife slashes, flesh hits, parry clang, whale
song, megalodon roar, UI clicks, phone ring for the intro. Respects
`game.debug.mute`.

### UI — `src/ui/UI.js` (+ `src/ui/*.css`)
```
update(dt)
```
DOM overlay inside `#ui-root`. Title screen, intro subtitles, HUD (health,
stamina, boss bar with name, lock-on reticle, grab QTE prompt, damage
numbers optional, low-HP heartbeat border), wave title cards, pause menu
(resume / restart / controls), death and victory screens. Chinese text,
cinematic serif typography. On start click: `game.audio.unlock()`,
`game.input.requestPointerLock()`, `game.director.startGame(0)`.
The title's license panel loads `public/THIRD_PARTY_NOTICES.txt` through Vite's
`import.meta.env.BASE_URL` so it also works under the GitHub Pages repository path.
It suspends the title menu while open; the text can be selected and scrolled with
the mouse wheel or W/S / ↑/↓.

### Director — `src/game/Director.js`
```
waveIndex
boot()                     // title, or straight to play with ?autostart
startGame(waveIndex = 0)   // plays intro (unless autostart), then waves
beginWave(index)
restartWave()
togglePause()
update(dt)
```
Owns `game.setState`. Emits `wave:start {index, wave}`, `subtitle {speaker,
text, duration}`, `game:victory {stats}`, `cinematic {name}`. Handles pause
on Esc and when pointer lock is lost during play.

## Events summary

| Event | Payload | Emitted by |
|---|---|---|
| `game:state` | `{from, to}` | Game |
| `game:resize` | `{width, height}` | Game |
| `input:pointerlock` | `{locked}` | Input |
| `player:attack` | `{type, combo}`; heavy adds `level`, a riposte (light or heavy) `riposte:true` | Player |
| `player:heavyCharge` | `{level}` | Player |
| `player:dodge` | `{}` | Player |
| `player:parry` | `{attempt:true}` / `{whiff:true}` / `{success:true, enemy}` | Player / Player / Combat |
| `player:perfectDodge` | `{enemy}` | Combat |
| `player:hit` | `{damage, health, sourcePosition, heavy}` | Player |
| `player:death` | `{}` | Player |
| `enemy:spawn` | `{enemy}` | EnemyManager |
| `enemy:telegraph` | `{enemy, type, duration}` | Enemy |
| `enemy:strike` | `{enemy, type, eta}` — a parryable bite/ram is forecast to arrive in `eta` game s (cued at eta ≤ 0.32 s); once per volume; a shark's volume goes live ≥ 0.22 s after it (contact measured 0.23–0.40 s after) | Combat |
| `enemy:attack` | `{enemy, type}` — the strike starts (a gaped close bite: at the snap) | Enemy |
| `enemy:roar` | `{enemy}` | Enemy |
| `enemy:hit` | `{enemy, damage, part, position, critical, killed, attackType}` | Combat |
| `enemy:death` | `{enemy}` | EnemyManager |
| `grab:start` / `grab:progress` / `grab:end` | `{enemy}` / `{value, timeLeft, enemy}` / `{success, enemy}`, or `{success:false, enemy, interrupted:true, reason}` when it ends without an outcome | Combat |
| `wave:start` | `{index, wave}`; `{index, wave, retry:true}` when the same wave restarts (death / pause → retry) | Director |
| `wave:clear` | `{index}` | EnemyManager |
| `subtitle` | `{speaker, text, duration}` | Director |
| `game:victory` | `{stats}` | Director |
| `ambient:whale` | `{position}` | AmbientLife |
| `cinematic` | `{name:'intro'}` at intro start, `{name:'dive'}` when the camera goes under | Director |

## Contract extensions (agreed during integration)

These were added by the module implementations; all are optional for callers.

- **Grab ownership.** CombatSystem applies all player damage during a grab (bite ticks
  every 0.5 s, the timeout bite) and runs the QTE; the Enemy only holds, thrashes and
  spits. While `combat.grab` is set the hit loop ignores `grabStab` attacks (the QTE owns
  the knife). `grab:progress` is `{value, timeLeft, enemy}`, emitted every frame with a
  reused object — don't keep it. `combat.grab.timeLeft` is in seconds. A failed grab
  (timeout) damages the player *while still held*, then the shark spits him out
  (`player.setGrabbed(null)` adds the spit to his velocity instead of replacing it). The
  timeout frame emits a single `player:hit` (a grind tick due on that frame is folded into
  the fail bite, total cost unchanged), and the player is released once
  (`enemy.releaseGrab()` already calls `player.setGrabbed(null)`).
- **Pausing keeps everything.** A pause never ends a grab, a telegraph or an attack:
  simulation modules don't update while paused (see Frame order), and enemy AI that
  looks at `game.state` treats `'paused'` like `'playing'` for its grab / attack
  bookkeeping. The HUD hides the grab QTE prompt while paused and restores it on resume.
- **Grab ends without an outcome.** A retry, a state change, the player's death or the
  shark dying / despawning mid-grab ends it with `grab:end {success:false, enemy,
  interrupted:true, reason}`, `reason` ∈ `'restart'` (Director retry / new run), `'state'`,
  `'death'`, `'interrupted'` (enemy gone). Listeners show no fail/success feedback for
  these (HUD closes the prompt, Audio stops the grab loop silently).
- **Strike cue.** Combat emits `enemy:strike {enemy, type, eta}` once per parryable
  attack volume when it is about to touch the player — the "parry now" moment, distinct
  from the earlier `enemy:telegraph` wind-up. The timing comes from the enemy's optional
  `getStrikeCue()` → `null | {id, type, eta, snap?, point?}` (the volume id the strike will
  use, seconds until it can touch 老公; for a shark's side-snap `snap: true` and `point`,
  the predicted jaw contact): Combat cues when `eta ≤ STRIKE_ETA` (0.32 s, CombatSystem); a
  live parryable volume nobody forecast falls back to its gap to the hurtbox dropping under
  max(0.8 m, `STRIKE_ETA` at the enemy's speed). The Shark hears its own `enemy:strike`
  (`ai.onStrikeCue()`), and its bite / ram volume goes live only `STRIKE_LEAD` (0.22 s,
  SharkAI) after it — later if a gape is still open — so contact always comes ≥ 0.22 s after
  the cue. `eta` is only a forecast (it assumes 老公 holds his course, and a gaped bite
  still has to snap and travel), so contact often comes later than it: 0.23–0.40 s after
  the cue measured (`enemies-sim strike-close` / `strike-natural`; rare outliers up to
  ≈0.55 s). A cued lunge runs on until its volume is live rather than ending between the
  cue and the contact it announced. That is long enough to react to:
  round 2's 0.25 / 0.16 s left a 0.15–0.2 s budget and a bot reacting in 0.2 s lost the
  tiger wave 5 times in 16; now a press up to 0.2 s after the cue parries every species and
  kind (Node, `.smoke/final-gameplay/timing.mjs`). No bite / ram can touch before its
  announced telegraph has run out (volumes exist only in `'attack'`). The cue, not the end
  of the wind-up, is the parry reference: from mid range a bite's cue comes as its
  telegraph ends (within ≈0.1 s), a ram's 0.3–0.55 s after; in natural fights both spread
  wider. A press on the cue parries: Combat accepts a parry from 0.5 m before contact, well
  inside the window. Presentation: the HUD snaps the lock reticle tight and
  white-hot for 0.2 s (only on the locked striker), and its off-screen threat arc pulses
  red; on the first two cues of wave 0 the HUD also writes 「现在 —— E 格挡」 beside it
  (StrikeHint, see Director / UI). Audio plays `strike`, a rush of water swelling into the
  contact, for bites and rams, on the `'cue'` bus so slow-mo and hurt dips don't muffle it
  (see Audio). `jawSnap` — jaws shutting on nothing — is the perfect-dodge sound, not this
  cue.
  Close in, the bite wind-up brakes to a hover instead of nosing into 老公; a
  wind-up that still ends with the jaws within max(1.6 m, 0.2 × length) of him, and a lunge
  that would reach him in under 0.28 s, gapes instead: jaws wide and tracking him, the cue
  goes out, for up to 0.3 s (`ARM_TIME`; uncued, it may hang on 0.25 s more while he grazes
  the open jaws). It snaps early once the cue has led by `STRIKE_LEAD` with him already
  between the jaws (no "ghost bite" on a diver who swims through the open mouth), and never
  later than 0.28 s after the cue. A ram whose snout, at the end of its wind-up, is closer
  than it would travel in `STRIKE_LEAD` becomes such a gaped bite (a ram wind-up also reins
  in when he swims into it). A gaped bite emits `enemy:attack` at the snap, not at
  `_startAttack`; Audio's lunge rush, CameraRig's attack trauma / boss dolly release and
  PostFX's tunnel release key on it. The boss's (and a counter's) side-snap cocks its head
  0.2 s before the whip. For framing it is public: `ai.snapping` is true from the moment
  the snap is chosen (before its `enemy:telegraph` goes out) through the whip, and
  `ai.snapPoint` (Vector3 while snapping, else null) forecasts where the jaws land — the
  mouth swung about the head pivot to the aim, carried by the body's turn and drift
  (≈0.7 m off on the boss at the cue, `enemies-sim boss-snap`). `getStrikeCue()` carries the
  same as `snap` / `point`, but only until the cue (a snap cues on its first attack frame),
  so a camera reads `ai.snapping` / `ai.snapPoint`. Check with `node
  scripts/enemies-sim.mjs strike-close strike-natural` (no browser; `late` = a lead under
  0.22 s; `STRIKE_KIND=ram` for rams) or `scripts/enemies-strike-scenario.mjs`.
- **Parry** (`PLAYER.parryWindow` / `parryCooldown` / `parryWhiffStamina` in config.js; the
  whiff recovery and spam fatigue are constants in Player.js).
  - A press opens a 0.30 s window (`isParrying()`; the parry pose runs 0.4 s) and emits
    `player:parry {attempt:true}`. A bite / ram volume reaching the player in the window is
    parried: Combat emits `player:parry {success:true, enemy}` and the shark staggers;
    Player clears its cooldown, whiff recovery and fatigue, gains 12 stamina and opens the
    0.6 s riposte window, so parry → riposte → parry flows.
  - A press parries from swimming and cancels a heavy charge (its stamina stays spent) and
    a light / heavy swing's wind-up (a riposte's homing hold too) or recovery. A press
    during a swing's active frames — or a dodge, or a hurt stagger — is buffered (0.28 s,
    like every action press) into whatever comes next. Before round 3 a press during a
    charge or a wind-up was silently dropped and the bite landed. Dodge cancels the same
    states.
  - A window that closes on nothing is a whiff — `player:parry {whiff:true}` (Player; no
    `fatigue` field): −8 stamina (`parryWhiffStamina`), stamina regen paused 0.4 s, a
    0.15 s whiff recovery (off-balance pose; attack / heavy / dodge cancel it) and +1 spam
    fatigue f (cap 3, drains 0.5 / s). One recent whiff doesn't shrink the next window: only
    fatigue above the grace of 1 does, to 0.30 / (1 + 3·(f − 1)) s — ≈0.12 s at f 1.5,
    0.075 s at f 2, ≈0.05 s for a masher (f ≈ 2.8). A fixed rhythm keeps full windows only
    at ≥ 2 s per press.
  - Retry (Player `PARRY_RETRY` = the fatigue grace, 1): the first press after a lone,
    unfatigued whiff (fatigue ≤ 1, i.e. one whiff from rest) skips the cooldown and the
    whiff recovery, and a press made inside the window that just closed is carried into
    that retry instead of being dropped. Otherwise presses during the cooldown or the
    whiff recovery are dropped, not buffered, so a second miss (fatigue ≈ 2) gets no
    retry and mashing still collapses into the short fatigued windows.
  - `parryCooldown` 0.6 s from the press (a press inside it is dropped unless it is the
    retry; a success clears it). With the retry, a panicked press anywhere from 0.9 to
    0.1 s before the telegraph ends no longer dooms the press on the strike cue: 6/6 for
    every species and kind (`.smoke/final-gameplay/timing.mjs`; `core-parry-sim.mjs cue`
    16/16 for the great white). Round 2's 0.6 s cooldown left a dead zone
    0.10–0.55 s before a great white's telegraph end (0/3 in the browser), and its 1.2 s
    cooldown swallowed even a press 0.6 s early (0/6). The fatigue does most of the
    anti-spam work; the cooldown only sets a masher's press period — 0.45 s (= window +
    recovery) left it at ≈1.3× against the tiger pair, 0.6 s ≈1.2×.
  - Balance target: a never-attacking spammer lasts ≤ 1.3× as long as an idle player in
    every wave (`scripts/core-parry-spam.mjs`, 16-seed medians, waves 0 / 1 / 2): round 2,
    every 0.4 s 1.20 / 1.25 / 1.09×, mashing 1.12 / 1.19 / 1.29× (a second run: 1.20 /
    1.20 / 1.20 / 0.98×, 1.14 / 1.17 / 0.99×). Round 3 as merged, Node
    (`core-parry-sim.mjs spam`, 16-seed medians, seeds 1–16 / 17–32): every 0.4 s 1.20 /
    1.21 / 1.05× and 1.18 / 1.14 / 1.03×, mashing 1.17 / 1.20 / 1.05× and 1.22 / 1.08 /
    1.05×, every 2 s 1.25 / 1.33 / 1.02× and 1.15 / 1.18 / 1.01× — confirm in the browser
    (`core-parry-spam.mjs`, 16 seeds). A bot pressing every 2 s — no fatigue, the
    cooldown never binds — reads 1.1–1.35× from run to run: that spread is the noise
    floor of a 16-seed median. With round 2's fatigue (no grace, K 0.75, drain 1 / s) a
    0.45–0.6 s cooldown let a masher reach 1.4–1.8×; without any whiff cost, 0.4 s gave
    3–5×.
- **Blood.** Combat owns hit blood: `Shark.takeHit` adds wounds / bleeding but spawns no
  burst of its own (one burst per hit).
- **Player.** `player:heavyCharge {level}` fires at charge start (0) and at levels 1–3.
  `player:dodge` carries `direction`; heavy `player:attack` carries `level`. While
  `grabbedBy` is set the player stays in state `'grabbed'` even when taking hits. The
  active attack exposes `reach` (see the contract) so the knife trail can follow the
  real blade. A light swing started — or a heavy charge begun — within 0.6 s of a
  successful parry, with the parried shark's eye / gills / head within 6 m, is a riposte
  (`player:attack {…, riposte:true}`, `attack.riposte`): a homing dash at that vital that
  holds the cocked blade until it is in reach (light: up to 0.35 s, strikes from 1.1 m;
  heavy: up to 0.45 s, from 1.3 m, its thrust lunging on top). A charge released after the
  shark drifted out of dash range (6 m) is a plain heavy. Before round 3 a heavy charged on
  the parry went live 2.3–2.5 m short and never landed. Treading 老公 raises a knife-ready
  guard (pose only) while locked on, while a live shark's body or jaws is within 15 m
  (dropped past 18 m) or when `game.danger` ≥ 0.45.
- **Enemy.** Extra fields: `right`, `up`, `speed`, `grabDamage`, `vulnerable` (stagger,
  ×1.3 damage), `phaseThresholds` (boss bar ticks, default `[0.6, 0.25]`), `ai.state`,
  `ai.phase`, `ai.snapping` / `ai.snapPoint` (side-snap, see Strike cue); `getStrikeCue()`
  (see Strike cue). The megalodon's wake/bow-wave push on the
  player is applied by the Enemy (`Shark._wake`), not by CombatSystem. Shockwave volumes
  grow their `radius` over time.
- **Enemy AI pressure (round 3).**
  - Face-tanking is answered. A non-boss shark that takes 2 knife hits within 4 s (blows
    into a stagger and the grab-escape stab don't count) with 老公 within 4 m of its jaws,
    or in reach of its tail, counters at once instead of bolting (from circling, a feint,
    a flank, an approach or a recovery): jaws bearing → a short bite wind-up (0.8 × the
    species' telegraph, with the usual gape and strike cue, so it stays fair); tucked in
    beside the head → a head-whip side-snap; else a committed approach whose braking pivot
    swings the jaws round; at the tail → a tail slap, then round for the jaws. Only a heavy
    thrust to the face interrupts a counter's wind-up (a plain wind-up also yields to a
    light eye stab). EnemyManager (`requestCounter`) grants it the attack token, cooldown
    or not, unless another shark is winding up, striking or holding him, so hits never
    stack. A counter bite, and any bite started while the pack is being carved up (2+
    knife hits on the wave's sharks in the last 10 s, `recentKnifeHits`), rips: ×1.5
    damage, ×1.6 knockback, no grab, because a mashed-out grab would hand a face-tanker a
    free eye stab. The boss always holds. Cut from the flank or behind, a shark may still
    bolt. Before round 3 a lock-on masher who never parried or dodged beat the great white
    8/8 and the tigers 6/8.
  - Murk swing. Between attacks a calm non-boss shark (aggression < 0.5, after its
    opening commit, one per pack at a time) now and then swings out to 34–40 m. There it
    stays a faint shape in the murk (the lock reticle still sits on a silhouette) with an
    off-screen arc. It holds a few seconds, then comes back in (at once if he cuts it out
    there); a circling partner commits sooner meanwhile. How often and how long is per
    species (`ai.wide {chance, cd, hold}` in species.js): the great white now and then
    (chance 0.45 per lull, cooldown 14–22 s, hold 2.5–4 s), the tigers about as rarely
    (0.5, 16–24 s, 3–4.5 s). Round 4's white swung out often and far (0.85, 9–15 s,
    3.5–5.5 s, to 38–48 m): wave 0's attack rate fell 25–35 % (idle deaths 72 → 91–97 s)
    and the lock reticle sat on empty water. `enemies-sim gw-cadence` keeps it in band
    (idle-with-escape ≥ 4.3 attacks/min; 4.7 now, idle death ≈ 77 s). The non-boss orbit
    also tightens late (aggression²), so most circling happens out in the murk; a diver
    swimming in on a circling shark is out-swum back to the orbit's distance.
  - Soft leash. With 老公 out past r ≈ 42–55 m (the trench, the arena edge) or below
    −45 → −55 m, the sharks work the fight back toward the lit open water: a recovering
    shark peels off that way, a grab drags him that way, a murk swing goes out on that
    side, the orbit works its open-water half and rides up toward −25 m (by ≤ 15 m), the
    boss circles a centre shifted ≤ 20 m toward the open water, and a new wave spawns on
    that side. The megalodon killed below ≈ −20 m drifts up toward the light for its first
    4–7 s before it sinks. A corpse bleeds off its speed (drag 1.3 / s), so a kill at speed
    no longer glides 35–50 m out of the victory shot.
  - Pressing passive prey: after drawing blood from a barely moving 老公, the next commit
    is a bite and comes sooner, so a tail swipe or a ram no longer stretches an idle fight
    past 45 s.
- **PostFX.** `pulse(type, {position, strength})`. `'hit'` / `'heavyHit'` mean the PLAYER
  was hurt; `'strike'` / `'crit'` mean the player landed a blow; also `'perfectDodge'`.
  PostFX also subscribes to the gameplay events itself, so duplicate calls only restart
  an effect. `warmup(object = scene)` → `Promise<boolean>` precompiles every program
  under `object` (hidden objects too) with the scene render target bound — three keys
  programs on the bound target's tone mapping / colour space, so compiling against the
  canvas builds the wrong variant. PostFX warms the whole scene after the first frame;
  modules that create meshes later call `game.post?.warmup?.(object)` (EnemyManager does
  for each shark). Never call it from inside `render()`; it does no synchronous draw before
  its compile resolves (a first draw would wait for every queued program). On
  `wave:start {retry:true}` it clears running effects. A `player:perfectDodge` right after
  `player:dodge` replaces the dodge's radial blur instead of stacking on it.
- **Warm-up hold.** Each warm-up is a job with three phases: `'prime'` (once its programs
  are built — `KHR_parallel_shader_compile` status when available — run their first-use
  link check and uniform reflection in 30 ms slices), `'dry'` (only for a detached object,
  such as EnemyManager's throw-away shark rig: one 1×1-viewport render of the scene with it
  into the real target, which sets up GPU pipelines, the shadow-depth variant and texture
  uploads) and `'drain'` (wait for that render). Every step waits for an idle GPU: a WebGL2
  fence has passed and nothing was rendered after it (without fences, 400 ms). A GPU-bound
  real-rAF loop is never idle, so while a job is ready to prime, `render()` holds its
  frames (keeps the last image) on the title, the intro and the wave card — states
  `'title'`, `'intro'` and `'transition'`, never `'playing'`. The hold lasts at most 1 s per
  job (the boot warm-up holds the title up to 3 s, then dry-renders the scene); after that
  the rest of the job runs synchronously, still behind that screen. In play, a job advances
  only when the GPU happens to be idle, and its dry render waits for the next card.
  Programs that an earlier job primed (or is priming) are skipped. A job whose programs are
  still not built after 10 s is dropped unprimed (a safety net). On `webglcontextlost`
  every pending job is resolved and dropped (its fence and programs belong to the dead
  context, whose status queries never answer), the primed set is forgotten and any hold
  is released; `webglcontextrestored` re-runs the boot warm-up. The result is that no
  shark reveal pays for first use: on lavapipe high, real rAF, the wave-0 reveal frame went
  from 717 ms to 11 ms and the cold `startGame(2)` reveal from 812 ms to 6 ms. Round 2 had
  dropped every timed-out (5 s) job onto the reveal frame. `scripts/render-checks.mjs`
  `revealWave0` / `revealCold` check this on the real loop.
- **Eye adaptation.** There is no GPU readback.
  - Looking up into Snell's window stops the exposure down by up to 42 % (base exposure
    1.1). The full stop holds to 20 m of depth, then fades to the preset's `deepStopK`
    share of it by 45 m (0.2; 0.1 on low, which has no bloom).
  - Below 40 m the exposure opens: × (1 + (0.7 + 0.3 · abyss) · smoothstep(40, 62, depth)),
    where abyss rises as the seabed under the camera drops from −58 to −120 m. Nothing
    changes above 40 m.
  - In the victory beat (`'victory'` or the Director's victory phase) it lifts × 1.5 more,
    faded in over 35–45 m of depth, so a climax over the trench stays legible (boss at
    −50 m: frame luma ≈ 26; victory camera at −57 m ≈ 39).
- **Render-time culling.** Per-camera culling / packing (Environment's static props, the
  fish schools) runs in `scene.onBeforeRender` with the camera actually rendered, so a hard
  camera cut never shows last frame's culling. Chain the handler, never replace it.
- **VFX.** Extras: `spawnSediment(pos, amount)`, `spawnSpark(pos, normal, strength)`,
  `addWound(enemy, worldPoint, {duration, rate, size})`, `spawnBloodTendril(pos, size, dir)`,
  `clear()`. All spawn functions copy their vector arguments.
  - Pressure waves have no fresnel shells. A shell read as a glass globe around the shark
    or the lens. `spawnShockwave` / `spawnImpact` carry the front with bubbles,
    cavitation fizz and particulate. Only a mid-sized wave (radius 2–6 m) adds a flat ring
    (PressureFX), as does a corpse up to ≈6.7 m long landing on the seabed (not the
    megalodon); the ring has a soft rim and fades as it turns edge-on, so it never becomes a
    line across the frame. Big waves read through PostFX's screen-space distortion ring:
    its `'roar'` pulse, which VFX also fires (strength 0.6) on a shockwave `enemy:attack`
    (the tail slam).
  - Blood puffs are translucent (alpha ≤ 0.5, `BLOOD_ALPHA_MAX`, thinner at the edge than
    in the core) and, lit at 20 m and deeper, dark green-black and desaturated (albedo
    ≈ 1.3× red over green against the cyan light; round 3's 2.3× red read as ochre mud /
    sediment) — a dark grey near the surface, never brown, orange or pink. They
    thin within ~2 s (life 3–5 s); blood spawned on or beside a dead enemy (a corpse's
    bleeding) fades from 2 s and is gone by ~3 s. Bursts above amount 1 grow sub-linearly
    (× 0.45 per unit) and no puff exceeds 1.6 m, so a kill stays visible through its
    cloud. Wounds string out long thin trails.
- **CameraRig.** `addRumble(amount, duration)`; `kickFov(delta, duration, attackSeconds)`.
  `yaw`/`pitch` are accessors (writes snap the smoothing). The rig reacts to combat events
  itself.
  - Lock-on tracks the target's body centre. Its gain fades in with *horizontal* distance
    (over 2–8 m, or 1.2–5 m while the target winds up or attacks). Each step is capped at
    3 rad/s of yaw and 1.6 rad/s of pitch. The yaw holds while an uncommitted target is
    within ~4 m or (nearly) straight overhead / underneath. Before round 3 the gain used 3D
    distance, so a shark swimming off after a grab, or the boss passing overhead, whip-panned
    the view at 6–9 rad/s.
  - `player:death` drops the lock, so the 2.6 s dying beat is a steady follow shot, and no
    new lock is taken while he is dead.
  - A locked megalodon winding up or lunging a bite / ram with its mouth within 16 → 10 m
    (faded in) turns the rig until its jaws — the point between mouth and head, where the
    reticle sits — are at ~60 % of the width and their elevation, at up to 3.5 rad/s of yaw
    (≤ 1.3 rad past the current yaw) and 2.4 rad/s of pitch. The body centre sits 6–8 m
    behind the jaws, so a close bite seen broadside would otherwise leave the head and the
    reticle off screen.
  - A locked megalodon's side-snap (the head whip at prey tucked in beside its gills,
    usually ~3 m under it; SharkAI `snapping`, read as `ai.snapping ?? ai._snap`) is
    framed fully from its telegraph on, whatever the mouth distance: the yaw looks from
    老公 across at the head pivot, leaning toward his flank of the boss (broadside to the
    head — the body-centre lock looked at it head-on, its cocked snout hanging over the
    lens), the pitch aims midway between the head pivot and his chest (or the cue's
    `contact` point, if one is given). Over ~0.3 s the shot opens up: the boom runs out
    to 8 m instead of the telegraph dolly-in, the lens is kept near shoulder height
    (lifted, boom pitch ≤ 0.12 rad), and the telephoto and push-in kicks drop out. The
    reticle is on screen at 92–95 % of the close-bite cues (`combat-camsim bosscue`, 12–24
    seeds; 61–66 % before).
  - Near the seabed the low boss camera drop fades out, the boom may lift up to 0.6 rad,
    and a short boom narrows the shoulder offset and the threat orbit, keeping 老公 inside
    the left half of the frame.
  - In the breather before the boss (after the tiger wave's `wave:clear`) the pitch levels
    toward 0.05 rad once the lock drops (≈95 % in 1.5 s), so the whale pass is in view. A
    mouse move hands the view back to the player.
  - The victory shot is size-aware and scored. The corpse fills ~25–45 % of the frame,
    broadside to 3/4 (|cos(view, body axis)| ≈ 0.2–0.45, never nose-on), never seen from
    more than 10° below, its centroid in the left / centre-left half (clear of the stats
    panel at x ≈ 0.42–0.75); 老公 stands in front of it, high in the left third, ≥ 6 % of
    the frame height. The camera stands far enough off for the whole length to fit
    (≥ 0.68 · length / tan(0.45 · hFov) from its centroid), never with the corpse between
    the lens and him (now or after 1.5 s of its drift), with open water to both: sight
    lines to him and to five spheres along the corpse are marched against the seabed, the
    reef wall's face, the wreck and the outcrops (`occluded()` / `corpseOccluded()` in
    cinematics.js), and a steep map view (> 0.6 rad down) is avoided. Bearing and
    elevation are scored over 24 × 4 candidates, from where the shot starts and from where
    its pull-back (20 % from 2 s, over 6 s) ends; checked twice a second and re-picked (and
    eased over to) when the corpse has risen / drifted 2 m or sunk 4 m, is seen from below,
    slid out of the frame or behind rock. `combat-camsim victory` / `victorywall` (the same
    kill moved under the reef wall), 24 seeds: 23/24 shots good each, ≤ 9.2° from below,
    no sight line through rock.
- **Environment.** Overrides three's fog shader chunks globally (view-dependent water
  colour). Extras: `patchShader(shader, opts)`, `landmarks {wreck, wreckHeading, cliff,
  abyssEdge, kelp[]}`, `wreckPosition`, `titleFocus`, `heightfield.normalAt/slopeAt`,
  `setLightDim(0..1)`. A boss passing between camera and sun dims the light automatically.
  Layout: open combat area r ≈ 40 m, reef wall north (r ≈ 62–70), trench east/south-east
  (lip r ≈ 58, floor ≈ −138), wreck at ≈ (−27, −46, −34). The warm frame after boot draws
  every static piece, including the whole wreck. On medium the alpha-tested net lies
  outside the spawn's ±36 m shadow box, so its shadow-depth program used to compile
  mid-fight. A reef-wall strip casts shadows while its *shadow* (its box swept ~16 m along
  −sunDirection) may lie within shadow reach, not only the wall itself, so the wall's
  shadow doesn't pop onto the seabed as the lists re-sort. Kelp and sea-grass blades fade
  out near the lens instead of filling it as flat strips (kelp gone within 1.5 m, whole
  from 2.5 m; the narrower grass 1.0 → 2.0 m): alpha-to-coverage on the MSAA presets, a
  dithered discard on low, still one program per material (built by the warm frame);
  their shadows stay whole.
- **Audio.** `play()` returns a handle or null; the name list is `PLAY_NAMES` in
  `src/audio/AudioEngine.js` (includes `uiHover`, `uiClick`). Extras: `setVolume`,
  `setMuted`, `toggleMute`, `debugInfo()`. Common play opts: `position` (Vector3 | [x,y,z])
  or `follow` (an enemy / Vector3 tracked while it plays) → 3D; `gain`; `delay` (s);
  `ref` / `rolloff` override the sound's panner distance model (refDistance /
  rolloffFactor — the megalodon's wake and swim-bys use a reference distance ∝ its size
  and a gentle rolloff). `chargeTier {tier}` is a soft tick at heavy-charge tiers 1 and 2
  (`chargeReady` marks tier 3). `Music.telegraph(duration, now)` returns the string-cluster
  voice (or null outside tense modes) so an interrupted wind-up can release it; the engine
  keeps the telegraph sting and cluster per shark and reads `enemy.ai.state` to keep them
  up while the shark still holds a finished wind-up (`'telegraph'`). The intro's dive
  splash is cued by `cinematic {name:'dive'}` (the Director always emits it).
  - Parry sounds: a press plays `parryRaise` (round 2's `parryWhiff`). A window that
    closes on nothing (`player:parry {whiff:true}`) plays `parryMiss {fatigue 1–3}`, louder
    and duller with spam fatigue: an optional `fatigue` on the event wins, but Player sends
    none, so the engine mirrors Player's (+1 per whiff, cap 3, drains 0.5 / s, cleared by a
    clean parry and by `wave:start`). A clean parry plays the clang (`parry`).
  - `enemy:strike` plays `strike {kind: 'bite'|'ram', eta, size}` at the striker's mouth,
    eta clamped to 0.17–0.4 s, on the `'cue'` bus: a branch of the water bus whose low-pass
    follows the water cutoff only down to `CUE_FLOOR` (900 Hz, `src/audio/mixer.js`). A
    wind-up held past its sting's peak hands over to the looping `telegraphHold` until the
    lunge (`enemy:attack` plays `lunge` for bites / rams).
  - A pause mid-wind-up releases the telegraph sound (the audio clock keeps running) and
    keeps the time left. On resume a fresh sting swells over the rest (≥ 0.3 s left), or
    the held tail takes over if the sting had (nearly) peaked.
  - The death sting and its heartbeats are released (0.2 s fade) when the next attempt
    starts (`wave:start`, `game:victory`).
- **Director / UI.** Extras: `director.pause(reason)`, `resume()`, `skipIntro()`,
  `restartGame()`, `stats`, `phase`; `ui.isModalOpen()`, `ui.retry()`, `ui.playAgain()`,
  `ui.dip(seconds)`. A retry of the current wave emits `wave:start {index, wave,
  retry:true}` (after ending any running grab with reason `'restart'`): HUD, PostFX and
  Audio drop whatever the previous attempt left running (telegraph marks, screen
  effects, the grab loop, the music phase). `director.introSkipped` is true when the
  current intro was skipped: UI cuts to black (`dip`) at the intro's end only then — the
  natural end hands the plunging camera straight to the wave card. Menu buttons stop
  their mousedown from propagating (Input ignores mouse buttons on menu screens anyway).
  An off-screen threat arc is drawn only while neither the enemy's centre nor its mouth
  (`getMouthPosition()`) is on screen, so a 16 m megalodon whose head fills the edge gets
  none.
  - DOM/CSS namespace: root `.fish`, classes and keyframes `fish-*`, title SVG filter
    `fish-ink-filter`. UI scripts and browser scenarios use the same names.
  - First-time guidance. StrikeHint flashes 「现在 —— E 格挡」 on the first two
    `enemy:strike` cues of wave 0, once per page session, for ≈1.3 s. It sits beside the
    lock reticle when the striker is locked, else inward of its off-screen threat arc, else
    beside its head, and follows that anchor. A parry, a perfect dodge or a hit hurries it
    out; leaving `'playing'` or a retry hides it. `LockReticle.anchorFor(enemy,
    out)` and `ThreatIndicators.anchorFor(enemy, out)` give its anchor in CSS px, or null
    when that piece isn't shown on the enemy.
  - The wave-0 tips (12 s) list movement (WASD 游动 · Space/C 上下) above the combat keys.
    The grab prompt reads 「狂按 左键/J —— 刺它的眼！」, and the controls panel says a parry
    works mid-charge (「蓄力中也可格挡」).
  - The HUD fades in 1 s late in `'transition'`, after the letterbox has retracted, and the
    wave card sits in the right third, clear of 老公.
  - The centre combat words 格挡 / 闪避 have their own anchors (0.58 h / 0.66 h); a new
    centre word hurries a running one out, and 要害 shows at most once per 0.3 s.
- **Enemies (assets).** Species meshes / textures build incrementally ahead of use: the
  prefetch is pumped with a per-frame time budget during title, intro and the wave card
  (not only from idle callbacks), so a wave's sharks are ready before its reveal and no
  single build or upload step becomes a long main-thread task. The big banded skin maps
  are uploaded into raw GL textures (`THREE.ExternalTexture`), whose pixels are dropped
  after the upload. As a result:
  - `renderer.info.memory.textures` doesn't count them.
  - three can't restore them after a WebGL context loss. On `webglcontextrestored`,
    `SharkAssetLibrary` repaints and re-uploads them: species on screen at once, the rest
    in the background, and half-built bundles start over.
  - Shark heads (megalodon and great white): a pointed, crease-free snout tip
    (`noseCone`, SharkAnatomy — the default elliptical cap ends in a crease ring that read
    as a dolphin's beak), the snout grey down to the jaw line (`colors.snoutGrey` — no pale
    muzzle head-on or from below), gill slits that stop on the flank (`gills.bottom`
    −30° / −35°, not wrapping under the throat like whale pleats) and an axillary spot of
    at most 0.11 m whatever the length. Iterate with `scripts/enemies-sharkview.mjs`.
- **Core.** `game.init()` is async (see Boot). `game.quality` / `game.qualitySource` /
  `game.gpu` (see Quality); the title screen persists a picked preset with
  `localStorage.setItem('fish.quality', q)` (in a try/catch) before reloading. `Input`
  ignores mouse buttons on menu screens and while in play without pointer lock (see
  Controls). A pause inside `director.update` skips that frame's simulation (see Frame
  order).

## Performance budget

Target 60 fps at 1080p on a mid-range GPU with `quality=high`; `low` must be
playable on integrated graphics. No per-frame allocations in hot loops (reuse
temp vectors), instancing for repeated meshes, ≤ ~250 draw calls, one
shadow-casting light, shadow map ≤ 2048. Headless SwiftShader (smoke tests) is
~10–50× slower than a real GPU — judge correctness there, not fps.

Measure GPU cost with `scripts/smoke.mjs --perf` (synced frames: every frame is bracketed
by a 1×1 `readPixels` barrier — `gl.finish()` does not wait in Chromium), which reports
p50/p95 synced and CPU frame time, per-composer-pass time and `renderer.info` per quality,
for the live fight and for a deterministic `frozen` view (enemies parked, VFX cleared, 老公
at the spawn, rig yaw −0.35 / pitch 0, one frame re-rendered with `realDt` 0). The fight
view depends on random spawns and the AI, so compare presets on `frozen`, relative to each
other on the same backend, never absolute ms.

Synced and stepped runs (`--perf`, `--step`) wait for the GPU every frame, so they never
build up a GPU backlog, and they hide first-use stalls: a program's first draw blocks
until every queued frame is done. Measure hitches on the real rAF loop of a production
page (`/?quality=high`, no `fixeddt`), with long tasks, rAF gaps and the time spent in
synchronous GL queries: `scripts/render-checks.mjs` (`revealWave0`, `revealCold`). The
acceptance is no task > 100 ms and < 5 ms of synchronous GL queries at a shark reveal, and
0 programs compiled while playing.
