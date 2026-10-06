// The reef wall: a tall, craggy rock face bending around the north of the
// arena. It is a dedicated displaced grid (real overhang-free crags, strata
// ledges) laid in front of the heightfield's steep ramp, which stays hidden
// behind it and still provides getSeabedHeight() collision. The top rows fold
// back over the plateau and dive under it so no seam is visible.
//
// Draw lists (tileLists.js): the wall is cut into STRIPS vertical strips
// sorted per camera position into near (full shading; casting while the
// strip's shadow — thrown ~16 m out across the floor — may lie within shadow
// reach) and far (fog-LOD material wholly beyond FOG_LOD_X), one draw call
// each; strips in opaque fog are dropped. `mesh` is the Group of lists.
import * as THREE from 'three';
import { fbm3, ridged3, noise2, smoothstep } from './noise.js';
import { LAYOUT, cliffRadius } from './terrain.js';
import { createRockMaterial } from './Rocks.js';
import { FOG_OPAQUE_X, FOG_LOD_X } from './waterShading.js';
import { TileLists } from './tileLists.js';

const STRIPS = 24; // LOD / culling granularity along the arc (≈ 7 m of wall each)
const HYSTERESIS = 4; // metres the camera may move before the lists are re-sorted
// Draw lists.
const NEAR_CAST = 0;
const NEAR = 1;
const FAR = 2;

export class Cliff {
  constructor(env) {
    const hf = env.heightfield;
    const c = LAYOUT.cliff;
    const q = env.quality;
    const nu = q === 'low' ? 150 : q === 'medium' ? 200 : 260; // along the arc
    const nvFace = q === 'low' ? 40 : q === 'medium' ? 52 : 64; // up the face
    const nvTop = 6; // rows folding over the plateau
    const nv = nvFace + nvTop;
    const th0 = c.center - c.half;
    const th1 = c.center + c.half;

    const pos = new Float32Array((nu + 1) * (nv + 1) * 3);
    const col = new Float32Array((nu + 1) * (nv + 1) * 3);
    const p = new THREE.Vector3();
    for (let iu = 0; iu <= nu; iu++) {
      const th = th0 + (th1 - th0) * (iu / nu);
      const R = cliffRadius(th);
      const sx = Math.sin(th);
      const sz = -Math.cos(th);
      // Ground in front of the wall and on the plateau behind it.
      const yFoot = hf.heightAt(sx * (R - 1), sz * (R - 1)) - 3;
      const yTop = hf.heightAt(sx * (R + c.rise + 1.5), sz * (R + c.rise + 1.5));
      const wallH = Math.max(0.5, yTop - yFoot);
      for (let iv = 0; iv <= nv; iv++) {
        let r;
        let y;
        let crag = 0;
        if (iv <= nvFace) {
          const t = iv / nvFace;
          y = yFoot + wallH * t;
          // Lean back with height; stay in front of the hidden ramp.
          const base = R + 0.6 + 3.2 * t;
          const px = sx * base;
          const pz = sz * base;
          const n1 = fbm3(px / 11, y / 9, pz / 11, 4);
          const n2 = ridged3(px / 4.5, y / 3.5, pz / 4.5, 4);
          // Buttresses and gullies: low-frequency bulges along the arc.
          const arc = th * R;
          const buttress = fbm3(arc / 14, y / 30, 3.7, 3) * 3.2;
          const gully = Math.pow(1 - Math.abs(noise2(arc / 9 + 11, y / 40)), 6) * 2.6;
          // Strata with varying thickness, broken into ledge segments.
          const band = (y + n1 * 4 + fbm3(arc / 25, 1.3, 2.1, 2) * 6 + 200) / 4.1;
          const fr = band - Math.floor(band);
          const ledgeOn = smoothstep(-0.05, 0.25, noise2(arc / 7, Math.floor(band) * 3.1));
          const ledge = smoothstep(0.6, 0.9, fr) * (1 - smoothstep(0.9, 1.0, fr)) * ledgeOn;
          crag = 1.6 + n1 * 2.0 + n2 * 2.4 + buttress + ledge * 1.0 - gully;
          // Less relief where the wall is low (tapered ends) and at the very top.
          crag *= smoothstep(0, 8, wallH) * (1 - smoothstep(0.92, 1, t) * 0.6);
          crag = Math.max(0.25, crag);
          r = base - crag;
          // Small tangential jitter so columns don't read as a grid.
          const jt = noise2(px / 6 + y / 7, pz / 6) * 0.6;
          p.set(sx * r + -sz * jt, y, sz * r + sx * jt);
        } else {
          // Fold back over the plateau, then dive below it.
          const k = (iv - nvFace) / nvTop;
          r = R + 0.6 + 3.2 + k * 9;
          const x = sx * r;
          const z = sz * r;
          const ground = hf.heightAt(x, z);
          const lip = THREE.MathUtils.lerp(yTop + 0.4, ground - 0.8, smoothstep(0, 1, k));
          y = Math.max(lip, ground - 0.8) + fbm3(x / 5, 0.3, z / 5, 2) * 0.4 * (1 - k);
          p.set(x, y, z);
          crag = 1.5;
        }
        const i = iu * (nv + 1) + iv;
        pos[i * 3] = p.x;
        pos[i * 3 + 1] = p.y;
        pos[i * 3 + 2] = p.z;
        // AO: recesses and the foot darker, protrusions lighter.
        const t = Math.min(1, iv / nvFace);
        const ao = THREE.MathUtils.clamp(0.5 + crag * 0.12, 0.35, 1.0) * (0.6 + 0.4 * smoothstep(0, 0.25, t));
        col[i * 3] = ao;
        col[i * 3 + 1] = ao;
        col[i * 3 + 2] = ao;
      }
    }
    const index = [];
    for (let iu = 0; iu < nu; iu++) {
      for (let iv = 0; iv < nv; iv++) {
        const a = iu * (nv + 1) + iv;
        const b = (iu + 1) * (nv + 1) + iv;
        const cI = iu * (nv + 1) + iv + 1;
        const d = (iu + 1) * (nv + 1) + iv + 1;
        index.push(a, b, cI, b, d, cI);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();

    // Cut the arc into strips (whole columns; normals come from the whole
    // grid, so strip borders shade seamlessly).
    this.material = createRockMaterial(env, { siltAmount: 0.8, scale: 7.5 });
    // Cheap shading for strips deep in the fog.
    this.farMaterial = createRockMaterial(env, { siltAmount: 0.8, scale: 7.5, far: true });
    const rowLen = nv + 1;
    const tiles = {
      index: new Uint16Array(nu * nv * 6),
      start: new Uint32Array(STRIPS),
      len: new Uint32Array(STRIPS),
      box: new Float32Array(STRIPS * 6),
      count: STRIPS,
    };
    let k = 0;
    for (let s = 0; s < STRIPS; s++) {
      const u0 = Math.round((s * nu) / STRIPS);
      const u1 = Math.round(((s + 1) * nu) / STRIPS);
      tiles.start[s] = k;
      for (let iu = u0; iu < u1; iu++) {
        for (let iv = 0; iv < nv; iv++) {
          const a = iu * rowLen + iv;
          const b = a + rowLen;
          const idx = tiles.index;
          idx[k++] = a;
          idx[k++] = b;
          idx[k++] = a + 1;
          idx[k++] = b;
          idx[k++] = b + 1;
          idx[k++] = a + 1;
        }
      }
      tiles.len[s] = k - tiles.start[s];
      const bmin = [Infinity, Infinity, Infinity];
      const bmax = [-Infinity, -Infinity, -Infinity];
      for (let i = u0 * rowLen; i < (u1 + 1) * rowLen; i++) {
        for (let c = 0; c < 3; c++) {
          bmin[c] = Math.min(bmin[c], pos[i * 3 + c]);
          bmax[c] = Math.max(bmax[c], pos[i * 3 + c]);
        }
      }
      tiles.box.set([...bmin, ...bmax], s * 6);
    }
    const all = tiles.index.length;
    const shadows = q !== 'low';
    this.lists = new TileLists(
      tiles,
      { position: geo.attributes.position, normal: geo.attributes.normal, color: geo.attributes.color },
      [
        { name: 'cliff-near-cast', material: this.material, capacity: shadows ? all : 0, castShadow: true, receiveShadow: true },
        { name: 'cliff-near', material: this.material, capacity: all, receiveShadow: true },
        { name: 'cliff-far', material: this.farMaterial, capacity: all },
      ],
      { hysteresis: HYSTERESIS },
    );
    this.mesh = this.lists.group;
    this.mesh.name = 'cliff';
    this.meshes = this.lists.meshes;
    // Shadow reach per strip: its AABB swept along −sunDirection by its own
    // height, i.e. everything its shadow can fall on. A 30-35 m wall throws
    // its shadow ~16 m out across the floor toward the arena (sun 25° off
    // zenith), so judging a strip by the wall alone switched its shadow on
    // only once the camera was within reach of the wall itself — the shadow
    // popped onto the seabed 35-50 m away as the lists re-sorted.
    const sun = env.sunDirection ?? new THREE.Vector3(0, 1, 0);
    const box = tiles.box;
    const castBox = new Float32Array(STRIPS * 6);
    for (let s = 0; s < STRIPS; s++) {
      const o = s * 6;
      const k = (box[o + 4] - box[o + 1]) / Math.max(sun.y, 0.2);
      for (let c = 0; c < 3; c++) {
        const t = -sun.getComponent(c) * k;
        castBox[o + c] = Math.min(box[o + c], box[o + c] + t);
        castBox[o + 3 + c] = Math.max(box[o + 3 + c], box[o + 3 + c] + t);
      }
    }
    this._castBox = castBox;
    this._sortCam = new THREE.Vector3();
    // Classifier: near = any part possibly within the fog-LOD distance, cast =
    // its shadow possibly within shadow reach (a far strip that casts goes in
    // the cast list: same look under the fog), dropped = surely in opaque fog;
    // radii from the base fog density (the live one is never thinner) plus the
    // hysteresis margin.
    const M = HYSTERESIS;
    const keepR = FOG_OPAQUE_X / env.fogDensity + M;
    const lodR = FOG_LOD_X / env.fogDensity + M;
    this._castR = M;
    this._classify = (d, t) => {
      if (d >= keepR) return -1;
      if (shadows && this._castDist(t) < this._castR) return NEAR_CAST;
      return d < lodR ? NEAR : FAR;
    };
  }

  /** Distance from the sorting camera to strip `t`'s shadow-reach box. */
  _castDist(t) {
    const b = this._castBox;
    const o = t * 6;
    const p = this._sortCam;
    const dx = Math.max(b[o] - p.x, 0, p.x - b[o + 3]);
    const dy = Math.max(b[o + 1] - p.y, 0, p.y - b[o + 4]);
    const dz = Math.max(b[o + 2] - p.z, 0, p.z - b[o + 5]);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Per render: re-sort the strips once the camera `cam` has left the
   * hysteresis radius. `castFar` = distance beyond which static scenery casts
   * no shadow (here: beyond which its shadow lies).
   */
  update(cam, castFar) {
    this._castR = castFar + HYSTERESIS;
    this._sortCam.copy(cam);
    return this.lists.update(cam, castFar, this._classify);
  }

  /** Warm-up frame: every list drawn, so all programs compile up front. */
  setWarm(on) {
    this.lists.setWarm(on);
  }
}
