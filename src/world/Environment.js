// Environment ("world" module) — implements the Environment contract in
// docs/DESIGN.md: 东海外海, a sandy arena 20-46 m down, walled in by a reef
// cliff to the north, falling away into a black trench to the east, with a
// sunken fishing boat, kelp forests, rocks, corals, god rays, caustics,
// marine snow and Snell's window overhead.
//
// Lighting model (all linear RGB):
//  - The water colour (fog/background) is the horizontal radiance at the
//    camera's depth; it darkens and shifts toward blue as the camera goes
//    deeper, and darker still over the abyss. The fog shader chunks are
//    overridden globally (waterShading.js) so fog/backdrop colour also depends
//    on view direction: bright overhead, black below, glow toward the sun.
//  - The sun and hemisphere lights are tuned every frame for the camera's
//    depth (uEnvRefDepth). Patched materials (patchMaterial) correct that per
//    fragment with exp(-k·Δdepth) absorption and add caustics to direct light.
//
// Draw cost: static scenery is split into compact pieces (spatial buckets of
// rocks / coral / kelp / grass) so frustum and shadow culling work. Before
// every render, pieces lying wholly beyond the opaque-fog distance are hidden
// and far pieces stop casting shadows (_cullFar) — they would only ever render
// as fog colour. The seabed and the reef wall are each a few draw lists of
// small tiles re-sorted by camera distance (near / far fog LOD, shadows, fog
// cull; see tileLists.js), one draw call per list.
import * as THREE from 'three';
import { WORLD } from '../core/config.js';
import { Heightfield, LAYOUT, polar } from './terrain.js';
import { smoothstep } from './noise.js';
import { installWaterFog, createEnvUniforms, patchShader, patchMaterial, FOG_OPAQUE_X } from './waterShading.js';
import {
  makeSandTextures,
  makeRockTextures,
  makeVariationTexture,
  makeWoodTextures,
  makeNetTexture,
  makeWaveNormalTexture,
  makeReefTextures,
} from './textures.js';
import { Seabed } from './Seabed.js';
import { Cliff } from './Cliff.js';
import { Rocks } from './Rocks.js';
import { Vegetation, updateShadowSubset } from './Vegetation.js';
import { Coral } from './Coral.js';
import { Wreck } from './Wreck.js';
import { createBackdrop, createSurface } from './WaterSurface.js';
import { createLightShafts } from './LightShafts.js';
import { createMarineSnow } from './MarineSnow.js';

// Refracted sun, high in the north-north-east sky: looking north you look
// into the light, so the reef wall and the wreck appear backlit.
const SUN_DIR = new THREE.Vector3(0.2, 0.9, -0.38).normalize();

// Water optics.
// Horizontal radiance just below the surface. Open water seen level at -20 m
// lands near sRGB (34, 100, 110) after the post chain.
const WATER_SURFACE_RGB = [0.086, 0.258, 0.267];
const WATER_DARKEN_K = [0.065, 0.042, 0.034]; // per metre of camera depth
const LIGHT_ABSORB_K = [0.075, 0.034, 0.028]; // sunlight absorption per metre (uEnvAbsorb)
const SUN_AIR_RGB = [1.0, 0.96, 0.88];
// Underwater light is very diffuse: the sun only carries ~60 % of the light
// reaching a horizontal surface, so faces turned away from it stay readable.
const SUN_INTENSITY = 6.0;
const HEMI_SKY_GAIN = 9.0; // downwelling diffuse irradiance vs. horizontal water colour
const HEMI_GROUND_GAIN = 2.2; // light bounced up off the pale sand
const HEIGHT_RANGE = [-160, 5]; // encoded range of the shaft heightmap
// Static scenery wholly farther than this from the camera casts no shadow.
const SHADOW_CASTER_FAR = 50;

const _c = new THREE.Vector3();
const _cam = new THREE.Vector3();

export class Environment {
  constructor(game) {
    this.game = game;
    this.quality = game.quality ?? 'high';
    const q = this.quality;
    const scene = game.scene;

    this.bounds = { surfaceY: WORLD.surfaceY, floorY: WORLD.floorY, radius: WORLD.arenaRadius };
    this.sunDirection = SUN_DIR.clone();
    this.waterColor = new THREE.Color().setRGB(...WATER_SURFACE_RGB);
    this.time = 0;
    this._occlusion = 0; // 0..1, something huge between us and the sun
    this._extDim = 0;

    // Must happen before anything compiles a fogged shader.
    installWaterFog(this.sunDirection);
    this.uniforms = createEnvUniforms();
    this.uniforms.uEnvAbsorb.value.set(...LIGHT_ABSORB_K);

    // ---- Heightfield (getSeabedHeight is exact w.r.t. the rendered mesh) ----
    const segments = q === 'low' ? 200 : q === 'medium' ? 260 : 320;
    this.heightfield = new Heightfield(segments, LAYOUT.size);
    this.heightRange = HEIGHT_RANGE;
    this.heightTexture = this._makeHeightTexture(256);

    // ---- Background + fog ----
    // Density scale: x = density·dist is the argument of the fog curve
    // (waterShading.js FOG_CURVE), which reaches a 94 % veil at x ≈ 1.52, i.e.
    // at ~50 m for WORLD.visibility = 55.
    this.fogDensity = Math.sqrt(-Math.log(1 - 0.94)) / WORLD.visibility;
    scene.background = this.waterColor.clone();
    scene.fog = new THREE.FogExp2(this.waterColor.clone(), this.fogDensity);

    // ---- Lights ----
    const sun = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY);
    sun.name = 'sun';
    sun.castShadow = q !== 'low';
    const mapSize = q === 'high' ? 2048 : 1024;
    this._shadowExtent = q === 'high' ? 42 : 36;
    sun.shadow.mapSize.set(mapSize, mapSize);
    const sc = sun.shadow.camera;
    sc.left = -this._shadowExtent;
    sc.right = this._shadowExtent;
    sc.top = this._shadowExtent;
    sc.bottom = -this._shadowExtent;
    sc.near = 1;
    sc.far = 190;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    sun.shadow.radius = q === 'high' ? 5 : 3; // scattering softens underwater shadows
    sun.shadow.intensity = 0.72;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;
    // Light-space axes for texel snapping (stable, shimmer-free shadows).
    const look = new THREE.Matrix4().lookAt(this.sunDirection, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
    this._lsRight = new THREE.Vector3().setFromMatrixColumn(look, 0);
    this._lsUp = new THREE.Vector3().setFromMatrixColumn(look, 1);
    this._texel = (2 * this._shadowExtent) / mapSize;

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    this.hemi.name = 'water-fill';
    scene.add(this.hemi);

    // ---- Textures ----
    const texSize = q === 'low' ? 256 : 512;
    // 4x keeps the grazing-angle sand crisp; beyond that the cost (several
    // taps per fetch on the large seabed) buys little under the fog.
    const aniso = Math.min(q === 'high' ? 4 : 2, game.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4);
    this.textures = {
      sand: makeSandTextures(texSize, aniso),
      rock: makeRockTextures(texSize, aniso),
      variation: makeVariationTexture(256),
      wood: makeWoodTextures(q === 'low' ? 256 : 512, aniso),
      net: makeNetTexture(256),
      waves: makeWaveNormalTexture(256),
      reef: makeReefTextures(q === 'low' ? 128 : 256, aniso),
    };

    // ---- Scene content ----
    this.root = new THREE.Group();
    this.root.name = 'environment';
    scene.add(this.root);

    this.backdrop = createBackdrop();
    this.root.add(this.backdrop);

    const surface = createSurface(this);
    this.surface = surface;
    this.root.add(surface.mesh);

    // Seabed: small tiles sorted per camera position into a few draw lists
    // (near rock / near sand / far LOD, see Seabed.js and _cullFar).
    this.seabedLod = new Seabed(this);
    this.seabed = this.seabedLod.group;
    this.root.add(this.seabed);

    this.cliff = new Cliff(this);
    this.root.add(this.cliff.mesh);

    this.rocks = new Rocks(this);
    this.root.add(this.rocks.group);

    this.vegetation = new Vegetation(this);
    this.root.add(this.vegetation.group);

    this.coral = new Coral(this);
    this.root.add(this.coral.group);

    this.wreck = new Wreck(this);
    this.root.add(this.wreck.group);

    this.shafts = createLightShafts(this);
    this.root.add(this.shafts.mesh);

    this.snow = createMarineSnow(this);
    this.root.add(this.snow.points);

    // Named places other modules may use (cinematic cameras, AI patrols).
    const onFloor = (p) => new THREE.Vector3(p.x, this.getSeabedHeight(p.x, p.z), p.z);
    const cliffFoot = polar(LAYOUT.cliff.radius - 2, LAYOUT.cliff.center);
    this.landmarks = {
      wreck: this.wreck.center.clone(), // centre of the hull (world)
      wreckHeading: LAYOUT.wreck.heading, // bow direction = (sin h, 0, cos h)
      cliff: onFloor(cliffFoot), // foot of the reef wall, due north-north-west
      abyssEdge: onFloor(polar(LAYOUT.trench.radius, LAYOUT.trench.center)), // trench lip, east-south-east
      kelp: LAYOUT.kelpPatches.map(onFloor),
    };
    // Aliases read by the title camera (CameraRig) and the wreck creaks (Audio).
    this.wreckPosition = this.landmarks.wreck;
    this.titleFocus = this.landmarks.wreck;

    // Static pieces that may be hidden when they lie wholly in opaque fog.
    // Spheres are in world space (the environment root is never moved).
    this._cullables = [];
    // `subset(cam, maxDist)`: optional per-instance shadow-caster selection.
    // (The seabed and the cliff sort their own tiles into draw lists.)
    const addCullable = (o, { subset = null } = {}) => {
      const s = o.isInstancedMesh ? o.boundingSphere : o.geometry?.boundingSphere;
      if (!s) return;
      this._cullables.push({ object: o, center: s.center, radius: s.radius, cast: o.castShadow, subset });
    };
    for (const m of this.rocks.meshes) addCullable(m);
    for (const m of this.coral.meshes) addCullable(m);
    for (const m of this.vegetation.kelpMeshes) addCullable(m, { subset: (cam, d) => updateShadowSubset(m, cam, d) });
    for (const m of this.vegetation.grassMeshes) addCullable(m);
    // Warm-up: the first rendered frame draws every piece (no frustum or fog
    // cull), the whole wreck and every seabed / cliff draw list (each has a
    // fixed material and shadow flags), so all programs, shadow-depth
    // variants included, compile up front with the real lights / fog / render
    // target, not on first sight mid-fight.
    this._warm = 2; // env.update() calls until culling starts (render follows update)
    for (const c of this._cullables) c.object.frustumCulled = false;
    this.seabedLod.setWarm(true);
    this.cliff.setWarm(true);
    // The wreck is never fog-culled, but three still frustum-culls it per pass:
    // on medium its alpha-tested, double-sided net lies outside the spawn's
    // ±36 m shadow box, so its shadow-depth program would compile the first
    // time 老公 drifts toward the wreck mid-fight. Draw all of it while warming.
    this._warmAlways = [];
    this.wreck.group.traverse((o) => {
      if (o.isMesh) this._warmAlways.push(o);
    });
    for (const o of this._warmAlways) o.frustumCulled = false;
    // Cull at render time with the camera actually used, so a camera cut never
    // shows a stale cull. Chained; update() keeps culling should it be replaced.
    const prevBefore = scene.onBeforeRender;
    const env = this;
    scene.onBeforeRender = function onBeforeRender(renderer, sc, camera, target) {
      prevBefore.call(this, renderer, sc, camera, target);
      env._cullFar(camera);
    };

    this._applyDepthLighting(); // correct colours on the very first frame
  }

  /** Exact height of the rendered seabed at (x, z). */
  getSeabedHeight(x, z) {
    return this.heightfield.heightAt(x, z);
  }

  /**
   * Inject caustics + depth absorption into a MeshStandard/Physical (also
   * Lambert/Phong/Basic) material. Returns the same material. Options:
   * { caustics = true, absorption = true, causticScale = 1 }.
   */
  patchMaterial(material, opts = {}) {
    return patchMaterial(material, this.uniforms, this.sunDirection, this.quality, opts);
  }

  /** Same as patchMaterial but for code already inside an onBeforeCompile. */
  patchShader(shader, opts = {}) {
    return patchShader(shader, this.uniforms, this.sunDirection, this.quality, opts);
  }

  /**
   * Optional extra (not in the contract): externally dim the light from above,
   * 0 = none .. 1 = fully blocked. Smoothed. The boss passing overhead is
   * already detected automatically.
   */
  setLightDim(amount) {
    this._extDim = THREE.MathUtils.clamp(amount, 0, 1);
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    this.uniforms.uEnvTime.value = t;
    this.surface.uniforms.uTime.value = t;
    this.shafts.uniforms.uTime.value = t;
    this.snow.uniforms.uTime.value = t;
    this.vegetation.update(dt);
    this._updateOcclusion(dt);
    this._applyDepthLighting();
    this._followShadow();
    if (this._warm > 0 && --this._warm === 0) {
      for (const c of this._cullables) c.object.frustumCulled = true;
      for (const o of this._warmAlways) o.frustumCulled = true;
      this.seabedLod.setWarm(false);
      this.cliff.setWarm(false);
    }
    this._cullFar();
  }

  /**
   * Hide static pieces whose nearest point is beyond the distance where the
   * fog is opaque (transmittance < 1e-4, see FOG_OPAQUE_X): they could only
   * ever draw pure fog colour, which the backdrop already shows (the camera
   * far plane is 700 m). The seabed and the cliff re-sort their draw lists
   * (fog LOD, shadows) the same way; a reef-wall strip is judged by where its
   * long shadow falls, not by the wall. Pieces wholly beyond SHADOW_CASTER_FAR
   * stop casting:
   * the tilted ±42 m shadow box sweeps ~70 m across the floor, but a shadow
   * that far out is under > 94 % fog (and blurred away by the water), so it
   * only costs shadow-pass triangles. Runs before every render of the scene
   * (and in update as a fallback).
   */
  _cullFar(camera = this.game.camera) {
    if (!camera) return;
    const fog = this.game.scene.fog;
    const density = Math.max(fog?.isFogExp2 ? fog.density : this.fogDensity, 1e-4);
    const cam = _cam.setFromMatrixPosition(camera.matrixWorld);
    // Seabed / cliff draw lists (re-sorted after the camera moved a few
    // metres; while warming up every list stays drawn).
    this.seabedLod.update(cam, density);
    this.cliff.update(cam, SHADOW_CASTER_FAR);
    if (this._warm > 0) return;
    const far = FOG_OPAQUE_X / density;
    const list = this._cullables;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const near = c.center.distanceTo(cam) - c.radius;
      c.object.visible = near < far;
      if (c.cast) {
        let cast = near < SHADOW_CASTER_FAR;
        if (cast && c.subset) cast = c.subset(cam, SHADOW_CASTER_FAR) > 0;
        c.object.castShadow = cast;
      }
    }
  }

  // ------------------------------------------------------------------------

  /**
   * A huge body between the camera and the sun (the megalodon cruising
   * overhead) swallows the light: sun, caustics, god rays and the water
   * itself darken for a moment.
   */
  _updateOcclusion(dt) {
    let target = this._extDim ?? 0;
    const boss = this.game.enemies?.getBoss?.();
    const cam = this.game.camera.position;
    if (boss && boss.alive !== false && boss.position) {
      _c.subVectors(boss.position, cam);
      const dist = _c.length();
      if (dist > 1e-3 && boss.position.y > cam.y) {
        const cosA = _c.dot(this.sunDirection) / dist;
        const half = Math.atan(((boss.length ?? 16) * 0.32) / dist); // angular half-size
        const ang = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
        const cover = smoothstep(half * 2.2, half * 0.6, ang) * smoothstep(70, 25, dist);
        target = Math.max(target, cover * 0.75);
      }
    }
    const k = 1 - Math.exp(-dt * (target > this._occlusion ? 5 : 1.5));
    this._occlusion += (target - this._occlusion) * k;
  }

  _applyDepthLighting() {
    const game = this.game;
    const cam = game.camera;
    const depth = THREE.MathUtils.clamp(-cam.position.y, 0, 250);
    // Less light bounces back up when there is no bottom below (abyss).
    const floor = this.getSeabedHeight(cam.position.x, cam.position.z);
    const abyss = smoothstep(-58, -120, floor);
    const occ = this._occlusion;
    const dim = (1 - 0.38 * abyss) * (1 - 0.35 * occ);

    const wc = this.waterColor;
    wc.setRGB(
      WATER_SURFACE_RGB[0] * Math.exp(-WATER_DARKEN_K[0] * depth) * dim,
      WATER_SURFACE_RGB[1] * Math.exp(-WATER_DARKEN_K[1] * depth) * dim,
      WATER_SURFACE_RGB[2] * Math.exp(-WATER_DARKEN_K[2] * depth) * (1 - 0.25 * abyss) * (1 - 0.3 * occ),
    );
    const scene = game.scene;
    if (scene.fog) {
      scene.fog.color.copy(wc);
      // Slightly murkier close to the silty bottom.
      const nearBottom = smoothstep(14, 3, cam.position.y - floor);
      scene.fog.density = this.fogDensity * (1 + 0.12 * nearBottom);
    }
    if (scene.background && scene.background.isColor) scene.background.copy(wc);

    const T0 = Math.exp(-LIGHT_ABSORB_K[0] * depth);
    const T1 = Math.exp(-LIGHT_ABSORB_K[1] * depth);
    const T2 = Math.exp(-LIGHT_ABSORB_K[2] * depth);
    this.sun.color.setRGB(SUN_AIR_RGB[0] * T0, SUN_AIR_RGB[1] * T1, SUN_AIR_RGB[2] * T2);
    this.sun.intensity = SUN_INTENSITY * (1 - 0.8 * occ);
    this.uniforms.uEnvCaustics.value = 1 - 0.85 * occ;
    this.shafts.uniforms.uIntensity.value = 1 - 0.85 * occ;
    this.surface.uniforms.uOcclusion.value = occ; // Snell's window darkens too
    this.hemi.color.copy(wc).multiplyScalar(HEMI_SKY_GAIN);
    this.hemi.groundColor.copy(wc).multiplyScalar(HEMI_GROUND_GAIN);
    this.uniforms.uEnvRefDepth.value = depth;

    // Particles and shafts take their light from the same model.
    const fd = scene.fog ? scene.fog.density : this.fogDensity;
    this.snow.uniforms.uFogDensity.value = fd;
    this.shafts.uniforms.uFogDensity.value = fd;
    // Motes are lit by the diffuse light around the camera; keep them close to
    // neutral (they are pale detritus) rather than taking the water's hue.
    const sc = this.snow.uniforms.uColor.value;
    sc.setRGB(0.25 * T0 + wc.r * 2.5, 0.25 * T1 + wc.g * 2.5, 0.25 * T2 + wc.b * 2.5);
    const mean = (sc.r + sc.g + sc.b) / 3;
    const brightness = 0.05 + (wc.g + wc.b) * 0.9 + (T1 + T2) * 0.05;
    const k = brightness / Math.max(mean, 1e-4);
    sc.setRGB((mean + (sc.r - mean) * 0.45) * k, (mean + (sc.g - mean) * 0.45) * k, (mean + (sc.b - mean) * 0.45) * k);
    // Shafts: sunlight at the camera depth, brighter near the surface.
    const shaftGain = 0.45 + 0.55 * Math.exp(-depth / 18);
    this.shafts.uniforms.uColor.value.setRGB(0.24 * T0 + 0.03, 0.4 * T1 + 0.04, 0.42 * T2 + 0.04).multiplyScalar(shaftGain);

    const r = game.renderer;
    if (r && cam.isPerspectiveCamera) {
      const h = r.domElement.height || 720;
      const focalPx = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5));
      this.snow.uniforms.uPixelScale.value = focalPx;
      this.vegetation.uniforms.uVegPixelScale.value = focalPx; // sea-grass minimum width
    }
  }

  _followShadow() {
    const sun = this.sun;
    const focus = this.game.player?.position ?? this.game.camera.position;
    _c.copy(focus);
    // Snap the shadow frustum centre to whole shadow-map texels.
    const r = _c.dot(this._lsRight);
    const u = _c.dot(this._lsUp);
    const tx = this._texel;
    _c.addScaledVector(this._lsRight, Math.round(r / tx) * tx - r);
    _c.addScaledVector(this._lsUp, Math.round(u / tx) * tx - u);
    sun.target.position.copy(_c);
    sun.position.copy(_c).addScaledVector(this.sunDirection, 95);
    sun.target.updateMatrixWorld();
  }

  _makeHeightTexture(n) {
    const hf = this.heightfield;
    const data = new Uint8Array(n * n * 4);
    const [lo, hi] = HEIGHT_RANGE;
    for (let j = 0; j < n; j++) {
      const z = -hf.half + ((j + 0.5) / n) * hf.size;
      for (let i = 0; i < n; i++) {
        const x = -hf.half + ((i + 0.5) / n) * hf.size;
        const h = hf.heightAt(x, z);
        const v = Math.round(THREE.MathUtils.clamp((h - lo) / (hi - lo), 0, 1) * 255);
        const o = (j * n + i) * 4;
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }
}
