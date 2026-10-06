// SpermWhale — an enormous, slow pass through the murk.
//
// Triggered once the tiger-shark wave is cleared (or via
// __game.ambient.triggerWhale()). The whale crosses the camera's view along a
// gentle quadratic Bézier laid out around the view ray (its pitch clamped to
// ±0.2 rad, its height to the water column): it materialises out of the
// murk ~45 m away, already inside the frame (~35° off the view axis), passes
// broadside ~30 m from the camera (about a third of the frame wide, but
// mostly veiled — a huge mass that is nearly water-coloured) and dissolves
// again on the far side, diving at the end. Under water contrast reads as
// distance, so the whale is fogged exactly like the rest of the scene (the
// global fog chunk) — a crisp silhouette would read as a small, near object.
// The ends of the pass fade with opacity, so it blends into the real
// background with no pop. The path is kept in open water (clear of the reef
// wall, mounds and the seabed; over the trench is fine), coming nearer or
// swinging off the view ray only when it has to. While it is close it dims
// the light from above a touch (env.setLightDim) so it registers as a moving
// dark mass.
// Animation: slow vertical fluke beats bending the rear half of the body in
// the vertex shader, with a small counter-motion of the head.
import * as THREE from 'three';
import { WORLD } from '../../core/config.js';
import { createWhaleGeometry } from './whaleGeometry.js';
import { createWhaleBumpTexture, createWhaleColorTexture } from './whaleTextures.js';
import { chainShaderPatch, clamp, smoothstep } from './util.js';

const SPEED = 4.2; // m/s
const SCALE = 1.08; // geometry is ~16.7 m long
const BEAT_PERIOD = 4.8; // s per fluke stroke
// Path around the crossing point M, `mid` m down the camera's view ray (m):
// the ends `endAhead` beyond M and ±`endSide` aside (≈45 m from the camera,
// ≈35° off the view axis: inside the 16:9 frame, whose half-width is 47°),
// the control point `endAhead` short of M, so the pass is closest to the
// camera (≈30 m: ~1/3 of the frame wide, contrast ~1/3 of a great white's at
// 10 m under the scene fog curve) at t = 0.5, ~6.5 s in — the end of the
// boss breather, as the wave card comes up.
const PATH = { mid: 30, endAhead: 8, endSide: 26, rise: 3, dive: 8 };
// The view ray's pitch is clamped to ±PATH_PITCH, so a camera still looking
// down at the last kill (or up at the surface) keeps the pass in frame both
// now (down to a −0.7 rad pitch) and once it levels out in the breather
// (the camera may ease toward level there): then it crosses just below
// 老公's shoulders rather than under his feet. scripts/render-whale-sim.mjs (400
// follow-camera poses, r ≤ 50 m): centre on screen 84 % of the breather with
// a fixed camera, 93 % with the levelling one (the old path built along the
// horizontal view from 老公: 33 % / 46 %).
const PATH_PITCH = 0.2; // rad
// M stays this far above the seabed / below the surface (the ends rise 3 m,
// dive 8 m; _place keeps the body ≥ 5 m off the bottom).
const PATH_FLOOR_CLEAR = 14; // m
const PATH_SURFACE_CLEAR = 10; // m
// A path fits when every sample along it is ≥ PATH_FIT_FLOOR m above the
// seabed (so _place never has to lift the body: no reef plateau, wreck mound
// or lip in the way; over the trench is fine) and within PATH_FIT_R of the
// centre. Tries, in order: [yaw offset of M from the view ray (rad), scale of
// `mid`] — on or near the view ray at 30 / 24 / 19.5 m first (all keep the
// pass in frame), then swung further off the view, finally behind.
const PATH_FIT_FLOOR = 5; // m
const PATH_FIT_R = 160; // m (the terrain runs to ±210 m; the fog hides it long before)
const PATH_TRIES = [
  [0, 1], [0, 0.8], [0.35, 1], [-0.35, 1], [0.35, 0.8], [-0.35, 0.8], [0, 0.65], [0.35, 0.65], [-0.35, 0.65],
  [0.7, 1], [-0.7, 1], [0.7, 0.65], [-0.7, 0.65],
  [1.1, 1], [-1.1, 1], [1.7, 1], [-1.7, 1], [2.4, 1], [-2.4, 1], [Math.PI, 1],
];
const PATH_MAX_R = 54; // fallback: pull inside the reef wall (r ≈ 62+) and the trench lip (r ≈ 58)
// The whale's own (dark, shadowed skin) radiance relative to the lit model,
// applied before the scene fog.
const SELF_DARK = 0.5;
const LIGHT_DIM = 0.12; // peak env.setLightDim while it passes close

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();

function clampRadius(p) {
  const r = Math.hypot(p.x, p.z);
  if (r > PATH_MAX_R) {
    p.x *= PATH_MAX_R / r;
    p.z *= PATH_MAX_R / r;
  }
}

const VERT_HEADER = /* glsl */ `
uniform float uBeatPhase;
uniform float uBeatAmp;
// vertical fluke-stroke displacement as a function of body z (nose +8 → tail -8.7)
float whaleBend(float z) {
  float tw = clamp((1.2 - z) / 9.9, 0.0, 1.0);
  float tail = uBeatAmp * tw * tw * sin(uBeatPhase - tw * 2.3);
  float head = uBeatAmp * 0.07 * clamp((z - 1.2) / 6.8, 0.0, 1.0) * sin(uBeatPhase + 2.2);
  return tail - head;
}
`;

const FRAG_HEADER = /* glsl */ `
uniform float uSelfDark;
`;

// Before the (global, view-dependent) fog: the whale's own radiance is well
// below the water's, so it reads as a dark mass sinking into the murk rather
// than a lit model.
const FRAG_DARKEN = /* glsl */ `
gl_FragColor.rgb *= uSelfDark;
#include <fog_fragment>
`;

export class SpermWhale {
  constructor(game, parent, { envMap = null, quality = 'high' } = {}) {
    this.game = game;
    this.active = false;
    this.t = 0;
    this.duration = 1;
    this.beatPhase = 0;
    this.p0 = new THREE.Vector3();
    this.p1 = new THREE.Vector3();
    this.p2 = new THREE.Vector3();
    this.passes = 0;
    this._dimmed = false;

    const geo = createWhaleGeometry({ quality });
    const map = createWhaleColorTexture();
    const bumpMap = createWhaleBumpTexture();
    this.textures = [map, bumpMap];
    const mat = new THREE.MeshStandardMaterial({
      name: 'AmbientLife.whale',
      map,
      bumpMap,
      bumpScale: 2.2,
      roughness: 0.68,
      metalness: 0.0,
      envMap,
      envMapIntensity: 0.35,
      // fog: scene fog (global chunk), like everything else in the water.
      // transparent only so the ends of the pass can fade into the real
      // background; it still writes depth and draws first among the
      // transparents (mesh.renderOrder), so particles/shafts in front of it
      // blend over it correctly.
      transparent: true,
      depthWrite: true,
      opacity: 0,
    });
    this.uniforms = {
      uBeatPhase: { value: 0 },
      uBeatAmp: { value: 0.55 },
      uSelfDark: { value: SELF_DARK },
    };
    this.fade = 1; // 1 = dissolved in the murk (ends of the pass)
    const U = this.uniforms;
    chainShaderPatch(mat, 'ambient-whale-v2', (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_HEADER}`)
        .replace(
          '#include <defaultnormal_vertex>',
          `{
            float zz = position.z;
            float slope = (whaleBend(zz + 0.05) - whaleBend(zz - 0.05)) / 0.1;
            objectNormal.z -= slope * objectNormal.y;
          }
          #include <defaultnormal_vertex>`,
        )
        .replace(
          '#include <project_vertex>',
          `transformed.y += whaleBend(position.z);
          #include <project_vertex>`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_HEADER}`)
        .replace('#include <fog_fragment>', FRAG_DARKEN);
    });
    this.material = mat;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'AmbientLife.spermWhale';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    mesh.renderOrder = -1;
    this.mesh = mesh;
    this.group = new THREE.Group();
    this.group.name = 'AmbientLife.whaleRig';
    this.group.add(mesh);
    this.group.visible = false;
    // a big bull: ~18 m nose to fluke tips
    this.group.scale.setScalar(SCALE);
    parent.add(this.group);
  }

  get position() {
    return this.group.position;
  }

  /** Begin a pass. Returns false if one is already under way. */
  start() {
    if (this.active) return false;
    const game = this.game;
    const cam = game.camera;
    cam.updateMatrixWorld();
    const C = _b.setFromMatrixPosition(cam.matrixWorld);

    // horizontal view direction and the (clamped) pitch of the view ray
    cam.getWorldDirection(_dir);
    const pitch = clamp(Math.asin(clamp(_dir.y, -1, 1)), -PATH_PITCH, PATH_PITCH);
    _dir.y = 0;
    if (_dir.lengthSq() < 1e-4) _dir.set(0, 0, -1);
    _dir.normalize();
    const side = this.passes % 2 === 0 ? 1 : -1;
    this.passes++;

    // Prefer crossing right through the view; come nearer, then swing the
    // pass off the view ray if it would run into the reef or the seabed.
    const ahead = PATH.mid * Math.cos(pitch);
    const rise = PATH.mid * Math.sin(pitch);
    for (let k = 0; k < PATH_TRIES.length; k++) {
      const [a, near] = PATH_TRIES[k];
      const c = Math.cos(a);
      const s = Math.sin(a);
      _fwd.set(_dir.x * c - _dir.z * s, 0, _dir.x * s + _dir.z * c);
      this._buildPath(C, ahead * near, rise * near, side);
      if (this._pathFits()) break;
      if (k === PATH_TRIES.length - 1) {
        // nowhere fits (camera far out by the walls): pull the path inward
        _fwd.copy(_dir);
        this._buildPath(C, ahead, rise, side);
        clampRadius(this.p0);
        clampRadius(this.p1);
        clampRadius(this.p2);
      }
    }

    // arc length → duration
    let len = 0;
    this._bezier(0, _a);
    for (let i = 1; i <= 24; i++) {
      this._bezier(i / 24, _look);
      len += _look.distanceTo(_a);
      _a.copy(_look);
    }
    this.duration = len / SPEED;
    this.t = 0;
    this.beatPhase = Math.random() * Math.PI * 2;
    this.active = true;
    this.group.visible = true;
    this._place();
    this._applyFade();
    return true;
  }

  // Control points around M = C + `ahead` m along _fwd (horizontal unit
  // vector), `rise` m up, its height clamped to the water column there.
  _buildPath(C, ahead, rise, side) {
    _right.set(-_fwd.z, 0, _fwd.x);
    const M = _a.copy(C).addScaledVector(_fwd, ahead);
    const floor = this.game.env?.getSeabedHeight?.(M.x, M.z);
    const lo = (Number.isFinite(floor) ? floor : WORLD.floorY) + PATH_FLOOR_CLEAR;
    const hi = WORLD.surfaceY - PATH_SURFACE_CLEAR;
    M.y = lo < hi ? clamp(C.y + rise, lo, hi) : hi;
    this.p0.copy(M).addScaledVector(_fwd, PATH.endAhead).addScaledVector(_right, -PATH.endSide * side);
    this.p0.y += PATH.rise;
    this.p1.copy(M).addScaledVector(_fwd, -PATH.endAhead);
    this.p2.copy(M).addScaledVector(_fwd, PATH.endAhead).addScaledVector(_right, PATH.endSide * side);
    this.p2.y -= PATH.dive;
  }

  // Open water all along: clear of the seabed (reef plateau, lip, mounds)
  // and inside the arena, checked at 9 points of the curve.
  _pathFits() {
    const env = this.game.env;
    for (let i = 0; i <= 8; i++) {
      const p = this._bezier(i / 8, _look);
      if (p.x * p.x + p.z * p.z > PATH_FIT_R * PATH_FIT_R) return false;
      const floor = env?.getSeabedHeight?.(p.x, p.z);
      if (Number.isFinite(floor) && p.y < floor + PATH_FIT_FLOOR) return false;
    }
    return true;
  }

  stop() {
    this.active = false;
    this.group.visible = false;
    this.material.opacity = 0;
    if (this._dimmed) {
      this.game.env?.setLightDim?.(0);
      this._dimmed = false;
    }
  }

  _bezier(t, out) {
    const u = 1 - t;
    out.set(0, 0, 0);
    out.addScaledVector(this.p0, u * u);
    out.addScaledVector(this.p1, 2 * u * t);
    out.addScaledVector(this.p2, t * t);
    return out;
  }

  _place() {
    const t = this.t;
    this._bezier(t, this.group.position);
    // derivative of the quadratic Bézier
    const u = 1 - t;
    _look.set(0, 0, 0)
      .addScaledVector(this.p1, 2 * u)
      .addScaledVector(this.p0, -2 * u)
      .addScaledVector(this.p2, 2 * t)
      .addScaledVector(this.p1, -2 * t)
      .normalize();
    // the body rises and falls slightly with each stroke
    const bob = Math.sin(this.beatPhase - 0.6) * 0.18;
    this.group.position.y += bob;
    _look.y += Math.cos(this.beatPhase - 0.6) * 0.025;
    _a.copy(this.group.position).add(_look);
    this.group.lookAt(_a);
    // keep clear of the seabed
    const floor = this.game.env?.getSeabedHeight?.(this.group.position.x, this.group.position.z);
    if (Number.isFinite(floor) && this.group.position.y < floor + 5) this.group.position.y = floor + 5;
  }

  update(dt) {
    if (!this.active || dt <= 0) return;
    this.t += dt / this.duration;
    if (this.t >= 1) {
      this.stop();
      return;
    }
    this.beatPhase += (dt * Math.PI * 2) / BEAT_PERIOD;
    this._place();
    this.uniforms.uBeatPhase.value = this.beatPhase;
    this._applyFade();
  }

  // Emerge from / dissolve back into the murk at the ends of the pass, and
  // dim the light a little while the mass is close.
  _applyFade() {
    const t = this.t;
    const fade = Math.max(1 - smoothstep(0.0, 0.12, t), smoothstep(0.86, 1.0, t));
    this.fade = fade;
    this.material.opacity = 1 - fade;
    const env = this.game.env;
    if (env?.setLightDim) {
      const d = this.group.position.distanceTo(this.game.camera.position);
      env.setLightDim(LIGHT_DIM * (1 - fade) * smoothstep(48, 32, d));
      this._dimmed = true;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    for (const t of this.textures) t.dispose();
    this.group.removeFromParent();
  }
}
