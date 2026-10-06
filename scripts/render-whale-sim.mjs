// Browser-free check of the sperm-whale pass (src/world/ambient/SpermWhale.js): how much of
// the boss breather (FLOW.breatherBeforeBoss, 6.2 s) the whale's centre spends on screen, for
// random follow-camera poses after the tiger kill. No browser, no gate:
//
//   node scripts/render-whale-sim.mjs [poses=400] [--rmax 50] [--diag]
//
// Poses: 老公 at r ≤ rmax m (default 50; 95 includes the trench / reef edges), 14–40 m deep,
// any yaw, pitch −0.7..0.25 (mostly still looking down at the kill); the follow camera 5 m
// behind. Two camera models: `fixed` (the pose holds) and `levelling` (pitch eases to 0.05
// from 0.3 s in, time constant 0.5 s — CameraRig in the boss breather). The real start() /
// update() / path fitting run on a stub whale (no mesh) over the analytic seabed
// (terrain.analyticHeight, the function the game's heightfield samples).
// Prints, per model, the mean / quartile on-screen share, the share of poses under 40 %, and
// the closest approach to the camera. Exits 1 if the levelling model's mean is under 0.6.
import * as THREE from 'three';
import { SpermWhale } from '../src/world/ambient/SpermWhale.js';
import { analyticHeight } from '../src/world/terrain.js';

const args = process.argv.slice(2);
const N = +(args.find((a) => /^\d+$/.test(a)) ?? 400);
const ri = args.indexOf('--rmax');
const RMAX = ri >= 0 ? +args[ri + 1] : 50;
const DIAG = args.includes('--diag');
const BREATHER = 6.2;
const DT = 1 / 60;

let seed = 777;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 700);
const game = { camera: cam, player: { position: new THREE.Vector3() }, env: { getSeabedHeight: analyticHeight, setLightDim() {} } };

// The whale's path logic without its mesh / textures (those need a DOM canvas).
function stubWhale() {
  const w = Object.create(SpermWhale.prototype);
  Object.assign(w, {
    game, active: false, t: 0, duration: 1, beatPhase: 0, passes: 0, _dimmed: false, fade: 1,
    p0: new THREE.Vector3(), p1: new THREE.Vector3(), p2: new THREE.Vector3(),
    uniforms: { uBeatPhase: { value: 0 }, uBeatAmp: { value: 0.55 }, uSelfDark: { value: 0.5 } },
    material: { opacity: 0 }, group: new THREE.Group(),
  });
  return w;
}

const fwd = new THREE.Vector3();
const ndc = new THREE.Vector3();
const look = new THREE.Vector3();
function pose(p, yaw, pitch) {
  fwd.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  cam.position.copy(p).addScaledVector(fwd, -5);
  cam.position.y += 0.8;
  cam.position.y = Math.max(cam.position.y, analyticHeight(cam.position.x, cam.position.z) + 1);
  cam.lookAt(look.copy(cam.position).add(fwd));
  cam.updateMatrixWorld();
}

function run(levelling) {
  seed = 777;
  const res = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    let r, x, z, floor;
    do {
      r = RMAX * Math.sqrt(rnd());
      const a = rnd() * Math.PI * 2;
      x = r * Math.cos(a);
      z = r * Math.sin(a);
      floor = analyticHeight(x, z);
    } while (floor > -20); // not on the reef plateau
    p.set(x, Math.max(floor + 2, -14 - rnd() * 26), z);
    const yaw = rnd() * Math.PI * 2;
    const pitch0 = -0.7 + rnd() * 0.95;
    pose(p, yaw, pitch0);
    const w = stubWhale();
    w.start();
    let n = 0;
    let on = 0;
    let minD = Infinity;
    for (let k = 0, t = 0; t < BREATHER && w.active; k++, t += DT) {
      const pitch = levelling && t > 0.3 ? 0.05 + (pitch0 - 0.05) * Math.exp(-(t - 0.3) / 0.5) : pitch0;
      pose(p, yaw, pitch);
      w.update(DT);
      if (k % 5) continue;
      n++;
      ndc.copy(w.position).project(cam);
      if (ndc.z < 1 && Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1) on++;
      minD = Math.min(minD, w.position.distanceTo(cam.position));
    }
    res.push({ on: n ? on / n : 0, minD, r: +r.toFixed(0), y: +p.y.toFixed(0), yaw: +yaw.toFixed(2), pitch0: +pitch0.toFixed(2) });
  }
  if (DIAG) for (const x of res.filter((x) => x.on < 0.4).slice(0, 20)) console.log('  low', JSON.stringify(x));
  const sorted = (f) => res.map(f).sort((a, b) => a - b);
  const q = (a, f) => +a[Math.floor(f * (a.length - 1))].toFixed(2);
  const ons = sorted((x) => x.on);
  const ds = sorted((x) => x.minD);
  return {
    onMean: +(ons.reduce((s, v) => s + v, 0) / ons.length).toFixed(3),
    onP25: q(ons, 0.25),
    onMedian: q(ons, 0.5),
    under40: +(res.filter((x) => x.on < 0.4).length / res.length).toFixed(3),
    closest: { min: q(ds, 0), median: q(ds, 0.5), max: q(ds, 1) },
  };
}

const fixed = run(false);
const levelling = run(true);
console.log(`whale-sim (${N} poses, r ≤ ${RMAX} m) fixed     ${JSON.stringify(fixed)}`);
console.log(`whale-sim (${N} poses, r ≤ ${RMAX} m) levelling ${JSON.stringify(levelling)}`);
process.exit(levelling.onMean >= 0.6 ? 0 : 1);
