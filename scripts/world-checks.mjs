// World module checks that need no browser (no gate):  node scripts/world-checks.mjs
// Builds the real Environment per quality in Node and asserts:
//  - reef-wall shadows: walking from the arena toward the cliff, every wall strip
//    whose shadow on the floor comes within SHADOW_CASTER_FAR (50 m) of the camera
//    is in the casting list (else its shadow pops in on a later re-sort);
//  - warm-up: the whole wreck (incl. the alpha-tested net, outside the medium
//    shadow box at the spawn) is drawn in the warm-up frame, culled afterwards,
//    and the hull has its own shadow-depth material;
//  - sea grass carries the min-screen-width attribute; kelp and sea grass fade out
//    near the camera (patched shader, one material each, alpha-to-coverage on the
//    MSAA presets, unfaded kelp shadow depth); scenery triangle totals.
// Exits 1 on a failed check.
import * as THREE from 'three';
import { WORLD } from '../src/core/config.js';
import { Environment } from '../src/world/Environment.js';
import { LAYOUT, polar } from '../src/world/terrain.js';

const SHADOW_FAR = 50;
let fails = 0;
const check = (name, ok, info) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ` ${JSON.stringify(info)}` : ''}`);
};
const tris = (m) => ((m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3) * (m.isInstancedMesh ? m.count : 1);

for (const quality of ['high', 'medium', 'low']) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 700);
  const game = {
    quality, scene, camera, renderer: null, debug: {}, state: 'title',
    events: { on: () => () => {}, emit: () => {} },
    time: { elapsed: 0, realElapsed: 0, dt: 1 / 60, realDt: 1 / 60 },
    player: { position: new THREE.Vector3(...WORLD.playerSpawn) },
  };
  const env = new Environment(game);
  game.env = env;

  // ---- Warm-up flags on the wreck ----
  const wreck = env._warmAlways ?? [];
  const drawn = () => wreck.every((m) => !m.frustumCulled);
  const atBuild = wreck.length >= 3 && drawn();
  env.update(1 / 60);
  const afterFirst = drawn();
  env.update(1 / 60);
  const afterWarm = wreck.every((m) => m.frustumCulled);
  check(`${quality}: wreck drawn whole in the warm-up frame, culled after`, atBuild && afterFirst && afterWarm, { meshes: wreck.map((m) => m.name) });
  check(`${quality}: wreck hull has its own shadow-depth material`, !!env.wreck.woodMesh.customDepthMaterial);
  check(`${quality}: sea grass has aRibbon (min screen width)`, env.vegetation.grassMeshes.every((m) => m.geometry.attributes.aRibbon?.itemSize === 4));

  // ---- Kelp / sea-grass near fade: the patches land in three's real shader sources ----
  // (string replaces fail silently when an include is renamed). One material per kind, so
  // no extra program; alpha-to-coverage only where PostFX's scene target has MSAA. The
  // kelp shadow depth stays unfaded (a fade there would cut holes in the shadow).
  for (const [kind, meshes] of [['kelp', env.vegetation.kelpMeshes], ['grass', env.vegetation.grassMeshes]]) {
    const mats = new Set(meshes.map((m) => m.material));
    const mat = meshes[0].material;
    const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
    mat.onBeforeCompile(sh, null);
    const fs = sh.fragmentShader;
    const fade = sh.uniforms.uVegNear?.value;
    const a2c = quality !== 'low';
    let depthClean = true;
    const dm = meshes[0].customDepthMaterial;
    if (dm?.onBeforeCompile) {
      const ds = { uniforms: {}, vertexShader: THREE.ShaderLib.depth.vertexShader, fragmentShader: THREE.ShaderLib.depth.fragmentShader };
      dm.onBeforeCompile(ds, null);
      depthClean = !ds.fragmentShader.includes('uVegNear');
    }
    const ok = mats.size === 1 && fs.includes('uniform vec2 uVegNear;') && fs.includes('smoothstep( uVegNear.x, uVegNear.y')
      && fs.includes('varying vec3 vEnvWorldPos;') && fade?.x >= 1 && fade.y > fade.x && mat.alphaToCoverage === a2c && depthClean;
    check(`${quality}: ${kind} fades near the camera`, ok, { near: fade?.toArray(), materials: mats.size, alphaToCoverage: mat.alphaToCoverage, depthClean });
  }

  // ---- Reef-wall shadow reach (shadows on high / medium only) ----
  if (quality !== 'low') {
    const cliff = env.cliff;
    const hf = env.heightfield;
    const sun = env.sunDirection;
    const T = cliff.lists.tiles;
    const pos = cliff.lists.meshes[0].geometry.attributes.position;
    const v = new THREE.Vector3();
    // Shadow footprint per strip: each wall vertex marched down −sun to the floor.
    const foot = [];
    for (let t = 0; t < T.count; t++) {
      const pts = [];
      const seen = new Set();
      for (let i = T.start[t]; i < T.start[t] + T.len[t]; i++) {
        const k = T.index[i];
        if (seen.has(k)) continue;
        seen.add(k);
        v.fromBufferAttribute(pos, k);
        let s = 0;
        while (s < 120 && v.y - sun.y * s > hf.heightAt(v.x - sun.x * s, v.z - sun.z * s) + 0.05) s += 0.5;
        pts.push([v.x - sun.x * s, v.y - sun.y * s, v.z - sun.z * s]);
      }
      foot.push(pts);
    }
    const cf = polar(LAYOUT.cliff.radius - 2, LAYOUT.cliff.center);
    const r = Math.hypot(cf.x, cf.z);
    let missing = 0;
    const share = [];
    for (const D of [90, 74, 66, 62, 58, 54, 50, 40, 30, 20]) {
      const x = cf.x - (cf.x / r) * D;
      const z = cf.z - (cf.z / r) * D;
      const cam = new THREE.Vector3(x, hf.heightAt(x, z) + 7, z);
      cliff.lists._key = NaN;
      cliff.update(cam, SHADOW_FAR);
      let cast = 0;
      for (let t = 0; t < T.count; t++) {
        const o = t * 6;
        const b = T.box;
        const d = Math.hypot(Math.max(b[o] - cam.x, 0, cam.x - b[o + 3]), Math.max(b[o + 1] - cam.y, 0, cam.y - b[o + 4]), Math.max(b[o + 2] - cam.z, 0, cam.z - b[o + 5]));
        const near = Math.min(...foot[t].map((p) => Math.hypot(p[0] - cam.x, p[1] - cam.y, p[2] - cam.z)));
        if (cliff._classify(d, t) === 0) cast += T.len[t];
        else if (near < SHADOW_FAR) missing++;
      }
      share.push([D, +(cast / T.index.length).toFixed(2)]);
    }
    check(`${quality}: every reef-wall strip whose shadow is within ${SHADOW_FAR} m casts`, missing === 0, { missing, castShareByDistance: share });
  }

  const sum = (list) => Math.round(list.reduce((s, m) => s + tris(m), 0));
  console.log(`info ${quality}: triangles rocks ${sum(env.rocks.meshes)} coral ${sum(env.coral.meshes)} kelp ${sum(env.vegetation.kelpMeshes)} grass ${sum(env.vegetation.grassMeshes)}`);
}
console.log(`world checks: ${fails ? `${fails} failed` : 'all passed'}`);
process.exit(fails ? 1 : 0);
