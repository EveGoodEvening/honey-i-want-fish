// The sunken wooden fishing boat on the East China Sea floor: planked hull
// with a staved-in side and exposed ribs, collapsed deck, wheelhouse with a
// slumped roof, snapped mast lying across the gunwale, sagging stays, a float
// line rising into the murk, a net spilling onto the sand, old tyres used as
// fenders, an anchor and chain, and the faded registration 「东海渔 3127」.
//
// Local frame: +Z bow, +X starboard, +Y up, origin midship at deck level.
// Draw calls: wood, props (vertex colours), net (alpha-tested), name decal.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, smoothstep, noise2 } from './noise.js';
import { LAYOUT, wreckBaseY } from './terrain.js';

const L = 15; // length (m)
const HB = 2.3; // half beam
const D = 2.3; // depth keel → sheer, midship

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

function beamAt(s) {
  if (s < 0.42) return HB * (0.8 + 0.2 * smoothstep(0, 0.42, s));
  const k = (s - 0.42) / 0.58;
  return HB * Math.pow(Math.max(0, Math.cos((k * Math.PI) / 2)), 0.72);
}
const sheerAt = (s) => 0.95 * Math.pow(s, 2.6) + 0.35 * Math.pow(1 - s, 3);
function keelAt(s) {
  let y = -D;
  if (s > 0.78) y += ((s - 0.78) / 0.22) ** 1.5 * D * 0.9; // forefoot rises
  if (s < 0.05) y += ((0.05 - s) / 0.05) * 0.5;
  return y;
}
/** Hull surface point: s 0 (stern) → 1 (bow), a −1 (port gunwale) → 0 (keel) → +1 (starboard gunwale). */
function hullPoint(s, a, out) {
  const hb = beamAt(s);
  const ys = sheerAt(s);
  const yk = keelAt(s);
  const phi = (a * Math.PI) / 2;
  const sx = Math.sin(phi);
  out.set(hb * Math.sign(sx) * Math.pow(Math.abs(sx), 0.6), ys - (ys - yk) * Math.pow(Math.cos(phi), 1.35), (s - 0.5) * L);
  return out;
}

/** Ensure a geometry has exactly the given attributes (adds white colour if missing). */
function conform(geo, names) {
  if (!geo.index) {
    const n = geo.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  for (const k of Object.keys(geo.attributes)) if (!names.includes(k)) geo.deleteAttribute(k);
  if (names.includes('color') && !geo.attributes.color) {
    const c = new Float32Array(geo.attributes.position.count * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  if (names.includes('uv') && !geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  return geo;
}

function tint(geo, rgb) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = rgb[0];
    c[i * 3 + 1] = rgb[1];
    c[i * 3 + 2] = rgb[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/** Box with UVs scaled to metres (wood texture tiles: 3 m along U, 1.6 m along V). */
function woodBox(w, h, d, alongZ = true) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    let u;
    let v;
    if (ax > 0.5) {
      u = alongZ ? z : y;
      v = alongZ ? y : z;
    } else if (ay > 0.5) {
      u = alongZ ? z : x;
      v = alongZ ? x : z;
    } else {
      u = alongZ ? y : x;
      v = alongZ ? x : y;
    }
    uv.setXY(i, u / 3, v / 1.6);
  }
  return g;
}

/** Indexed grid: fn(i/nu, j/nv) → [x, y, z, u, v, r, g, b] or null to cut a cell corner. */
function gridGeometry(nu, nv, fn, keepCell) {
  const pos = [];
  const uv = [];
  const col = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const r = fn(i / nu, j / nv, i, j);
      pos.push(r[0], r[1], r[2]);
      uv.push(r[3], r[4]);
      col.push(r[5] ?? 1, r[6] ?? 1, r[7] ?? 1);
    }
  }
  const idx = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      if (keepCell && !keepCell(i, j)) continue;
      const a = j * (nu + 1) + i;
      const b = a + 1;
      const c = a + nu + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function tube(points, radius, segs = 24, radial = 5, rgb = [0.5, 0.45, 0.35]) {
  const curve = new THREE.CatmullRomCurve3(points);
  const g = new THREE.TubeGeometry(curve, segs, radius, radial, false);
  return tint(g, rgb);
}

/** Sagging rope between two points. */
function rope(a, b, sag, radius = 0.025, rgb = [0.42, 0.4, 0.32]) {
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    p.y -= Math.sin(t * Math.PI) * sag;
    pts.push(p);
  }
  return tube(pts, radius, 20, 4, rgb);
}

export class Wreck {
  constructor(env) {
    const hf = env.heightfield;
    const q = env.quality;
    const w = LAYOUT.wreck;
    const rand = mulberry32(31274);
    const tex = env.textures;
    this.group = new THREE.Group();
    this.group.name = 'wreck';
    // Rolled toward the arena (port side down), bow slightly buried.
    this.group.position.set(w.x, wreckBaseY() + 1.3, w.z);
    this.group.rotation.set(-0.05, w.heading, 0.26, 'YXZ');
    this.group.updateMatrixWorld(true);
    const toWorld = (v) => v.applyMatrix4(this.group.matrixWorld);
    const inv = new THREE.Matrix4().copy(this.group.matrixWorld).invert();
    const toLocal = (v) => v.applyMatrix4(inv);

    const wood = [];
    const props = [];

    // ---------------- Hull ----------------
    const ns = q === 'low' ? 32 : 48;
    const na = 28;
    // Girth (arc length from the port gunwale) per station, for plank UVs.
    const girth = [];
    for (let i = 0; i <= ns; i++) {
      const s = i / ns;
      const row = [0];
      const p0 = hullPoint(s, -1, new THREE.Vector3());
      for (let j = 1; j <= na; j++) {
        const p1 = hullPoint(s, -1 + (2 * j) / na, new THREE.Vector3());
        row.push(row[j - 1] + p1.distanceTo(p0));
        p0.copy(p1);
      }
      girth.push(row);
    }
    // Hole on the port side + missing planks near the starboard stern quarter.
    const plankJitter = [];
    for (let j = 0; j < na; j++) plankJitter.push([rand() * 0.06, rand() * 0.07, rand()]);
    const keepCell = (i, j) => {
      const s = (i + 0.5) / ns;
      const a = -1 + (2 * (j + 0.5)) / na;
      const [j0, j1, r] = plankJitter[j];
      if (a > -0.86 && a < -0.38 && s > 0.3 - j0 - (a + 0.6) * 0.1 && s < 0.5 + j1 + Math.sin(a * 7) * 0.03) return false;
      if (a > 0.7 && s > 0.12 && s < 0.22 + r * 0.06 && r > 0.35) return false;
      if (a < -0.9 && s > 0.62 && s < 0.68 + r * 0.04) return false;
      return true;
    };
    const hull = gridGeometry(ns, na, (u, v, i, j) => {
      hullPoint(u, -1 + 2 * v, _v);
      // Paint over the planking (vertex colour multiplies the dark wood map):
      // faded blue-grey topsides, a white sheer stripe, dull red-brown bottom,
      // with patches where the paint has flaked off to bare wood.
      const a = -1 + 2 * v;
      const top = Math.abs(a);
      let c;
      if (top > 0.93) c = [2.0, 2.05, 2.1];
      else if (top > 0.55) c = [1.25, 1.6, 1.95];
      else c = [1.6, 0.95, 0.8];
      if (noise2(u * 16 + 3, v * 9) > 0.32) c = [1.1, 1.05, 1.0];
      const fade = 0.85 + noise2(u * 9, v * 5) * 0.2;
      return [_v.x, _v.y, _v.z, _v.z / 3, girth[i][j] / 1.6, c[0] * fade, c[1] * fade, c[2] * fade];
    }, keepCell);
    wood.push(hull);
    // Transom.
    const transom = gridGeometry(12, 3, (u, v) => {
      hullPoint(0, -1 + 2 * u, _v);
      const top = sheerAt(0);
      const y = THREE.MathUtils.lerp(_v.y, top, v);
      return [_v.x, y, _v.z, _v.x / 3, y / 1.6, 1.25, 1.55, 1.85];
    });
    wood.push(transom);
    // Keel and stem post.
    const keel = woodBox(0.22, 0.3, L * 0.86);
    keel.translate(0, -D - 0.08, -0.6);
    wood.push(keel);
    const stem = woodBox(0.2, 3.2, 0.25);
    stem.rotateX(-0.45);
    stem.translate(0, -0.2, L / 2 - 0.35);
    wood.push(stem);
    // Ribs (frames) along the inside — visible through the hole.
    for (let k = 1; k < 18; k++) {
      const s = 0.05 + (k / 18) * 0.75;
      if (rand() < 0.12) continue;
      const pts = [];
      const reach = s > 0.3 && s < 0.5 && rand() < 0.6 ? -0.45 : -1; // some ribs snapped
      for (let j = 0; j <= 12; j++) {
        const a = THREE.MathUtils.lerp(reach, 1, j / 12);
        hullPoint(s, a, _v);
        _v.x *= 0.95;
        _v.y = _v.y * 0.97 + 0.02;
        pts.push(_v.clone());
      }
      const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.07, 4, false);
      wood.push(tint(g, [0.85, 0.8, 0.72]));
    }
    // A few rib stubs sticking out of the hole.
    for (let k = 0; k < 4; k++) {
      const s = 0.33 + k * 0.045;
      const pts = [];
      for (let j = 0; j <= 5; j++) {
        const a = -1 + j * 0.06;
        hullPoint(s, a, _v);
        _v.x *= 0.96;
        pts.push(_v.clone());
      }
      wood.push(tint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 6, 0.065, 4, false), [0.8, 0.75, 0.68]));
    }
    // Rub rails along the sheer.
    for (const side of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 20; i++) {
        const s = 0.01 + (i / 20) * 0.97;
        hullPoint(s, side, _v);
        _v.y += 0.04;
        _v.x += side * 0.04;
        pts.push(_v.clone());
      }
      const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.08, 5, false);
      wood.push(tint(g, [0.8, 0.8, 0.76]));
    }

    // ---------------- Deck (partly collapsed) ----------------
    const deckY = -0.18;
    const plankW = 0.22;
    for (let x = -HB + 0.2; x <= HB - 0.2; x += plankW) {
      let s0 = 0.04;
      while (s0 < 0.84) {
        const len = 0.06 + rand() * 0.18;
        const s1 = Math.min(0.84, s0 + len);
        const sm = (s0 + s1) / 2;
        const collapse = Math.abs(x + 0.4) < 1.1 && sm > 0.36 && sm < 0.56; // caved-in hold
        if (!collapse && rand() > 0.12 && Math.abs(x) < beamAt(s1) - 0.12 && Math.abs(x) < beamAt(s0) - 0.12) {
          const z0 = (s0 - 0.5) * L;
          const z1 = (s1 - 0.5) * L;
          const g = woodBox(plankW * 0.94, 0.05, z1 - z0);
          const droop = rand() < 0.15 ? (rand() - 0.5) * 0.25 : 0;
          g.rotateX(droop);
          g.translate(x, deckY + sheerAt(sm) * 0.9, (z0 + z1) / 2);
          wood.push(tint(g, [0.95, 0.92, 0.85]));
        }
        s0 = s1 + (rand() < 0.1 ? 0.03 : 0.002);
      }
    }
    // Deck beams visible in the collapsed hold.
    for (let k = 0; k < 4; k++) {
      const s = 0.37 + k * 0.055;
      const z = (s - 0.5) * L;
      const g = woodBox(beamAt(s) * 1.9, 0.16, 0.16, false);
      g.translate(0, deckY - 0.12 + sheerAt(s) * 0.9, z);
      if (k === 2) g.rotateZ(0.2);
      wood.push(tint(g, [0.8, 0.76, 0.7]));
    }

    // ---------------- Wheelhouse ----------------
    {
      const z0 = (0.09 - 0.5) * L;
      const z1 = (0.29 - 0.5) * L;
      const zl = z1 - z0;
      const zc = (z0 + z1) / 2;
      const hw = 1.45;
      const h = 2.0;
      const y0 = deckY + 0.05 + 0.1;
      const t = 0.08;
      const c = [1.7, 1.8, 1.85]; // faded white paint over wood
      const addBox = (w2, h2, d2, x, y, z, alongZ = true, col = c) => {
        const g = woodBox(w2, h2, d2, alongZ);
        g.translate(x, y, z);
        wood.push(tint(g, col));
      };
      // Front wall (toward the bow) with three windows.
      const winY0 = 1.0;
      const winY1 = 1.65;
      addBox(hw * 2, winY0, t, 0, y0 + winY0 / 2, z1, false);
      addBox(hw * 2, h - winY1, t, 0, y0 + (winY1 + h) / 2, z1, false);
      for (const px of [-hw + 0.06, -0.5, 0.5, hw - 0.06]) addBox(0.14, winY1 - winY0, t, px, y0 + (winY0 + winY1) / 2, z1, false);
      // Back wall with a door gap.
      addBox(hw * 2 - 0.9, h, t, 0.45, y0 + h / 2, z0, false);
      addBox(0.9, 0.35, t, -hw + 0.45, y0 + h - 0.175, z0, false);
      // Side walls with one window each.
      for (const sx of [-hw, hw]) {
        addBox(t, winY0, zl, sx, y0 + winY0 / 2, zc);
        addBox(t, h - winY1, zl, sx, y0 + (winY1 + h) / 2, zc);
        addBox(t, winY1 - winY0, zl * 0.35, sx, y0 + (winY0 + winY1) / 2, z0 + zl * 0.175);
        addBox(t, winY1 - winY0, zl * 0.25, sx, y0 + (winY0 + winY1) / 2, z1 - zl * 0.125);
      }
      // Roof: slumped, one corner collapsed.
      const roof = woodBox(hw * 2 + 0.3, 0.1, zl + 0.4);
      roof.rotateZ(-0.16);
      roof.rotateX(0.07);
      roof.translate(-0.1, y0 + h - 0.12, zc);
      wood.push(tint(roof, [1.55, 1.6, 1.6]));
      // Wheel post + a couple of fish crates on deck.
      const post = new THREE.CylinderGeometry(0.06, 0.06, 1.0, 6);
      post.translate(0.3, y0 + 0.5, z1 - 0.5);
      props.push(tint(post, [0.35, 0.3, 0.25]));
      const wheel = new THREE.TorusGeometry(0.32, 0.035, 5, 14);
      wheel.rotateX(0.4);
      wheel.translate(0.3, y0 + 1.05, z1 - 0.45);
      props.push(tint(wheel, [0.4, 0.33, 0.25]));
    }
    // Fish crates: on the foredeck and spilled on the sand.
    const crate = (x, y, z, ry, rz) => {
      const g = woodBox(0.7, 0.32, 0.45, false);
      g.rotateZ(rz);
      g.rotateY(ry);
      g.translate(x, y, z);
      wood.push(tint(g, [0.8, 0.72, 0.6]));
    };
    crate(0.6, deckY + 0.35, 2.6, 0.3, 0);
    crate(0.5, deckY + 0.67, 2.65, 0.1, 0.05);
    crate(-0.9, deckY + 0.3, 3.6, -0.4, 0.2);

    // ---------------- Mast (snapped) ----------------
    const mastZ = (0.6 - 0.5) * L;
    const mastBaseY = deckY + sheerAt(0.6) * 0.9;
    {
      const h = 3.3;
      const g = new THREE.CylinderGeometry(0.11, 0.14, h, 8, 6, true);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y > h / 2 - 0.01) pos.setY(i, y + (rand() - 0.3) * 0.45); // jagged break
      }
      g.computeVertexNormals();
      g.translate(0, mastBaseY + h / 2, mastZ);
      wood.push(tint(g, [0.85, 0.8, 0.72]));
    }
    // The broken upper mast, lying from the deck across the port gunwale onto the sand.
    const mastTop = new THREE.Vector3(0, mastBaseY + 3.3, mastZ);
    {
      const a = new THREE.Vector3(-0.4, mastBaseY + 0.4, mastZ + 1.2);
      toWorld(a);
      const dirW = new THREE.Vector3(-1, 0, 0.35).transformDirection(this.group.matrixWorld);
      dirW.y = 0;
      dirW.normalize();
      const b = a.clone().addScaledVector(dirW, 5.6);
      b.y = hf.heightAt(b.x, b.z) + 0.1;
      toLocal(a);
      toLocal(b);
      const len = a.distanceTo(b);
      const g = new THREE.CylinderGeometry(0.1, 0.12, len, 8, 1, true);
      g.translate(0, len / 2, 0);
      const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), _w.subVectors(b, a).normalize());
      g.applyQuaternion(quat);
      g.translate(a.x, a.y, a.z);
      wood.push(tint(g, [0.82, 0.78, 0.7]));
      // Cross spar still attached to the fallen piece.
      const spar = new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6, 1, true);
      spar.rotateZ(Math.PI / 2 - 0.3);
      const mid = a.clone().lerp(b, 0.6);
      spar.applyQuaternion(quat);
      spar.translate(mid.x, mid.y, mid.z);
      wood.push(tint(spar, [0.8, 0.76, 0.68]));
      this._fallenMastEnd = b.clone();
    }

    // ---------------- Ropes ----------------
    const gun = (s, side) => hullPoint(s, side, new THREE.Vector3()).add(new THREE.Vector3(side * 0.05, 0.05, 0));
    props.push(rope(mastTop, gun(0.82, 1), 0.35));
    props.push(rope(mastTop, gun(0.45, 1), 0.3));
    props.push(rope(mastTop.clone().add(new THREE.Vector3(0, -0.4, 0)), gun(0.3, -1), 0.6));
    // Loose lines trailing from the stern onto the sand.
    for (let k = 0; k < 3; k++) {
      const a = gun(0.03 + k * 0.03, k === 1 ? 1 : -1);
      const pts = [a.clone()];
      const aw = toWorld(a.clone());
      for (let i = 1; i <= 6; i++) {
        const p = aw.clone().add(new THREE.Vector3(Math.sin(k * 2 + i * 0.6) * i * 0.6 - i * 0.5, 0, Math.cos(k + i * 0.5) * i * 0.7 + i * 0.3));
        p.y = Math.max(hf.heightAt(p.x, p.z) + 0.04, aw.y - i * 0.7);
        pts.push(toLocal(p));
      }
      props.push(tube(pts, 0.022, 30, 4, [0.4, 0.38, 0.3]));
    }
    // Float line: a buoy still tugging upward from the bow, swaying slightly.
    {
      const a = gun(0.93, -1);
      const aw = toWorld(a.clone());
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const p = aw.clone().add(new THREE.Vector3(Math.sin(t * 2.2) * 0.6, t * 8.5, t * 0.8));
        pts.push(toLocal(p));
      }
      props.push(tube(pts, 0.02, 24, 4, [0.45, 0.42, 0.34]));
      const buoy = new THREE.SphereGeometry(0.32, 12, 9);
      buoy.scale(1, 1.15, 1);
      const top = pts[pts.length - 1];
      buoy.translate(top.x, top.y + 0.3, top.z);
      props.push(tint(buoy, [0.75, 0.42, 0.22]));
    }

    // ---------------- Tyre fenders on the port side ----------------
    for (let k = 0; k < 4; k++) {
      const s = 0.22 + k * 0.17;
      const p = hullPoint(s, -0.93, new THREE.Vector3());
      const g = new THREE.TorusGeometry(0.34, 0.13, 6, 14);
      g.rotateY(Math.PI / 2 + (rand() - 0.5) * 0.3);
      g.rotateX((rand() - 0.5) * 0.3);
      g.translate(p.x - 0.18, p.y - 0.35, p.z);
      props.push(tint(g, [0.13, 0.13, 0.13]));
      props.push(rope(gun(s, -1), new THREE.Vector3(p.x - 0.18, p.y - 0.02, p.z), 0.02, 0.018));
    }

    // ---------------- Anchor + chain off the bow ----------------
    {
      const bowW = toWorld(gun(0.97, -1));
      const fwd = new THREE.Vector3(0, 0, 1).transformDirection(this.group.matrixWorld);
      fwd.y = 0;
      fwd.normalize();
      const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const anchorW = bowW.clone().addScaledVector(fwd, 3.2).addScaledVector(side, -1.6);
      anchorW.y = hf.heightAt(anchorW.x, anchorW.z) + 0.15;
      const rust = [0.42, 0.27, 0.18];
      const anchor = [];
      const shank = new THREE.CylinderGeometry(0.06, 0.07, 1.6, 6);
      shank.rotateZ(Math.PI / 2);
      anchor.push(shank);
      const stock = new THREE.CylinderGeometry(0.04, 0.04, 1.3, 6);
      stock.rotateX(Math.PI / 2);
      stock.translate(0.75, 0, 0);
      anchor.push(stock);
      for (const sgn of [-1, 1]) {
        const arm = new THREE.CylinderGeometry(0.05, 0.06, 0.8, 6);
        arm.rotateZ(sgn * 0.9);
        arm.translate(-0.75, sgn * 0.3, 0);
        anchor.push(arm);
        const fluke = new THREE.ConeGeometry(0.16, 0.36, 4);
        fluke.scale(1, 1, 0.35);
        fluke.rotateZ(sgn * 0.9 + (sgn > 0 ? 0 : Math.PI));
        fluke.translate(-0.42, sgn * 0.62, 0);
        anchor.push(fluke);
      }
      const ring = new THREE.TorusGeometry(0.12, 0.03, 5, 10);
      ring.translate(0.86, 0, 0);
      anchor.push(ring);
      const anchorGeo = mergeGeometries(anchor.map((g) => conform(g, ['position', 'normal'])));
      anchorGeo.rotateX(Math.PI / 2 - 0.25); // lying on its side, one fluke dug in
      anchorGeo.rotateY(rand() * Math.PI);
      const aLocal = toLocal(anchorW.clone());
      const rotInv = new THREE.Quaternion().setFromRotationMatrix(inv);
      anchorGeo.applyQuaternion(rotInv);
      anchorGeo.translate(aLocal.x, aLocal.y, aLocal.z);
      props.push(tint(anchorGeo, rust));
      // Chain from the bow hawse down to the anchor ring.
      const links = q === 'low' ? 22 : 40;
      const start = bowW.clone();
      const end = anchorW.clone();
      for (let i = 0; i < links; i++) {
        const t = i / (links - 1);
        const p = new THREE.Vector3().lerpVectors(start, end, t);
        p.y -= Math.sin(t * Math.PI) * 0.8;
        p.y = Math.max(p.y, hf.heightAt(p.x, p.z) + 0.04);
        const next = new THREE.Vector3().lerpVectors(start, end, Math.min(1, t + 0.02));
        const link = new THREE.TorusGeometry(0.07, 0.022, 4, 8);
        link.scale(1.5, 1, 1);
        if (i % 2) link.rotateX(Math.PI / 2);
        const dir = next.sub(p).normalize();
        link.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir));
        const pl = toLocal(p.clone());
        link.applyQuaternion(rotInv);
        link.translate(pl.x, pl.y, pl.z);
        props.push(tint(link, [0.32, 0.22, 0.16]));
      }
    }
    // A crate and a float spilled on the sand near the stern.
    {
      const pW = toWorld(gun(0.1, -1)).add(new THREE.Vector3(-2.5, 0, 1.5));
      pW.y = hf.heightAt(pW.x, pW.z) + 0.1;
      const pl = toLocal(pW.clone());
      crate(pl.x, pl.y, pl.z, 0.7, 0.35);
    }

    // ---------------- Merge ----------------
    const woodGeo = mergeGeometries(wood.map((g) => conform(g, ['position', 'normal', 'uv', 'color'])));
    const propGeo = mergeGeometries(props.map((g) => conform(g, ['position', 'normal', 'color'])));

    const woodMat = new THREE.MeshStandardMaterial({
      map: tex.wood.albedo,
      normalMap: tex.wood.normal,
      normalScale: new THREE.Vector2(1.2, 1.2),
      roughness: 0.92,
      metalness: 0,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    const siltUniforms = { uSandAlb: { value: tex.sand.albedo }, uVarTex: { value: tex.variation } };
    woodMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, siltUniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uSandAlb;\nuniform sampler2D uVarTex;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
{
  // Years on the bottom: silt on everything facing up, algal film, dark stains low down.
  vec3 wkN = normalize( ( vec4( normalize( vNormal ) * ( gl_FrontFacing ? 1.0 : -1.0 ), 0.0 ) * viewMatrix ).xyz );
  vec4 wkVar = texture2D( uVarTex, vEnvWorldPos.xz / 9.0 + vEnvWorldPos.y / 13.0 );
  float wkSilt = smoothstep( 0.35, 0.85, wkN.y + ( wkVar.b - 0.5 ) * 0.6 );
  vec3 wkSand = texture2D( uSandAlb, vEnvWorldPos.xz / 3.0 ).rgb * 0.8;
  diffuseColor.rgb = mix( diffuseColor.rgb * mix( vec3( 1.0 ), vec3( 0.62, 0.7, 0.55 ), smoothstep( 0.45, 0.8, wkVar.g ) * 0.7 ), wkSand, wkSilt * 0.8 );
  diffuseColor.rgb *= 0.75 + 0.35 * wkVar.r;
}`,
        );
      env.patchShader(shader, { causticScale: 1.0 });
    };
    woodMat.customProgramCacheKey = () => `wreck-wood|${env.quality}`;

    const propMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.15, vertexColors: true });
    env.patchMaterial(propMat);

    this.woodMesh = new THREE.Mesh(woodGeo, woodMat);
    this.propMesh = new THREE.Mesh(propGeo, propMat);
    for (const m of [this.woodMesh, this.propMesh]) {
      m.castShadow = q !== 'low';
      m.receiveShadow = true;
      this.group.add(m);
    }
    this.woodMesh.name = 'wreck-wood';
    this.propMesh.name = 'wreck-props';
    // Own shadow-depth material: three's shared one re-picks its program only
    // when the caster kind changes (plain / instanced / skinned) and bakes in
    // the map and side of whichever caster triggered that, so on a frame where
    // the textured, double-sided hull happened to be first, a new depth
    // variant would compile mid-fight. This one only ever sees the hull and
    // compiles in the warm-up frame (Environment draws the whole wreck there).
    this.woodMesh.customDepthMaterial = new THREE.MeshDepthMaterial();

    // ---------------- Net spilling over the port side ----------------
    {
      const np = q === 'low' ? 20 : 34;
      const nq = q === 'low' ? 10 : 16;
      const outW = new THREE.Vector3(-1, 0, 0).transformDirection(this.group.matrixWorld);
      outW.y = 0;
      outW.normalize();
      const along = new THREE.Vector3(0, 0, 1).transformDirection(this.group.matrixWorld);
      const netLen = 7.5;
      const geo = gridGeometry(np, nq, (u, v) => {
        const s = 0.24 + u * 0.48;
        const g = toWorld(gun(s, -1));
        const reach = v * (3.8 + Math.sin(u * 5.0) * 1.0);
        const p = g.clone().addScaledVector(outW, reach + 0.1);
        p.addScaledVector(along, Math.sin(v * 3 + u * 2) * 0.4 * v);
        const ground = hf.heightAt(p.x, p.z);
        const drop = smoothstep(0, 0.55, v);
        p.y = THREE.MathUtils.lerp(g.y, ground + 0.06, drop);
        // folds and lumps
        p.y += Math.max(0, Math.sin(u * 23 + v * 4) * 0.18 + Math.sin(u * 9 - v * 7) * 0.12) * smoothstep(0.4, 1, v);
        p.y = Math.max(p.y, ground + 0.05);
        toLocal(p);
        return [p.x, p.y, p.z, u * netLen, v * 4.5, 1, 1, 1];
      });
      conform(geo, ['position', 'normal', 'uv']);
      const netMat = new THREE.MeshStandardMaterial({
        map: tex.net,
        alphaTest: 0.45,
        side: THREE.DoubleSide,
        roughness: 0.9,
        color: 0xb8b4a0,
      });
      env.patchMaterial(netMat, { causticScale: 0.8 });
      this.netMesh = new THREE.Mesh(geo, netMat);
      this.netMesh.castShadow = q !== 'low';
      this.netMesh.receiveShadow = q === 'high';
      this.netMesh.name = 'wreck-net';
      this.group.add(this.netMesh);
    }

    // ---------------- Faded registration 「东海渔 3127」 on the port bow ----------------
    this.decal = this._makeNameDecal(env);
    if (this.decal) this.group.add(this.decal);

    this.group.updateMatrixWorld(true);
    // Useful anchor points for cameras / AI (world space).
    this.center = new THREE.Vector3();
    new THREE.Box3().setFromObject(this.woodMesh).getCenter(this.center);
  }

  _makeNameDecal(env) {
    if (typeof document === 'undefined') return null;
    const cw = 512;
    const ch = 128;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = 'rgba(235,232,220,1)';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 84px "Noto Sans CJK SC","WenQuanYi Zen Hei","PingFang SC","Microsoft YaHei","SimHei",sans-serif';
    ctx.fillText('东海渔 3127', 16, ch / 2 + 4);
    // Erode the paint: punch random flakes and streaks out of it.
    const rand = mulberry32(88);
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 520; i++) {
      ctx.globalAlpha = 0.25 + rand() * 0.6;
      const x = rand() * cw;
      const y = rand() * ch;
      const r = 1 + rand() * rand() * 7;
      ctx.beginPath();
      ctx.ellipse(x, y, r * (1 + rand() * 2), r, rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 40; i++) {
      const x = rand() * cw;
      ctx.fillRect(x, rand() * ch * 0.5, 2 + rand() * 4, ch);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;

    // Patch of the hull surface itself, nudged outward, so it hugs the curve.
    const s0 = 0.66;
    const s1 = 0.86;
    const a0 = -0.96;
    const a1 = -0.8;
    const geo = gridGeometry(12, 3, (u, v) => {
      const s = THREE.MathUtils.lerp(s0, s1, u);
      const a = THREE.MathUtils.lerp(a1, a0, v);
      hullPoint(s, a, _v);
      const off = new THREE.Vector3(-0.025, 0, 0);
      return [_v.x + off.x, _v.y, _v.z, u, v, 1, 1, 1];
    });
    conform(geo, ['position', 'normal', 'uv']);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      roughness: 0.9,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      opacity: 0.8,
    });
    env.patchMaterial(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'wreck-name';
    mesh.renderOrder = 1;
    return mesh;
  }
}
