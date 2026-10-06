// Small shared helpers for the ambient-life systems.
import * as THREE from 'three';

/** Deterministic PRNG (mulberry32) so the ocean looks the same every run. */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.sign = () => (next() < 0.5 ? -1 : 1);
  return next;
}

export function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Add a shader patch to a material without clobbering an existing
 * onBeforeCompile (e.g. Environment.patchMaterial's caustics injection).
 * `key` must be unique per patch variant so three.js does not share programs
 * between materials whose chained callbacks stringify identically.
 */
export function chainShaderPatch(material, key, patch) {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  const base = THREE.Material.prototype.onBeforeCompile;
  const baseKey = THREE.Material.prototype.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) {
    if (prev && prev !== base) prev.call(this, shader, renderer);
    patch(shader, renderer);
  };
  material.customProgramCacheKey = function () {
    const before = prevKey && prevKey !== baseKey ? prevKey.call(this) : prev && prev !== base ? prev.toString() : '';
    return `${before}|${key}`;
  };
  material.needsUpdate = true;
  return material;
}

/** Safe wrapper around Environment.patchMaterial (may be a stub / missing). */
export function envPatch(game, material) {
  try {
    const out = game.env?.patchMaterial?.(material);
    return out && out.isMaterial ? out : material;
  } catch (err) {
    console.warn('[AmbientLife] env.patchMaterial failed', err);
    return material;
  }
}

/** Current scene fog as an exp² density (linear Fog is approximated). */
export function sceneFogDensity(scene) {
  const fog = scene.fog;
  if (!fog) return 0;
  if (fog.isFogExp2) return fog.density;
  if (fog.isFog) return 1.8 / Math.max(1, fog.far);
  return 0;
}
