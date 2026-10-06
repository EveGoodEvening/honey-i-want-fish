// Picks the render quality preset ('low' | 'medium' | 'high') before any
// module is built. Precedence:
//
//   1. ?quality=low|medium|high in the URL — a one-off override, never saved.
//   2. The player's last choice on the title screen (localStorage 'fish.quality',
//      written by the UI right before it reloads with the new preset).
//   3. 'high' for scripted runs (?autostart / ?fixeddt) so smoke and review
//      harnesses keep their baselines without passing ?quality.
//   4. A guess from the GPU: on integrated graphics `high` costs 7–10× `low`
//      (perf review: 540 ms vs 51–76 ms synced frames, 236 MB vs 27 MB of GPU
//      memory), and `low` keeps the look.
//
// The guess reads the renderer string from the game's own WebGL context rather
// than a throwaway canvas: the game asks for powerPreference 'high-performance',
// so on dual-GPU laptops a default-preference probe would report the
// integrated chip while the game actually renders on the discrete one.
//
// Pure functions (no DOM access unless a context/navigator is passed in), so
// scripts/core-quality-check.mjs can test the mapping in Node.

export const QUALITIES = ['low', 'medium', 'high'];
export const QUALITY_STORAGE_KEY = 'fish.quality';

const RANK = { low: 0, medium: 1, high: 2 };
const isQuality = (q) => typeof q === 'string' && Object.hasOwn(RANK, q);
const cap = (q, max) => (RANK[q] > RANK[max] ? max : q);

// Software rasterisers (CPU rendering): only `low` is remotely playable.
const SOFTWARE = /SwiftShader|llvmpipe|lavapipe|softpipe|Software Rasteri[sz]er|Microsoft Basic Render/i;
// Intel's discrete Arc cards (A380…B580) — the integrated "Arc(TM) Graphics" has no model number.
const INTEL_DISCRETE = /\bArc(\(TM\))? [AB]\d{3}/i;
// Integrated and mobile GPUs, plus the entry-level NVIDIA laptop/desktop parts
// (MX150…MX570, GT 710…1030, 9x0M) that are no faster than a good iGPU.
const LOW_END =
  /Intel|UHD|Iris|Radeon(\(TM\))? Graphics|Vega \d+ Graphics|Mali|Adreno|PowerVR|Apple A\d+|GeForce (MX ?\d+|GT \d+|\d{3}MX?\b)/i;
// AMD's big RDNA2/3 iGPUs (Radeon 660M/680M/760M/780M/880M/890M) handle `medium`.
const STRONG_APU = /Radeon(\(TM\))? (6[68]|7[68]|8[89])0M\b/i;
// Base Apple M1 / M2 (not Pro/Max/Ultra), and Safari's masked "Apple GPU",
// which is most often a base M-series chip.
const APPLE_BASE = /Apple M[12]\b(?! (Pro|Max|Ultra))|^Apple GPU$/i;
const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i;

/**
 * Maps an (unmasked) GPU renderer string to a preset.
 * @param {string} renderer  e.g. 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 …)'
 * @param {{deviceMemory?: number, mobile?: boolean}} [hints]
 *   deviceMemory: navigator.deviceMemory (GiB, Chromium only); mobile: phone/tablet UA.
 */
export function qualityForGpu(renderer, { deviceMemory, mobile = false } = {}) {
  const r = String(renderer ?? '');
  let q = 'high';
  if (SOFTWARE.test(r)) q = 'low';
  else if (INTEL_DISCRETE.test(r)) q = 'high';
  else if (STRONG_APU.test(r)) q = 'medium';
  else if (LOW_END.test(r)) q = 'low';
  else if (APPLE_BASE.test(r)) q = 'medium';
  // Memory-starved machines can't hold the high/medium texture and target set.
  if (typeof deviceMemory === 'number' && deviceMemory > 0 && deviceMemory <= 4) q = cap(q, 'low');
  if (mobile) q = cap(q, 'low');
  return q;
}

/** Unmasked renderer string of a WebGL context ('' when the browser hides it). */
export function gpuRendererName(gl) {
  if (!gl) return '';
  try {
    // Firefox returns the (sanitised) real name from RENDERER and deprecates the
    // debug extension; Chromium/WebKit return a generic "WebKit WebGL" there.
    const plain = String(gl.getParameter(gl.RENDERER) ?? '');
    if (plain && !/^(WebKit WebGL|Mozilla)$/i.test(plain)) return plain;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') : plain;
  } catch {
    return '';
  }
}

// Even reading `localStorage` throws when site data is blocked (sandboxed
// iframes, some privacy modes), so it is only touched inside try blocks.
const defaultStorage = () => globalThis.localStorage;

/** The quality saved by the title screen, or null. */
export function readSavedQuality(storage) {
  try {
    const q = (storage === undefined ? defaultStorage() : storage)?.getItem(QUALITY_STORAGE_KEY);
    return isQuality(q) ? q : null;
  } catch {
    return null;
  }
}

/** Remembers the player's choice for the next visit. Returns false if storage is unavailable. */
export function saveQuality(q, storage) {
  if (!isQuality(q)) return false;
  try {
    const s = storage === undefined ? defaultStorage() : storage;
    if (!s) return false;
    s.setItem(QUALITY_STORAGE_KEY, q);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the preset for this page load (precedence in the header).
 * @returns {{quality: string, source: 'url'|'saved'|'debug'|'detected', gpu: string}}
 */
export function resolveQuality({ params, debug = {}, gl = null, nav = globalThis.navigator, storage } = {}) {
  const gpu = gpuRendererName(gl);
  const fromUrl = params?.get?.('quality');
  if (isQuality(fromUrl)) return { quality: fromUrl, source: 'url', gpu };
  const saved = readSavedQuality(storage);
  if (saved) return { quality: saved, source: 'saved', gpu };
  if (debug.autostart || debug.fixedDt) return { quality: 'high', source: 'debug', gpu };
  const quality = qualityForGpu(gpu, {
    deviceMemory: nav?.deviceMemory,
    mobile: MOBILE_UA.test(nav?.userAgent ?? ''),
  });
  return { quality, source: 'detected', gpu };
}
