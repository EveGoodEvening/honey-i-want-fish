// Per-species asset bundles (skinned geometry, painted textures, materials,
// teeth/eye geometry). Built once per species + quality and shared by every
// instance (the two tiger sharks share one bundle).
//
// Building is a generator so species can be prefetched in small slices:
// pump(budget) runs slices for a time budget — from idle callbacks, and from
// EnemyManager's frame loop while the title / intro / wave card is up;
// prioritize(type) moves a species to the front of the queue; get() finishes
// any pending work synchronously when a wave needs the species at once. The
// big painted maps go to the GPU one row band per slice (uploadTexture).
// `onReady(bundle)` fires once per finished bundle (EnemyManager uses it to
// compile the shaders before the shark is first seen). After a WebGL context
// loss + restore the banded skin maps (raw GL textures) are repainted and
// re-uploaded (repairSkin) — at once for species on screen (`inUse`), else
// in the background — and every half-built bundle starts over.
//
// Material patches (chained after the environment's caustics/absorption
// patch; species values are uniforms so all species share one program):
//  - skin:  a shared tiling detail normal at a fixed physical scale
//           (SharkTextures.ensureDetailNormal), faded out with distance;
//           the clearcoat (high) scaled down on the head per species
//           (colors.headCoat — no glossy "melon" on the megalodon);
//  - mouth: cavity occlusion from the baked `aMouthDepth` attribute (0 at the
//           lips → 1 in the throat) — the inside of the mouth is not lit like
//           an exterior surface (no fill, no specular deep inside).
import * as THREE from 'three';
import { getSpecies } from './species.js';
import { buildSharkGeometryGen, U_BODY } from './SharkGeometry.js';
import { paintSkin, paintEye, ensureDetailNormal, bodyCircumference, releaseTextureScratch, TEX_SIZE, DETAIL_SIZE, DETAIL_TILE_M } from './SharkTextures.js';

function patch(game, mat) {
  try {
    game.env?.patchMaterial?.(mat);
  } catch (err) {
    console.warn('[enemies] env.patchMaterial failed', err);
  }
  return mat;
}

/** Chains `hook(shader)` after any existing onBeforeCompile and extends the program cache key. */
function chainShader(mat, key, hook) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  const hasPrev = prev !== THREE.Material.prototype.onBeforeCompile;
  const hasPrevKey = prevKey !== THREE.Material.prototype.customProgramCacheKey;
  mat.onBeforeCompile = function onBeforeCompile(shader, renderer) {
    if (hasPrev) prev.call(this, shader, renderer);
    hook(shader);
  };
  mat.customProgramCacheKey = function customProgramCacheKey() {
    return `${hasPrevKey ? prevKey.call(this) : ''}|${key}`;
  };
  mat.needsUpdate = true;
  return mat;
}

const SKIN_PARS = /* glsl */ `
uniform sampler2D uSharkDetail;
uniform vec2 uSharkDetailScale;
uniform float uSharkDetailStrength;
uniform float uSharkHeadCoat;
`;
// Partial-derivative blend of the detail normal into the base normal map,
// fading out between 9 and 20 m (the mip chain already averages it toward
// flat further away; this just saves the visual noise).
// Snout tip: the body's u (= s · U_BODY, see SharkGeometry) runs into a UV
// pole there — every texel row / detail tile around the body is squeezed onto
// a shrinking circle and relief turns into a radial starburst. The detail
// normal fades out over the first 7 % of the length, the painted normal map
// (whose fine noise SharkTextures already fades there) over the last 2.5 %
// before the pole, where even its smooth relief converges (fins sit at
// u ≥ U_FIN, unaffected).
const SKIN_DETAIL = /* glsl */ `
	mapN.xy *= normalScale * smoothstep( 0.0, ${(0.025 * U_BODY).toFixed(4)}, vNormalMapUv.x );
	{
		float sdPole = smoothstep( 0.0, ${(0.07 * U_BODY).toFixed(4)}, vNormalMapUv.x );
		float sdFade = uSharkDetailStrength * sdPole * ( 1.0 - smoothstep( 9.0, 20.0, length( vViewPosition ) ) );
		vec3 sdN = texture2D( uSharkDetail, vNormalMapUv * uSharkDetailScale ).xyz * 2.0 - 1.0;
		mapN.xy += sdN.xy * sdFade;
	}
`;

// Wet sheen (clearcoat, high quality) on the head: × uSharkHeadCoat ahead of
// s ≈ 0.1, back to full by s ≈ 0.24. The megalodon's broad forehead caught one
// big round highlight — a dolphin's melon, not a shark's hide.
const SKIN_COAT = /* glsl */ `
#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
	material.clearcoat *= mix( uSharkHeadCoat, 1.0, smoothstep( ${(0.1 * U_BODY).toFixed(4)}, ${(0.24 * U_BODY).toFixed(4)}, vNormalMapUv.x ) );
#endif
`;

function patchSkin(mat, detailTex, detailScale, strength, headCoat = 1) {
  const uniforms = {
    uSharkDetail: { value: detailTex },
    uSharkDetailScale: { value: detailScale },
    uSharkDetailStrength: { value: strength },
    uSharkHeadCoat: { value: headCoat },
  };
  mat.userData.sharkDetail = uniforms;
  return chainShader(mat, 'shark-skin2', (shader) => {
    const chunk = THREE.ShaderChunk.normal_fragment_maps;
    if (!detailTex || !chunk.includes('mapN.xy *= normalScale;')) return;
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SKIN_PARS}`)
      .replace('#include <normal_fragment_maps>', chunk.replace('mapN.xy *= normalScale;', SKIN_DETAIL))
      .replace('#include <lights_physical_fragment>', SKIN_COAT);
  });
}

const MOUTH_OCCLUSION = /* glsl */ `
#include <lights_fragment_end>
{
	// Cavity: the fill and the sun barely reach inside; no wet sheen deep in.
	float md = clamp( vMouthDepth, 0.0, 1.0 );
	float mOcc = mix( 1.0, 0.06, md );
	reflectedLight.directDiffuse *= mOcc;
	reflectedLight.indirectDiffuse *= mOcc;
	reflectedLight.directSpecular *= 1.0 - md;
	reflectedLight.indirectSpecular *= 1.0 - md;
}
`;

function patchMouth(mat) {
  return chainShader(mat, 'shark-mouth1', (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aMouthDepth;\nvarying float vMouthDepth;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMouthDepth = aMouthDepth;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vMouthDepth;')
      .replace('#include <lights_fragment_end>', MOUTH_OCCLUSION);
  });
}

// ---------------------------------------------------------------- GPU upload

/** A painted map bigger than this is uploaded in row bands of about this size. */
const BAND_BYTES = 1 << 20;

const GL_WRAP = {
  [THREE.ClampToEdgeWrapping]: 0x812f, // CLAMP_TO_EDGE
  [THREE.RepeatWrapping]: 0x2901, // REPEAT
  [THREE.MirroredRepeatWrapping]: 0x8370, // MIRRORED_REPEAT
};

/**
 * Uploads a painted RGBA8 DataTexture to the GPU from inside the build
 * generator. Small maps go up whole (renderer.initTexture). A big one (the
 * 2048×1024 skin maps on high) goes into an immutable GL texture one ~1 MB
 * row band per slice, then its mip chain is generated in a slice of its own,
 * and it is handed to three as an ExternalTexture: a single 8 MB texImage
 * stalled the main thread for ~0.3 s whenever the GPU process was busy (it
 * waits for transfer memory), a band does not. GL state goes through
 * three's WebGLState so its caches stay right; any GL failure falls back to
 * the DataTexture (uploaded lazily at first render). Returns the texture
 * the materials must use.
 */
function* uploadTexture(renderer, tex, target = null) {
  const img = tex.image;
  const gl = renderer?.getContext?.();
  if (!gl || typeof gl.texStorage2D !== 'function' || img.data.byteLength <= BAND_BYTES || !THREE.ExternalTexture) {
    try {
      renderer?.initTexture?.(tex);
    } catch {
      /* headless / no GL: uploaded lazily at first render */
    }
    yield 'upload';
    return tex;
  }
  const state = renderer.state;
  const W = img.width;
  const H = img.height;
  let glTex = null;
  try {
    glTex = gl.createTexture();
    state.bindTexture(gl.TEXTURE_2D, glTex);
    const levels = Math.floor(Math.log2(Math.max(W, H))) + 1;
    state.texStorage2D(gl.TEXTURE_2D, levels, tex.colorSpace === THREE.SRGBColorSpace ? gl.SRGB8_ALPHA8 : gl.RGBA8, W, H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, GL_WRAP[tex.wrapS] ?? gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, GL_WRAP[tex.wrapT] ?? gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    const ex = renderer.extensions;
    const aniso = ex?.has?.('EXT_texture_filter_anisotropic') ? ex.get('EXT_texture_filter_anisotropic') : null;
    if (aniso && tex.anisotropy > 1) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, tex.anisotropy);
  } catch (err) {
    console.warn('[enemies] banded texture upload unavailable', err);
    if (glTex) gl.deleteTexture(glTex);
    yield 'upload';
    return tex;
  }
  yield 'upload';
  const rows = Math.max(1, Math.floor(BAND_BYTES / (W * 4)));
  for (let y = 0; y < H; y += rows) {
    const h = Math.min(rows, H - y);
    // Rebind every slice: three binds other textures between our slices.
    state.bindTexture(gl.TEXTURE_2D, glTex);
    state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    state.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    state.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, W, h, gl.RGBA, gl.UNSIGNED_BYTE, img.data.subarray(y * W * 4, (y + h) * W * 4));
    yield 'upload';
  }
  state.bindTexture(gl.TEXTURE_2D, glTex);
  gl.generateMipmap(gl.TEXTURE_2D);
  yield 'mips';
  // Re-upload after a context restore: the same texture object (materials
  // keep it), a fresh GL texture behind it (three reads sourceTexture at
  // every bind).
  if (target?.isExternalTexture) {
    target.sourceTexture = glTex;
    return target;
  }
  const ext = new THREE.ExternalTexture(glTex);
  ext.name = tex.name;
  ext.colorSpace = tex.colorSpace;
  ext.wrapS = tex.wrapS;
  ext.wrapT = tex.wrapT;
  ext.magFilter = tex.magFilter;
  ext.minFilter = tex.minFilter;
  ext.anisotropy = tex.anisotropy;
  ext.generateMipmaps = false;
  // three never created this GL texture, so it would not delete it (nor one
  // that died with a lost context: SharkAssetLibrary nulls those).
  ext.addEventListener('dispose', () => {
    if (ext.sourceTexture) gl.deleteTexture(ext.sourceTexture);
    ext.sourceTexture = null;
  });
  return ext;
}

/** Painted skin maps of a bundle (SharkTextures.paintSkin → materials.skin). */
const SKIN_MAPS = ['map', 'normalMap', 'ormMap'];

/** Points the skin material at the bundle's current skin maps. */
function assignSkinMaps(bundle) {
  const skin = bundle.materials.skin;
  const t = bundle.textures;
  skin.map = t.map;
  skin.normalMap = t.normalMap;
  skin.roughnessMap = t.ormMap;
  skin.aoMap = t.ormMap;
}

/**
 * After a WebGL context loss and restore: repaints a finished bundle's skin
 * and re-uploads the maps that lived in raw GL textures (ExternalTexture —
 * their pixels were dropped after the upload, and their GL objects died with
 * the old context). DataTextures keep their pixels; three re-uploads those by
 * itself. Returns the same bundle.
 */
function* repairSkin(game, bundle) {
  const tex = {};
  yield* paintSkin(bundle.anatomy, bundle.spec, bundle.texSize, tex, bundle.aniso);
  for (const key of SKIN_MAPS) {
    const cur = bundle.textures[key];
    if (!cur?.isExternalTexture) continue;
    // Falls back to the fresh DataTexture if the banded upload is unavailable.
    bundle.textures[key] = yield* uploadTexture(game.renderer, tex[key], cur);
  }
  assignSkinMaps(bundle);
  yield 'materials';
  return bundle;
}

function* buildBundle(game, type, quality) {
  const spec = getSpecies(type);
  const geo = yield* buildSharkGeometryGen(spec, quality);
  yield 'geo';
  const aniso = Math.min(8, game.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4);
  const tex = {};
  const texSize = TEX_SIZE[quality] ?? 1024;
  yield* paintSkin(geo.anatomy, spec, texSize, tex, aniso);
  let eyeTex = paintEye(quality === 'low' ? 64 : 128);
  yield 'eye';
  let detail = yield* ensureDetailNormal(DETAIL_SIZE[quality] ?? 512, aniso);

  // Upload now rather than on the first frame the shark becomes visible
  // (big maps band by band, see uploadTexture; the eye and the shared detail
  // normal are small).
  for (const key of SKIN_MAPS) tex[key] = yield* uploadTexture(game.renderer, tex[key]);
  eyeTex = yield* uploadTexture(game.renderer, eyeTex);
  detail = yield* uploadTexture(game.renderer, detail);

  const skinParams = {
    map: tex.map,
    normalMap: tex.normalMap,
    normalScale: new THREE.Vector2(1.0, 1.0),
    roughnessMap: tex.ormMap,
    aoMap: tex.ormMap,
    aoMapIntensity: 0.85,
    roughness: 1,
    metalness: 0,
    vertexColors: true,
  };
  const skin = quality === 'high'
    ? new THREE.MeshPhysicalMaterial({ ...skinParams, clearcoat: 0.32, clearcoatRoughness: 0.42 })
    : new THREE.MeshStandardMaterial(skinParams);
  skin.name = `${type}-skin`;

  const mouth = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.7,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  mouth.name = `${type}-mouth`;

  const teeth = new THREE.MeshStandardMaterial({
    color: 0xe9e3d3,
    vertexColors: true,
    roughness: 0.38,
    metalness: 0,
  });
  teeth.name = `${type}-teeth`;

  const eye = quality === 'high'
    ? new THREE.MeshPhysicalMaterial({ map: eyeTex, roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03 })
    : new THREE.MeshStandardMaterial({ map: eyeTex, roughness: 0.08, metalness: 0 });
  eye.name = `${type}-eye`;

  for (const m of [skin, mouth, teeth, eye]) patch(game, m);
  // Detail repeats every DETAIL_TILE_M metres along and around the body (uv.x
  // spans s·U_BODY of the length, uv.y the reference circumference). The
  // megalodon gets the strongest relief: up close its skin must read as hide.
  const L = spec.length;
  const detailScale = new THREE.Vector2(L / (U_BODY * DETAIL_TILE_M), bodyCircumference(geo.anatomy) / DETAIL_TILE_M);
  patchSkin(skin, detail, detailScale, spec.isBoss ? 0.42 : 0.28, spec.colors.headCoat ?? 1);
  patchMouth(mouth);
  yield 'materials';

  return {
    ...geo,
    type,
    materials: { skin, mouth, teeth, eye },
    textures: { ...tex, eye: eyeTex, detail },
    texSize, // repaint parameters (repairSkin)
    aniso,
    eyeGeometry: new THREE.SphereGeometry(geo.eyeRadius, quality === 'low' ? 12 : 20, quality === 'low' ? 8 : 14),
  };
}

export class SharkAssetLibrary {
  constructor(game) {
    this.game = game;
    this.entries = new Map();
    this.queue = [];
    this._pumping = false;
    /** Called with each bundle as it finishes (optional). */
    this.onReady = null;
    /** `(type) => boolean`: a live shark draws this species (repaired at once after a context restore). */
    this.inUse = null;
    // The banded skin maps are raw GL textures (uploadTexture): a lost
    // context takes them along and three cannot rebuild them. three's own
    // listeners were added first (renderer constructor), so ours run after
    // its restore has re-initialised the GL state.
    const canvas = game.renderer?.domElement;
    if (canvas?.addEventListener) {
      canvas.addEventListener('webglcontextlost', () => this._onContextLost(), false);
      canvas.addEventListener('webglcontextrestored', () => this._onContextRestored(), false);
    }
  }

  _onContextLost() {
    // Their GL objects belong to the dead context: never bind or delete them.
    for (const e of this.entries.values()) {
      if (!e.done) continue;
      for (const key of SKIN_MAPS) {
        const t = e.assets.textures[key];
        if (t?.isExternalTexture) t.sourceTexture = null;
      }
    }
  }

  _onContextRestored() {
    for (const e of this.entries.values()) {
      if (!e.done) {
        // Mid-build: its banded uploads went into a dead texture. Start over.
        e.gen = buildBundle(this.game, e.type, this.game.quality);
        continue;
      }
      if (!SKIN_MAPS.some((key) => e.assets.textures[key]?.isExternalTexture)) continue;
      e.gen = repairSkin(this.game, e.assets);
      e.done = false;
      const i = this.queue.indexOf(e);
      if (i >= 0) this.queue.splice(i, 1);
      this.queue.unshift(e);
    }
    // Sharks on screen get their skins back now (one stall, behind a context
    // restore anyway); the rest repaint in the background like a prefetch.
    for (const e of this.entries.values()) {
      if (!e.done && this.inUse?.(e.type)) {
        try {
          this.get(e.type);
        } catch (err) {
          console.warn('[enemies] skin repair after context restore failed', err);
        }
      }
    }
    if (this.queue.length) this._wake();
  }

  _key(type) {
    return `${type}|${this.game.quality}`;
  }

  _entry(type) {
    const key = this._key(type);
    let e = this.entries.get(key);
    if (!e) {
      e = { type, gen: buildBundle(this.game, type, this.game.quality), done: false, assets: null };
      this.entries.set(key, e);
    }
    return e;
  }

  /** Runs one build slice; returns the slice's label (handy for profiling) or 'done'. */
  _step(e) {
    const r = e.gen.next();
    if (r.done) {
      e.done = true;
      e.assets = r.value;
      try {
        this.onReady?.(e.assets);
      } catch (err) {
        console.warn('[enemies] onReady failed', err);
      }
      return 'done';
    }
    return r.value;
  }

  /** Synchronously returns the finished bundle for `type` (finishes any pending build). */
  get(type) {
    const e = this._entry(type);
    while (!e.done) this._step(e);
    return e.assets;
  }

  isReady(type) {
    return this.entries.get(this._key(type))?.done === true;
  }

  /** True while queued builds remain. */
  get busy() {
    return this.queue.length > 0;
  }

  /** Builds `type` in the background (idle slices, plus EnemyManager's frame pump). */
  prefetch(type) {
    const e = this._entry(type);
    if (e.done || this.queue.includes(e)) return;
    this.queue.push(e);
    this._wake();
  }

  /** Queues `type` ahead of everything else (its wave is about to start). */
  prioritize(type) {
    const e = this._entry(type);
    if (e.done) return;
    const i = this.queue.indexOf(e);
    if (i === 0) return;
    if (i > 0) this.queue.splice(i, 1);
    this.queue.unshift(e);
    this._wake();
  }

  /**
   * Runs queued build slices for up to `budget` ms; returns true while work
   * remains. Stops after a slice that sent pixels to the GPU (a texture band
   * or a mip build): uploads are where a busy GPU process can stall the main
   * thread, so they go one per call, i.e. one per frame / idle callback.
   */
  pump(budget) {
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budget) {
      const e = this.queue[0];
      if (e.done) {
        this.queue.shift();
        continue;
      }
      let label;
      try {
        label = this._step(e);
      } catch (err) {
        console.error('[enemies] asset build failed', err);
        this.queue.shift();
        this.entries.delete(this._key(e.type));
        continue;
      }
      if (label === 'upload' || label === 'mips') break;
    }
    while (this.queue.length && this.queue[0].done) this.queue.shift();
    if (!this.queue.length) releaseTextureScratch();
    return this.queue.length > 0;
  }

  _wake() {
    if (this._pumping) return;
    this._pumping = true;
    this._schedule();
  }

  _schedule() {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback((deadline) => this._idle(deadline), { timeout: 250 });
    } else {
      setTimeout(() => this._idle(null), 16);
    }
  }

  _idle(deadline) {
    // Use the browser's idle budget when it has one, else a small fixed slice.
    const budget = deadline && !deadline.didTimeout ? Math.max(1, Math.min(8, deadline.timeRemaining() - 1)) : 4;
    if (this.pump(budget)) this._schedule();
    else this._pumping = false;
  }
}
