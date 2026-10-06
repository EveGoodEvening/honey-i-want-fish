// PostFX — makes the frame read as filmed underwater. See docs/DESIGN.md "PostFX".
//
// Pipeline (EffectComposer, linear HDR HalfFloat buffers):
//
//   ScenePass        scene → MSAA float target (4x high, 2x medium, 0 low;
//                    R11F_G11F_B10F where renderable, else RGBA16F) →
//                    resolve with a firefly clamp
//   GodRaysPass      quarter-res light shafts toward the projected sun (high/medium,
//                    only while the camera looks up toward the surface)
//   UnrealBloomPass  subtle, teal-tinted, excess-over-threshold bright pass
//                    (knife glints, fish sparkles, bioluminescence), half-res
//                    chain with mip weights re-balanced to match full-res
//   UnderwaterPass   refraction wobble, shock rings, zoom blur, god-ray
//                    composite, lens particulate, flashes, eye-adaptation exposure
//   OutputPass       renderer.toneMapping (ACES) + sRGB — the ONLY tone mapping
//   FXAAPass         (low quality only; needs sRGB input)
//   GradePass        display-space chromatic aberration, grading, danger/HP
//                    vignette + heartbeat, red edge pulses, grain + dither → screen
//
// Rendering into render targets disables the renderer's own tone mapping /
// output transfer, so ACES is applied exactly once (by OutputPass). With
// ?nopost the scene is rendered straight to the canvas and the renderer
// applies ACES + sRGB itself.
//
// Public API (contract): render(dt), setSize(w, h), flash(color, intensity,
// duration), pulse(type). Extensions: pulse(type, { position, strength }) where
// `position` is a world-space Vector3 used to centre rings/blur; extra pulse
// types 'perfectDodge', 'strike', 'crit'; warmup(object = scene) precompiles
// shaders for the real render target without blocking, then primes them
// (first-use link check + reflection) once the GPU is idle (called once after
// the first frame; other modules may call it for objects created later, e.g.
// EnemyManager's throw-away shark rigs, which a dry render also draws once).
// A GPU-bound loop is never idle, so while a warm-up is pending the title,
// the intro and the wave card ('transition') hold their frames — render()
// keeps the last image — for at most 1 s per warm-up (3 s for the boot one),
// then finish it synchronously, still behind that screen: the shark reveal
// never pays for first use. See _settle / _holdFrame. A WebGL context loss
// drops every pending warm-up and hold; the restore warms the scene again.
// PostFX also listens to gameplay events itself (player:hit, player:parry,
// grab:*, enemy:roar, ...) so the feedback works even if a caller forgets;
// re-triggering a pulse restarts it, so double calls are harmless. An
// enemy:telegraph within TELEGRAPH_RANGE squeezes the vignette into a short
// "tunnel" over the wind-up, released on that enemy's enemy:attack.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { ScenePass } from './passes/ScenePass.js';
import { GodRaysPass } from './passes/GodRaysPass.js';
import { createUnderwaterShader } from './shaders/UnderwaterShader.js';
import { createGradeShader } from './shaders/GradeShader.js';
import { createParticulateTexture } from './textures/particulateTexture.js';
import { FxState, PULSE_DURATION } from './FxState.js';
import { WORLD } from '../core/config.js';

// dirt: lens particulate strength. Low on purpose: the big bokeh discs are lit
// only by the sun/god-ray term (see UnderwaterShader), so they show when
// looking toward the light and never sit on screen like a dirty lens.
// deepStopK: share of the look-up stop-down kept in deep water (LOOKUP_STOP_*);
// smaller without bloom, whose glow otherwise carries the dim deep window
// (low, -41 m look-up: 4.6 % of pixels > 150 at 0.2, ≈5.7 % at 0.1).
const QUALITY = {
  high: { samples: 4, bloom: true, bloomScale: 0.5, godRays: true, godRaySamples: 28, radialSamples: 10, dirt: 0.22, grain: 0.034, fxaa: false, deepStopK: 0.2 },
  medium: { samples: 2, bloom: true, bloomScale: 0.5, godRays: true, godRaySamples: 20, radialSamples: 8, dirt: 0.18, grain: 0.032, fxaa: false, deepStopK: 0.2 },
  low: { samples: 0, bloom: false, bloomScale: 0.5, godRays: false, godRaySamples: 12, radialSamples: 5, dirt: 0, grain: 0.028, fxaa: true, deepStopK: 0.1 },
};

// Bloom mip weights. The full-res chain (scale 1) is the reference look:
// factors with UnrealBloom's radius blend 0.2 (weight = 0.6 f + 0.24). A
// half-res chain's mip k is ~2x wider (between full-res mips k and k+1), so
// it uses radius 0 (weight = factor) and weights pulled toward the tight
// mips; measured against the full-res reference on lavapipe (sun shafts /
// Snell window): mean |diff| 0.45 / 0.17 of 255, versus 3.8 / 1.0 with the
// full-res weights unchanged.
const BLOOM_FULL = { radius: 0.2, factors: [1.0, 0.75, 0.45, 0.25, 0.12] };
const BLOOM_HALF = { radius: 0, factors: [1.45, 0.55, 0.38, 0.26, 0.1] };

// Shader warm-up (see warmup / _settle): poll interval, the wait when the
// driver can't be asked, the main-thread slice for priming programs, the
// longest the title may hold its frames for the boot warm-up, and the longest
// any later warm-up (a shark species finished behind the title, the intro or
// the wave card) may hold them before it is finished synchronously.
const WARM_POLL = 20; // ms
const WARM_BLIND_WAIT = 400; // ms
const PRIME_BUDGET = 30; // ms
const BOOT_HOLD_MAX = 3000; // ms
const JOB_HOLD_MAX = 1000; // ms
// A warm-up whose programs still aren't built after this long is dropped
// unprimed (their first draw primes them, as without a warm-up) rather than
// left pending for good. Compiles take ≤ ~1 s even on lavapipe; this is a
// safety net (context losses are handled directly: see _onContextLost).
const WARM_GIVE_UP = 10000; // ms
// Screens whose frames may be held (render() keeps the last image) while a
// warm-up finishes: the title, the intro (its first 8.6 s are a black veil)
// and the wave card. Never 'playing': there a warm-up only primes when the GPU
// happens to be idle, and waits for the next card for the rest.
const HOLD_STATES = new Set(['title', 'intro', 'transition']);
// A detached warm-up object (a shark rig) is drawn this far in front of the
// camera by the dry render (frustum culling off, 1×1 viewport).
const DRY_AHEAD = 20; // m

const TELEGRAPH_RANGE = 30; // m (from the enemy's nearest end) for the wind-up tunnel
const WINDUP_VIGNETTE = 0.22; // vignette strength added at full wind-up
const WINDUP_INNER = 0.1; // inner radius pulled in at full wind-up

const DEFAULT_SUN = new THREE.Vector3(0.25, 1, 0.15).normalize();
// ACES' toe crushes the dark teal underwater palette (~0.3x in linear at the
// water colour); a small base exposure keeps the murk readable.
const BASE_EXPOSURE = 1.1;
// Eye adaptation when looking up at Snell's window: the full stop-down
// (exposure × (1 − LOOKUP_STOP)) holds to LOOKUP_STOP_SHALLOW m of depth, then
// fades to the preset's deepStopK of it by LOOKUP_STOP_DEEP m, where the
// absorbed window is a dim disc that a full stop would sink into the murk.
const LOOKUP_STOP = 0.42;
const LOOKUP_STOP_SHALLOW = 20; // m
const LOOKUP_STOP_DEEP = 45; // m
// Eye adaptation to depth: below DEEP_ADAPT_FROM m the light keeps falling
// ~4 % per metre, and out over the trench the abyss returns less of it
// (Environment dims the water up to 38 % where the floor drops from
// ABYSS_FLOOR[0] to [1] m), so the eye — like a documentary camera — opens up
// to win part of it back: exposure × (1 + (DEEP_ADAPT_GAIN + ABYSS_ADAPT_GAIN
// · abyss) · smoothstep(FROM, TO, depth)). Nothing changes above FROM (the
// arena floor is at -46 m; ≤ +3 sRGB levels at a 45 m camera): the mid-water
// murk and the boss blotting out the sun keep their weight. Measured on
// lavapipe (high, frame mean luma, level view, before → after): over the
// trench wall at 50 m 21 → 27; the boss broadside over the abyss at 50 m
// 21 → ≈26; at 60 m 13 → 20 — still the darkest band.
const DEEP_ADAPT_FROM = 40; // m
const DEEP_ADAPT_TO = 62; // m
const DEEP_ADAPT_GAIN = 0.7;
const ABYSS_ADAPT_GAIN = 0.3;
const ABYSS_FLOOR = [-58, -120]; // m (the seabed under the camera)
// The payoff after the last kill (the victory beat and screen): a further
// lift when it plays out deep, faded in around VICTORY_LIFT_DEPTH ± 5 m
// (victory camera at 57 m over the trench: luma 17 → ≈37).
const VICTORY_LIFT = 1.5;
const VICTORY_LIFT_DEPTH = 40; // m
const PARRY_FLASH = new THREE.Color(0.78, 0.95, 1.0);
const VIG_TEAL = new THREE.Vector3(0.0, 0.012, 0.016);
const VIG_RED = new THREE.Vector3(0.34, 0.008, 0.012);

// Module-level temporaries (render path must not allocate).
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _uv = new THREE.Vector2();
const _color = new THREE.Color();
const _v4 = new THREE.Vector4();
const _dryPos = new THREE.Vector3();
const _dryDir = new THREE.Vector3();

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * UnrealBloomPass with two changes:
 *  - its internal resolution can be scaled down (medium quality)
 *  - the bright-pass keeps only the energy *above* the threshold (soft knee)
 *    instead of the full colour of every pixel over it. With the stock
 *    high-pass a large bright area (Snell's window overhead) floods the whole
 *    frame and washes out the dark silhouettes against it — exactly the
 *    shapes (a shark passing overhead) that must stay black.
 */
class ScaledBloomPass extends UnrealBloomPass {
  constructor(resolution, strength, radius, threshold, scale = 1) {
    super(resolution, strength, radius, threshold);
    this.scale = scale;
    this.highPassUniforms.uKnee = { value: 0.8 };
    this.materialHighPassFilter.dispose();
    this.materialHighPassFilter = new THREE.ShaderMaterial({
      uniforms: this.highPassUniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float luminosityThreshold;
        uniform float uKnee;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float x = max(l - luminosityThreshold, 0.0);
          float excess = x * x / (x + uKnee);
          gl_FragColor = vec4(c * (excess / max(l, 1e-4)), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
  }

  setSize(width, height) {
    super.setSize(Math.max(2, Math.round(width * this.scale)), Math.max(2, Math.round(height * this.scale)));
  }
}

export class PostFX {
  constructor(game) {
    this.game = game;
    this.quality = QUALITY[game.quality] ?? QUALITY.high;
    this.fx = new FxState();
    this.enabled = true;

    // continuous state
    this._time = 0;
    this._beatPhase = 0;
    this._beat = 0;
    this._lastYaw = null;
    this._lastPitch = 0;
    this._dirtOffset = new THREE.Vector4(0.13, 0.71, 0.42, 0.27);
    this._godRayLevel = 0;
    this._exposure = BASE_EXPOSURE;
    this._holdUntil = 0; // title frames held back during the boot warm-up (see _bootWarmup)
    this._settling = []; // warm-ups waiting to prime their programs (see _settle)
    this._primed = new WeakSet(); // programs whose first-use queries a warm-up already ran
    this._settleTimer = 0;
    this._started = false; // start() ran (a context restore warms up again)
    this._width = 1;
    this._height = 1;

    this._build();
    this._listen();
    // WebGL context loss / restore (see _onContextLost)
    this._onLost = () => this._onContextLost();
    this._onRestored = () => this._onContextRestored();
    const canvas = game.renderer?.domElement;
    canvas?.addEventListener?.('webglcontextlost', this._onLost, false);
    canvas?.addEventListener?.('webglcontextrestored', this._onRestored, false);
  }

  // ---------------------------------------------------------------- setup

  _build() {
    const { renderer, scene, camera } = this.game;
    const q = this.quality;
    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();

    // HDR buffers need a float-renderable colour attachment.
    const floatOk = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
    const type = floatOk ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.hdr = floatOk;
    const samples = Math.min(q.samples, renderer.capabilities.maxSamples ?? 0);

    const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x * pr), Math.max(1, size.y * pr), {
      type,
      depthBuffer: samples === 0, // ScenePass renders straight into it without MSAA
      stencilBuffer: false,
    });
    rt.texture.name = 'PostFX.rt';
    this.composer = new EffectComposer(renderer, rt);

    const compact = floatOk && samples > 0 && this._compactSupported(samples);
    this.scenePass = new ScenePass(scene, camera, { samples, type, compact });
    this.composer.addPass(this.scenePass);

    this.godRaysPass = new GodRaysPass({ samples: q.godRaySamples, type });
    this.godRaysPass.enabled = false;
    this.composer.addPass(this.godRaysPass);

    if (q.bloom) {
      this.bloomPass = new ScaledBloomPass(new THREE.Vector2(size.x * pr, size.y * pr), 0.5, 0.2, 1.4, q.bloomScale);
      // Larger mips drift toward teal: light scattered over distance loses red.
      const tints = [
        [1.0, 1.0, 1.0],
        [0.92, 1.0, 1.0],
        [0.82, 0.98, 1.0],
        [0.7, 0.95, 1.0],
        [0.6, 0.92, 1.0],
      ];
      this.bloomPass.bloomTintColors.forEach((c, i) => c.set(...tints[i]));
      // favour the tight mips: wide mips over a big bright area become a
      // veiling glare that greys out silhouettes against the surface
      const weights = q.bloomScale < 0.75 ? BLOOM_HALF : BLOOM_FULL;
      this.bloomPass.radius = weights.radius;
      this.bloomPass.compositeMaterial.uniforms.bloomFactors.value = weights.factors.slice();
      this.composer.addPass(this.bloomPass);
    }

    this.underwaterPass = new ShaderPass(createUnderwaterShader({ radialSamples: q.radialSamples }));
    this.underwaterPass.uniforms.tGodRays.value = this.godRaysPass.texture;
    this.dirtTexture = createParticulateTexture();
    this.underwaterPass.uniforms.tDirt.value = this.dirtTexture;
    this.underwaterPass.uniforms.uDirt.value = q.dirt;
    this.composer.addPass(this.underwaterPass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    if (q.fxaa) {
      this.fxaaPass = new FXAAPass();
      this.composer.addPass(this.fxaaPass);
    }

    this.gradePass = new ShaderPass(createGradeShader());
    this.gradePass.uniforms.uGrain.value = q.grain;
    this.composer.addPass(this.gradePass);

    this.setSize(size.x, size.y);
  }

  // R11F_G11F_B10F is colour-renderable with EXT_color_buffer_float; check
  // that it also supports this many MSAA samples.
  _compactSupported(samples) {
    const renderer = this.game.renderer;
    const gl = renderer.getContext();
    if (typeof gl.getInternalformatParameter !== 'function' || gl.R11F_G11F_B10F === undefined) return false;
    if (!renderer.extensions.has('EXT_color_buffer_float')) return false;
    try {
      const counts = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.R11F_G11F_B10F, gl.SAMPLES);
      if (!counts) return false;
      for (let i = 0; i < counts.length; i++) if (counts[i] >= samples) return true;
    } catch {
      /* fall back to RGBA16F */
    }
    return false;
  }

  _listen() {
    const ev = this.game.events;
    ev.on('player:hit', (p) => {
      const heavy = !!p?.heavy || (p?.damage ?? 0) >= 22;
      this.pulse(heavy ? 'heavyHit' : 'hit', { position: p?.sourcePosition });
    });
    ev.on('player:parry', (p) => {
      if (!p?.success) return;
      // centre the shock ring between the player and the parried enemy
      const player = this.game.player;
      const enemy = p.enemy;
      if (player?.position && enemy?.position) {
        _v.copy(player.position).lerp(enemy.position, 0.25);
        this.pulse('parry', { position: _v });
      } else this.pulse('parry');
    });
    ev.on('player:perfectDodge', () => this.pulse('perfectDodge'));
    ev.on('player:dodge', () => this.pulse('dodge', { strength: 0.8 }));
    ev.on('grab:start', () => this.pulse('grab'));
    ev.on('grab:end', () => this.fx.releaseGrab());
    ev.on('enemy:roar', (p) => {
      const e = p?.enemy;
      const pos = e?.getMouthPosition?.() ?? e?.position;
      this.pulse('roar', { position: pos });
    });
    ev.on('enemy:death', (p) => {
      this.fx.releaseTelegraph(p?.enemy);
      this.pulse('kill', { strength: p?.enemy?.isBoss ? 1.3 : 1 });
    });
    ev.on('enemy:hit', (p) => {
      if (!p || p.killed) return;
      if (p.critical || p.attackType === 'heavy') this.pulse('crit', { position: p.position });
      else this.pulse('strike');
    });
    // Attack wind-up: the world closes in while a nearby enemy coils.
    ev.on('enemy:telegraph', (p) => {
      const e = p?.enemy;
      const player = this.game.player;
      if (!e?.position || !player?.position) return;
      const reach = e.position.distanceTo(player.position) - 0.5 * (e.length ?? 0);
      if (reach > TELEGRAPH_RANGE) return;
      this.fx.telegraph(e, p.duration ?? 0.7, e.isBoss ? 1.2 : 1);
    });
    ev.on('enemy:attack', (p) => this.fx.releaseTelegraph(p?.enemy));
    ev.on('wave:start', (p) => {
      // retry of the current wave: no hurt/grab/wind-up effects carried over
      if (p?.retry) this.fx.clear();
    });
    ev.on('game:state', ({ from, to } = {}) => {
      // fresh start / retry / back to the title: drop lingering effects
      if (to === 'title' || (to === 'playing' && (from === 'dead' || from === 'title' || from === 'intro' || from === 'boot'))) this.fx.clear();
    });
  }

  /**
   * Optional start(): once the first frame is on screen, precompile every
   * shader in the scene (hidden objects too: VFX pools, the knife trail, the
   * whale) so the first blood, impact or whale pass doesn't stall on a
   * compile mid-fight.
   */
  start() {
    this._started = true;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    // The first rAF still runs before the first frame; the second one after it.
    raf(() => raf(() => this._bootWarmup()));
  }

  // The first frame drew everything once (Environment's warm frame) and built
  // its programs; now build the rest. On the title, new frames are held back
  // (render() keeps the last image; the boot splash is fading over it) until
  // they are built and primed: frames queued behind the compiles would make
  // every status query wait for them too, and leave no idle moment to prime.
  // Before letting go, one off-screen render of the scene as the next frame
  // will draw it (culled, far LOD materials, shadow casters) builds what the
  // warm frame and compile() can't: e.g. shadow-depth variants.
  _bootWarmup() {
    if (this.game.state === 'title') this._holdUntil = performance.now() + BOOT_HOLD_MAX;
    const release = () => {
      this._holdUntil = 0;
    };
    this.warmup()
      .then(() => new Promise((resolve) => setTimeout(resolve, 0))) // own task, between frames
      .then(() => {
        if (this._holdUntil > 0 && this.game.state === 'title') this._dryRender();
      })
      .then(release, release);
  }

  // A lost WebGL context takes the pending warm-ups' fences and programs with
  // it: their status queries never answer again (objects of a dead context),
  // so those jobs would wait — and keep polling — for good. Drop them all
  // (resolved, so callers such as EnemyManager dispose their rigs; a dead
  // sync object is never deleted), forget what was primed and release any
  // title / card hold.
  _onContextLost() {
    clearTimeout(this._settleTimer);
    this._settleTimer = 0;
    this._holdUntil = 0;
    const jobs = this._settling.splice(0);
    for (const job of jobs) {
      job.sync = null;
      job.todo.clear();
      job.resolve();
    }
    this._primed = new WeakSet();
  }

  // three rebuilds every program after a restore (the frames after it compile
  // what they draw): warm the rest of the scene again, as after boot.
  _onContextRestored() {
    if (this._started) this.start();
  }

  // Renders game.scene once into the real scene target through a 1×1
  // viewport: the same programs (and, on Vulkan/D3D/Metal backends, the same
  // pipelines) as the next frame, with next to no fragment work besides the
  // shadow map. The next frame overwrites the target.
  // `object` (optional, detached — a warm-up's shark rig) is drawn with it:
  // added to the scene for this render only, DRY_AHEAD m in front of the
  // camera with frustum culling off, so its draws (and its shadow-depth
  // variant) set up their GPU pipelines and texture uploads now, behind the
  // title / card, instead of on the frame that reveals the shark.
  _dryRender(object = null) {
    const { renderer, scene, camera } = this.game;
    if (this.game.debug?.noPost || !this.enabled) return;
    const target = this.scenePass.target ?? this.composer.readBuffer;
    const prev = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const attach = !!object && object !== scene && !object.parent;
    let culled = null;
    _v4.copy(target.viewport);
    try {
      if (attach) {
        _dryPos.copy(object.position);
        camera.getWorldDirection(_dryDir);
        object.position.copy(camera.position).addScaledVector(_dryDir, DRY_AHEAD);
        culled = [];
        object.traverse((o) => {
          if (o.frustumCulled) {
            culled.push(o);
            o.frustumCulled = false;
          }
        });
        scene.add(object);
      }
      renderer.autoClear = true;
      target.viewport.set(0, 0, 1, 1);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    } catch (err) {
      console.warn('[PostFX] warm-up render failed', err);
    } finally {
      target.viewport.copy(_v4);
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(prev);
      if (attach) {
        scene.remove(object);
        object.position.copy(_dryPos);
        object.updateMatrixWorld(true);
        for (const o of culled) o.frustumCulled = true;
      }
    }
  }

  /**
   * Precompile the programs for every material under `object` (default: the
   * whole scene, invisible objects included) exactly as the frame renders
   * them: three keys tone mapping / output colour space on the bound render
   * target, so compiling against the canvas (null target) would build the
   * wrong (ACES + sRGB) variant. With the whole scene it also builds the
   * on-demand passes (god rays). Returns a promise → true when done.
   * Never call it from inside render().
   *
   * Nothing here blocks: compiling only queues GL work. A program's first
   * draw then runs its link check + uniform reflection — synchronous queries
   * that wait for every shader still in the queue and for the frames in
   * flight — so no pass is drawn here; _settle() runs that first-use work
   * later, once the GPU is idle. A detached `object` (not in the scene) with
   * programs no earlier warm-up primed is also drawn once by a dry render
   * (see _dryRender) behind the title / card.
   */
  warmup(object = this.game.scene) {
    const { renderer, scene, camera } = this.game;
    if (!object || !renderer?.compile) return Promise.resolve(false);
    // nothing to build on a lost context (three rebuilds after the restore)
    if (renderer.getContext().isContextLost?.()) return Promise.resolve(false);
    const direct = !!this.game.debug?.noPost || !this.enabled;
    const prev = renderer.getRenderTarget();
    let materials;
    try {
      renderer.setRenderTarget(direct ? null : this.scenePass.target ?? this.composer.readBuffer);
      materials = renderer.compile(object, camera, scene);
    } catch (err) {
      console.warn('[PostFX] shader warm-up failed', err);
      return Promise.resolve(false);
    } finally {
      renderer.setRenderTarget(prev);
    }
    // passes that only run on demand (god rays: only when looking up)
    if (!direct && object === scene && this.quality.godRays) {
      try {
        for (const m of this.godRaysPass.compile(renderer)) materials.add(m);
      } catch (err) {
        console.warn('[PostFX] god-ray warm-up failed', err);
      }
    }
    const dry = !direct && object !== scene && !object.parent ? object : null;
    return this._settle(materials, dry).then(
      () => true,
      () => false,
    );
  }

  /**
   * Resolves once the programs of `materials` are built and primed (their
   * first-use queries run), without ever blocking on the driver. A job runs
   * through three phases, one step per call of _pumpSettle():
   *  - 'prime': once built (KHR_parallel_shader_compile's completion status
   *    when available) and the GPU is idle — a WebGL2 fence placed behind the
   *    queued work has passed and nothing was rendered after it — the
   *    programs' first-use queries run in PRIME_BUDGET ms slices;
   *  - 'dry' (only with a `dryObject`): one dry render of the scene with the
   *    object, on the title / intro / card only;
   *  - 'drain': waits for the GPU to finish that render.
   * Idleness is checked between frames and at the start of render(), which
   * re-arms the fences after each frame. A GPU-bound loop is never idle, so on
   * the title / intro / card render() holds its frames for a job that is ready
   * to prime (at most JOB_HOLD_MAX ms per job, then the rest runs at once —
   * see _holdFrame). While playing, a job only advances when the GPU happens
   * to be idle, and a dry render waits for the next card. Without fences the
   * idle check waits WARM_BLIND_WAIT ms instead. Programs an earlier warm-up
   * already primed (or is priming) are skipped: a job left with nothing to do
   * resolves at once.
   */
  _settle(materials, dryObject = null) {
    const props = this.game.renderer.properties;
    const job = { todo: new Set(), phase: 'prime', dry: null, sync: null, mark: -1, t0: performance.now(), holdFrom: -1, resolve: null };
    for (const m of materials) {
      const program = props.get(m).currentProgram;
      if (program && !this._primed.has(program) && !this._pending(program)) job.todo.add(program);
    }
    if (!job.todo.size) return Promise.resolve();
    job.dry = dryObject;
    const done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this._settling.push(job);
    this._armFence(job);
    this._pollSettle();
    return done;
  }

  _pending(program) {
    const S = this._settling;
    for (let i = 0; i < S.length; i++) if (S[i].todo.has(program)) return true;
    return false;
  }

  _armFence(job) {
    const renderer = this.game.renderer;
    const gl = renderer.getContext();
    if (job.sync) gl.deleteSync(job.sync);
    job.sync = typeof gl.fenceSync === 'function' ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
    gl.flush();
    job.mark = renderer.info.render.frame; // a render after this = GPU work behind the fence
  }

  _finishSettle(job) {
    if (job.sync) this.game.renderer.getContext().deleteSync(job.sync);
    job.sync = null;
    const i = this._settling.indexOf(job);
    if (i >= 0) this._settling.splice(i, 1);
    job.resolve();
  }

  // A job in its dry-render phase can only advance on the title / intro / card.
  _parked(job) {
    return job.phase === 'dry' && !HOLD_STATES.has(this.game.state);
  }

  // Timer between frames (render() also pumps); stops when nothing pending can
  // advance without a frame (render() restarts it).
  _pollSettle() {
    if (this._settleTimer) return;
    const S = this._settling;
    let live = false;
    for (let i = 0; i < S.length && !live; i++) live = !this._parked(S[i]);
    if (!live) return;
    this._settleTimer = setTimeout(() => {
      this._settleTimer = 0;
      this._pumpSettle();
      this._pollSettle();
    }, WARM_POLL);
  }

  // Programs released meanwhile (material disposed) need nothing; true once
  // the rest are built.
  _compiled(job, parallel) {
    for (const p of job.todo) if (!p.program || p.usedTimes <= 0) job.todo.delete(p);
    if (parallel) for (const p of job.todo) if (!p.isReady()) return false;
    return true;
  }

  // Non-blocking: a fence's status only updates between tasks.
  _gpuIdle(job, gl, frame, parallel) {
    if (job.sync) {
      if (gl.getSyncParameter(job.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return false;
      if (frame !== job.mark) {
        this._armFence(job); // rendered behind the fence: wait for that too
        return false;
      }
      return true;
    }
    return parallel || performance.now() - job.t0 >= WARM_BLIND_WAIT;
  }

  // Runs first-use queries for up to PRIME_BUDGET ms (at least one program).
  _primeSlice(job, budget = PRIME_BUDGET) {
    const s = performance.now();
    try {
      for (const p of job.todo) {
        job.todo.delete(p);
        p.getUniforms(); // link check + uniform/attribute reflection, cached by three
        this._primed.add(p);
        if (performance.now() - s > budget) break;
      }
    } catch (err) {
      console.warn('[PostFX] shader priming failed', err);
      job.todo.clear();
    }
  }

  // Advances the pending warm-ups by one step (one prime slice, the dry
  // render, or finishing a drained job) per call.
  _pumpSettle() {
    const renderer = this.game.renderer;
    const gl = renderer.getContext();
    const frame = renderer.info.render.frame;
    const parallel = renderer.extensions.has('KHR_parallel_shader_compile');
    for (let i = 0; i < this._settling.length; i++) {
      const job = this._settling[i];
      if (this._parked(job)) continue;
      if (job.phase === 'prime' && !this._compiled(job, parallel)) {
        if (performance.now() - job.t0 < WARM_GIVE_UP) continue;
        this._finishSettle(job); // still not built: give up (see WARM_GIVE_UP)
        return;
      }
      if (!this._gpuIdle(job, gl, frame, parallel)) continue;
      if (job.phase === 'prime') {
        this._primeSlice(job);
        if (job.todo.size) this._armFence(job);
        else if (job.dry) {
          job.phase = 'dry'; // next: the dry render, on an idle GPU again
          this._armFence(job);
        } else this._finishSettle(job);
      } else if (job.phase === 'dry') {
        this._dryRender(job.dry);
        job.phase = 'drain';
        this._armFence(job);
      } else this._finishSettle(job); // 'drain': the GPU is done with the dry render
      return;
    }
  }

  // The job render() holds frames for: the oldest that can use an idle GPU
  // now (built, or past priming).
  _holdJob() {
    const S = this._settling;
    if (!S.length) return null;
    const parallel = this.game.renderer.extensions.has('KHR_parallel_shader_compile');
    for (let i = 0; i < S.length; i++) {
      const job = S[i];
      if (job.phase !== 'prime' || this._compiled(job, parallel)) return job;
    }
    return null;
  }

  // True: skip this frame (render() keeps the last image). Holds the boot
  // warm-up on the title (BOOT_HOLD_MAX), and any warm-up ready to prime on
  // the title / intro / card, up to JOB_HOLD_MAX per job (boot hold time
  // counts); past that, the job's remaining first-use queries and its dry
  // render run right here, while the screen still hides the scene, rather
  // than on the frame that first draws the shark.
  _holdFrame() {
    const state = this.game.state;
    const now = performance.now();
    const holdable = HOLD_STATES.has(state);
    // a job left over from play gets a fresh hold on the next card
    if (!holdable) for (let i = 0; i < this._settling.length; i++) this._settling[i].holdFrom = -1;
    const job = holdable ? this._holdJob() : null;
    if (job && job.holdFrom < 0) job.holdFrom = now;
    if (this._holdUntil > 0) {
      if (state === 'title' && now < this._holdUntil) return true;
      this._holdUntil = 0;
    }
    if (!job) return false;
    if (now - job.holdFrom < JOB_HOLD_MAX) return true;
    this._primeSlice(job, Infinity);
    if (job.phase !== 'drain' && job.dry) this._dryRender(job.dry);
    this._finishSettle(job);
    return false;
  }

  // ---------------------------------------------------------------- API

  setSize(w, h) {
    const pr = this.game.renderer.getPixelRatio();
    this._width = Math.max(1, w);
    this._height = Math.max(1, h);
    this.composer.setSize(this._width, this._height);
    const aspect = this._width / this._height;
    this.underwaterPass.uniforms.uAspect.value = aspect;
    this.gradePass.uniforms.uAspect.value = aspect;
    this.gradePass.uniforms.uResolution.value.set(this._width * pr, this._height * pr);
  }

  /**
   * Full-screen colour tint, e.g. flash(0xff0000, 0.6, 0.4) when hurt.
   * `color` accepts anything THREE.Color.set accepts (hex number, CSS string, Color).
   */
  flash(color = 0xffffff, intensity = 0.5, duration = 0.3) {
    try {
      _color.set(color);
    } catch {
      _color.setRGB(1, 1, 1);
    }
    this.fx.flash(_color, Math.max(0, Math.min(1.5, intensity)), duration, 0);
  }

  /**
   * Named one-shot effect: 'hit' | 'heavyHit' | 'parry' | 'grab' | 'kill' |
   * 'dodge' | 'roar' (+ 'perfectDodge' | 'strike' | 'crit').
   * opts.position (world Vector3) centres rings / zoom blur on that point;
   * opts.strength scales the effect (default 1). Unknown types are ignored.
   */
  pulse(type, opts = undefined) {
    if (!(type in PULSE_DURATION)) return;
    const strength = opts?.strength ?? 1;
    let center = null;
    if (opts?.position && this._projectToUv(opts.position, _uv)) center = _uv;
    this.fx.trigger(type, strength, center);
    if (type === 'parry') this.fx.flash(PARRY_FLASH, 0.95 * strength, 0.3, 1);
  }

  render(dt) {
    const game = this.game;
    const renderer = game.renderer;
    // pending warm-ups: before this frame's work is the moment the GPU may be idle
    if (this._settling.length) {
      this._pumpSettle();
      this._pollSettle(); // (re)starts the between-frames timer, e.g. on reaching a card
    }
    // a warm-up on the title / intro / card: keep showing the last frame (bounded)
    if ((this._holdUntil > 0 || this._settling.length) && this._holdFrame()) return;
    // Count every pass of the frame in renderer.info (Game reads it for stats).
    renderer.info.autoReset = false;
    renderer.info.reset();

    if (game.debug.noPost || !this.enabled) {
      renderer.setRenderTarget(null);
      renderer.render(game.scene, game.camera);
    } else {
      const realDt = game.time?.realDt ?? dt ?? 1 / 60;
      this.scenePass.scene = game.scene;
      this.scenePass.camera = game.camera;
      this._update(realDt);
      this.composer.render(realDt);
    }
    // keep the pending warm-ups' fences behind the newest frame (a parked
    // job re-arms when it can advance again: _gpuIdle sees the stale mark)
    const S = this._settling;
    for (let i = 0; i < S.length; i++) if (S[i].mark !== renderer.info.render.frame && !this._parked(S[i])) this._armFence(S[i]);
  }

  // ---------------------------------------------------------------- internals

  _projectToUv(world, out) {
    const cam = this.game.camera;
    if (!world || typeof world.x !== 'number') return false;
    cam.updateMatrixWorld();
    _v.copy(world).applyMatrix4(cam.matrixWorldInverse);
    if (_v.z > -0.1) {
      out.set(0.5, 0.5); // behind the camera: centre
      return true;
    }
    _v.applyMatrix4(cam.projectionMatrix);
    out.set(Math.min(1.3, Math.max(-0.3, _v.x * 0.5 + 0.5)), Math.min(1.3, Math.max(-0.3, _v.y * 0.5 + 0.5)));
    return true;
  }

  _isGrabHeld() {
    const g = this.game;
    return !!(g.combat?.grab || g.player?.grabbedBy || g.player?.state === 'grabbed');
  }

  _update(realDt) {
    const game = this.game;
    const q = this.quality;
    const gameDt = game.state === 'paused' ? 0 : realDt * (game.time?.timeScale ?? 1);
    const o = this.fx.evaluate(realDt, this._isGrabHeld(), gameDt);
    this._time = (this._time + realDt) % 3600;
    const t = this._time;
    const danger = Math.min(1, Math.max(0, game.danger || 0));
    const state = game.state;

    // ---- player health ----
    const player = game.player;
    let hpFrac = 1;
    if (player && player.maxHealth > 0 && Number.isFinite(player.health)) hpFrac = Math.max(0, player.health / player.maxHealth);
    if (player && player.alive === false) hpFrac = 0;
    const inCombat = state === 'playing' || state === 'paused' || state === 'dead';
    const hpLow = inCombat ? smoothstep(0.5, 0.12, hpFrac) : 0;

    // ---- heartbeat: tempo rises with danger, depth with low health ----
    const beatAmp = inCombat ? Math.min(1, 0.22 * danger + 0.9 * hpLow) : 0;
    const bpm = 58 + 62 * danger + 26 * hpLow;
    this._beatPhase = (this._beatPhase + realDt * bpm / 60) % 1;
    const ph = this._beatPhase;
    const lub = Math.exp(-Math.pow(Math.min(ph, 1 - ph) / 0.055, 2));
    const dub = 0.6 * Math.exp(-Math.pow((ph - 0.3) / 0.065, 2));
    this._beat = (lub + dub) * beatAmp;

    // ---- camera, sun, god rays ----
    const cam = game.camera;
    cam.updateMatrixWorld();
    cam.getWorldDirection(_dir);
    const sunDir = game.env?.sunDirection ?? DEFAULT_SUN;
    const lookUp = sunDir.lengthSq() > 0 ? _dir.dot(_v.copy(sunDir).normalize()) : 0;
    let godTarget = 0;
    if (q.godRays && lookUp > 0.05) {
      // fade out with depth (less light reaches deep water)
      const depthK = Math.min(1, Math.max(0.25, 1 + cam.position.y / 70));
      godTarget = smoothstep(0.08, 0.7, lookUp) * depthK;
    }
    this._godRayLevel += (godTarget - this._godRayLevel) * (1 - Math.exp(-realDt * 4));
    // Cheap eye adaptation (no GPU readback): looking up into the bright
    // surface stops the exposure down (less so deep down, where the window is
    // dim), looking into the abyss opens it a bit, and so does depth itself
    // below DEEP_ADAPT_FROM (more after the last kill).
    const depth = WORLD.surfaceY - cam.position.y;
    const deepK = q.deepStopK;
    const stop = LOOKUP_STOP * (deepK + (1 - deepK) * smoothstep(LOOKUP_STOP_DEEP, LOOKUP_STOP_SHALLOW, depth));
    let expTarget = BASE_EXPOSURE * (1 - stop * smoothstep(0.1, 0.85, lookUp) + 0.08 * smoothstep(0.2, 0.8, -lookUp));
    const deep = smoothstep(DEEP_ADAPT_FROM, DEEP_ADAPT_TO, depth);
    if (deep > 0) {
      const floor = game.env?.getSeabedHeight?.(cam.position.x, cam.position.z);
      const abyss = Number.isFinite(floor) ? smoothstep(ABYSS_FLOOR[0], ABYSS_FLOOR[1], floor) : 0;
      expTarget *= 1 + (DEEP_ADAPT_GAIN + ABYSS_ADAPT_GAIN * abyss) * deep;
    }
    if (state === 'victory' || game.director?.phase === 'victory') {
      expTarget *= 1 + (VICTORY_LIFT - 1) * smoothstep(VICTORY_LIFT_DEPTH - 5, VICTORY_LIFT_DEPTH + 5, depth);
    }
    this._exposure += (expTarget - this._exposure) * (1 - Math.exp(-realDt * 1.5));
    const raysOn = this._godRayLevel > 0.01;
    this.godRaysPass.enabled = raysOn;
    if (raysOn) {
      _v.copy(cam.position).addScaledVector(sunDir, cam.far * 0.5);
      _v.project(cam);
      this.godRaysPass.sunUv.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
    }

    // ---- particulate parallax: motes are close to the lens, so camera rotation sweeps them ----
    const yaw = Math.atan2(_dir.x, _dir.z);
    const pitch = Math.asin(Math.max(-1, Math.min(1, _dir.y)));
    if (this._lastYaw === null) {
      this._lastYaw = yaw;
      this._lastPitch = pitch;
    }
    let dYaw = yaw - this._lastYaw;
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const dPitch = pitch - this._lastPitch;
    this._lastYaw = yaw;
    this._lastPitch = pitch;
    const d = this._dirtOffset;
    d.x = (d.x + realDt * 0.0045 - dYaw * 0.22 + 1) % 1;
    d.y = (d.y + realDt * 0.003 + dPitch * 0.22 + 1) % 1;
    d.z = (d.z - realDt * 0.007 - dYaw * 0.42 + 1) % 1;
    d.w = (d.w + realDt * 0.0055 + dPitch * 0.42 + 1) % 1;

    // ---- underwater (linear) uniforms ----
    const u = this.underwaterPass.uniforms;
    u.uTime.value = t;
    u.uWobble.value = 0.0015 * (1 + o.wobble) + 0.0007 * danger;
    u.uRadialBlur.value = o.radialBlur;
    u.uBlurCenter.value.copy(o.blurCenter);
    if (o.shake > 0) {
      const f = o.shakeFreq;
      u.uShake.value.set(
        o.shake * (Math.sin(t * f) * 0.6 + Math.sin(t * f * 1.73 + 1.3) * 0.4),
        o.shake * (Math.sin(t * f * 1.21 + 0.7) * 0.6 + Math.sin(t * f * 2.07 + 2.1) * 0.4),
      );
    } else u.uShake.value.set(0, 0);
    u.uRing0.value.set(o.ring0.center.x, o.ring0.center.y, o.ring0.radius, o.ring0.amp);
    u.uRing0Width.value = o.ring0.width;
    u.uRing1.value.set(o.ring1.center.x, o.ring1.center.y, o.ring1.radius, o.ring1.amp);
    u.uRing1Width.value = o.ring1.width;
    u.uGodRays.value = raysOn ? this._godRayLevel * 0.45 : 0;
    u.uDirtOffset.value.copy(d);
    u.uFlash.value = o.flash;
    u.uFlashColor.value.copy(o.flashColor);
    u.uExposure.value = Math.max(0.3, this._exposure + o.exposure);

    // ---- grade (display) uniforms ----
    const gU = this.gradePass.uniforms;
    gU.uTime.value = t;
    gU.uCA.value = 0.0012 + 0.001 * danger + o.ca;
    let desat = o.desat;
    let darken = 0;
    if (state === 'dead') {
      desat += 0.6;
      darken = 0.12;
    } else if (state === 'paused') desat += 0.45;
    gU.uDesat.value = Math.min(1, desat);
    gU.uDarken.value = darken;

    let strength = 0.42 + 0.3 * danger + o.vignette;
    let inner = 0.42 - 0.16 * danger - 0.2 * o.vignette;
    let outer = 1.28 - 0.14 * danger;
    if (state === 'title' || state === 'intro') {
      strength += 0.12;
      inner -= 0.05;
    }
    if (state === 'dead') {
      strength += 0.35;
      inner -= 0.12;
    }
    strength += this._beat * 0.32;
    inner -= this._beat * 0.07;
    const tun = o.tunnel;
    if (tun > 0) {
      inner += (0.08 - inner) * tun;
      outer += (0.8 - outer) * tun;
      strength += (0.97 - strength) * tun;
    }
    // The wind-up squeeze sits on top of the (possibly saturated) danger
    // vignette, so a telegraph always reads, even at full danger.
    strength = Math.min(1, strength) + WINDUP_VIGNETTE * o.windup;
    inner -= WINDUP_INNER * o.windup;
    gU.uVignette.value.set(Math.min(1.3, strength), Math.max(0.0, inner), Math.max(inner + 0.2, outer), 0);
    const redness = Math.min(1, hpLow * 0.9 + tun * 0.85 + this._beat * 0.25 + (state === 'dead' ? 0.6 : 0));
    gU.uVignetteColor.value.copy(VIG_TEAL).lerp(VIG_RED, redness);
    // persistent, throbbing blood-red border at low health
    gU.uRedEdge.value = o.redEdge + hpLow * (0.16 + 0.22 * Math.min(1, this._beat));
  }

  dispose() {
    const canvas = this.game.renderer?.domElement;
    canvas?.removeEventListener?.('webglcontextlost', this._onLost, false);
    canvas?.removeEventListener?.('webglcontextrestored', this._onRestored, false);
    clearTimeout(this._settleTimer);
    this._settleTimer = 0;
    while (this._settling.length) this._finishSettle(this._settling[0]);
    this.composer.passes.forEach((p) => p.dispose?.());
    this.composer.dispose();
    this.dirtTexture.dispose();
  }
}
