#!/usr/bin/env node
// Node-only check (no browser) of the quality preset selection in
// src/core/quality.js: GPU-string mapping and URL > saved > debug > detected
// precedence. Run: node scripts/core-quality-check.mjs  (exits 1 on failure)
import { qualityForGpu, resolveQuality, saveQuality, readSavedQuality, QUALITY_STORAGE_KEY } from '../src/core/quality.js';

let failed = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} → ${got}${ok ? '' : ` (want ${want})`}`);
};

const GPUS = [
  ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
  ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
  ['Mesa Intel(R) UHD Graphics 630 (CFL GT2)', 'low'],
  ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ['ANGLE (Intel, Intel(R) Arc(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ['ANGLE (NVIDIA, NVIDIA GeForce MX150 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
  ['ANGLE (NVIDIA, NVIDIA GeForce GT 1030 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
  ['ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
  ['ANGLE (AMD, AMD Radeon(TM) Vega 8 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
  ['AMD Radeon Graphics (renoir, LLVM 15.0.7, DRM 3.49, 6.1.0)', 'low'],
  ['ANGLE (AMD, AMD Radeon 780M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
  ['ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
  ['ANGLE (AMD, AMD Radeon Pro 5500M OpenGL Engine, OpenGL 4.1)', 'high'],
  ['Apple M1', 'medium'],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', 'medium'],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'medium'],
  ['Apple M2 Pro', 'high'],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)', 'high'],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)', 'high'],
  ['Apple GPU', 'medium'],
  ['ANGLE (Qualcomm, Adreno (TM) 640, OpenGL ES 3.2)', 'low'],
  ['Mali-G78', 'low'],
  ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'low'],
  ['ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)', 'low'],
  ['ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
  ['', 'high'],
];
for (const [s, want] of GPUS) check(`gpu "${s}"`, qualityForGpu(s), want);

// hints
check('RTX 3060 + deviceMemory 4', qualityForGpu('NVIDIA GeForce RTX 3060', { deviceMemory: 4 }), 'low');
check('RTX 3060 + deviceMemory 8', qualityForGpu('NVIDIA GeForce RTX 3060', { deviceMemory: 8 }), 'high');
check('Apple M1 + deviceMemory 8', qualityForGpu('Apple M1', { deviceMemory: 8 }), 'medium');
check('unknown + mobile UA', qualityForGpu('', { mobile: true }), 'low');

// precedence
const mem = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};
const glFor = (name) => ({
  RENDERER: 0x1f01,
  getParameter: (p) => (p === 0x1f01 ? 'WebKit WebGL' : p === 0x9246 ? name : null),
  getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null),
});
const intel = glFor('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)');
const nav = { deviceMemory: 8, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' };
const q = (query, storage, debug = {}) =>
  resolveQuality({ params: new URLSearchParams(query), debug, gl: intel, nav, storage });

let s = mem();
check('detected (intel, nothing saved)', q('', s).quality, 'low');
check('detected source', q('', s).source, 'detected');
check('gpu string read through the debug extension', q('', s).gpu.includes('UHD Graphics 620'), true);
check('?quality=medium overrides detection', q('quality=medium', s).quality, 'medium');
check('autostart keeps harness baseline high', q('autostart', s, { autostart: true }).quality, 'high');
check('fixeddt keeps harness baseline high', q('fixeddt', s, { fixedDt: true }).quality, 'high');
check('saveQuality(low)', saveQuality('low', s), true);
check(`saved under "${QUALITY_STORAGE_KEY}"`, s.getItem('fish.quality'), 'low');
check('saved choice wins over detection', q('', s).quality, 'low');
check('saved source', q('', s).source, 'saved');
saveQuality('high', s);
check('saved high on an intel iGPU', q('', s).quality, 'high');
check('saved choice wins over the debug default', q('autostart', s, { autostart: true }).quality, 'high');
check('?quality=medium overrides a saved choice', q('quality=medium', s).quality, 'medium');
check('invalid ?quality ignored', q('quality=ultra', s).quality, 'high');
s.setItem('fish.quality', 'ultra');
check('invalid saved value ignored', readSavedQuality(s), null);
check('saveQuality rejects junk', saveQuality('ultra', s), false);
const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
check('blocked storage → detection', q('', throwing).quality, 'low');
check('blocked storage save → false', saveQuality('low', throwing), false);
check('no context → unknown gpu → high', resolveQuality({ params: new URLSearchParams(''), gl: null, nav, storage: null }).quality, 'high');
const firefox = { RENDERER: 0x1f01, getParameter: () => 'NVIDIA GeForce GTX 980, or similar', getExtension: () => null };
check('firefox RENDERER string', resolveQuality({ params: new URLSearchParams(''), gl: firefox, nav, storage: null }).quality, 'high');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall quality checks passed');
process.exit(failed ? 1 : 0);
