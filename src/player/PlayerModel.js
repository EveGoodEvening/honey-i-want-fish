// Procedural model of 老公: a lean, hard, middle-aged man (~1.75 m) in a worn,
// open charcoal-navy work jacket over a dark grey shirt, dark trousers and
// black cloth shoes, holding a long fish-gutting knife in his right fist.
//
// Everything is lofted from smooth superellipse sections and skinned to one
// shared Skeleton (see rig.js for the joint layout). Rigid parts (head, eyes,
// shoes, knife) hang directly off their bones.
//
// Model space: feet at y = 0, faces +Z, +X = character's left.
import * as THREE from 'three';
import {
  BONE_DEFS,
  BONE_INDEX,
  bindPos,
  ARM_DIR_R,
  ARM_DIR_L,
  HAND_R,
  HAND_L,
  HEM_Y,
  HEM_BONES,
  LAPEL_Y,
  GRIP_OFFSET_R,
  KNIFE_DIR_BIND,
  KNIFE_EDGE_BIND,
  UPPER_ARM_LEN,
  FOREARM_LEN,
  BODY_CENTER_Y,
} from './rig.js';
import { buildLoft, pathRings, mergeParts } from './loft.js';
import { buildHeadGeometry, buildEyesGeometry, makeEyeTexture, makeHeadTextures, paintHeadTextures, HEAD_ORIGIN, HEAD_TEX_SIZE } from './head.js';
import { buildKnife } from './Knife.js';
import { makeFabric, paintFabric, makeUnderwaterEnvMap } from './textures.js';
import { smoothstep, sampleScalar, gauss, fbm3, quatFromBasis, TAU } from './math.js';

const B = BONE_INDEX;

// Knife edge glint: share of the water fill light and of the sun it reflects.
const GLINT_FILL = 0.3;
const GLINT_SUN = 0.06;

// Cloth textures (see textures.makeFabric). The model is built with BOOT_TEX
// textures; medium/high repaint everything at full size in idle time.
const FABRIC = {
  jacket: { threads: 64, kind: 'twill', seed: 3, wear: 0.85, strength: 2.4 },
  trousers: { threads: 80, kind: 'twill', seed: 7, wear: 0.55, strength: 2.0 },
  shirt: { threads: 72, kind: 'jersey', seed: 11, wear: 0.4, strength: 1.6 },
};
const BOOT_TEX = 256;

// Image-based light on skin and cloth. The PMREM "underwater sky" is static
// (Snell's window as seen just below the surface); on these rough materials
// it mostly acts as diffuse fill, so untinted it gave 老公 surface-white,
// unabsorbed light at any depth: pale, flat skin and a cream "glove" hand next
// to sharks lit by the absorbed water light. It is tinted every frame by the
// water fill around the camera relative to its value just below the surface;
// IBL_KEEP of it stays as a depth-compensated neutral fill so skin still reads
// as skin.
const IBL_REF = [0.9, 2.7, 2.8]; // hemisphere fill colour just below the surface
const IBL_KEEP = 0.25;
const iblGain = (c, ref) => Math.min(1.5, IBL_KEEP + (1 - IBL_KEEP) * (c / ref));

// Share of a curled finger's wrap taken by the proximal / middle / distal phalanx.
const PHALANX_SHARE = [0.45, 0.3, 0.25];

// ---------------------------------------------------------------------------
// Torso profile (the body surface under the jacket = shirt surface)
// [y, cz, rx, rFront, rBack, exponent]
// ---------------------------------------------------------------------------
const TORSO = [
  [0.86, 0.0, 0.158, 0.1, 0.113, 2.3],
  [0.94, 0.0, 0.157, 0.098, 0.113, 2.3],
  [1.0, 0.003, 0.151, 0.097, 0.105, 2.3],
  [1.06, 0.006, 0.148, 0.099, 0.098, 2.3],
  [1.13, 0.008, 0.152, 0.104, 0.098, 2.35],
  [1.2, 0.01, 0.159, 0.111, 0.1, 2.4],
  [1.27, 0.012, 0.167, 0.117, 0.104, 2.5],
  [1.34, 0.01, 0.174, 0.114, 0.107, 2.6],
  [1.395, 0.002, 0.178, 0.1, 0.104, 2.7],
  [1.43, -0.008, 0.17, 0.084, 0.092, 2.6],
  [1.455, -0.016, 0.122, 0.068, 0.076, 2.4],
  [1.478, -0.022, 0.08, 0.06, 0.066, 2.2],
  [1.5, -0.024, 0.07, 0.059, 0.064, 2.2],
];
const colOf = (tbl, c) => tbl.map((r) => [r[0], r[c]]);
const T_CZ = colOf(TORSO, 1);
const T_RX = colOf(TORSO, 2);
const T_RF = colOf(TORSO, 3);
const T_RB = colOf(TORSO, 4);
const T_E = colOf(TORSO, 5);

function torsoAt(y) {
  return {
    cz: sampleScalar(T_CZ, y),
    rx: sampleScalar(T_RX, y),
    rf: sampleScalar(T_RF, y),
    rb: sampleScalar(T_RB, y),
    e: sampleScalar(T_E, y),
  };
}

// The neckline tilts: low at the sternal notch, high at the nape.
const neckTilt = (y) => 0.45 * smoothstep(1.37, 1.48, y);

function torsoRing(y, inflate, flare) {
  const t = torsoAt(y);
  const tilt = neckTilt(y);
  const az = new THREE.Vector3(0, -tilt, 1).normalize();
  return {
    c: new THREE.Vector3(0, y, t.cz),
    ax: new THREE.Vector3(1, 0, 0),
    az,
    rx: t.rx + inflate + flare,
    rzf: t.rf + inflate + flare * 0.6,
    rzb: t.rb + inflate + flare,
    e: t.e,
    y,
  };
}

// Jacket front opening half-angle by height (wide lapel V at the top).
const OPEN = [
  [0.78, 0.46],
  [1.0, 0.42],
  [1.18, 0.4],
  [1.28, 0.46],
  [1.36, 0.62],
  [1.42, 0.86],
  [1.48, 1.05],
];
const openAt = (y) => sampleScalar(OPEN, y);
const JACKET_INFLATE = 0.019;
const jacketFlare = (y) => Math.max(0, 1.0 - y) * 0.05;

/** Raised rounded-rectangle patch in (θ, y): pockets and flaps. */
function patch(th, y, c0, y0, hw, hh, height) {
  const dx = Math.abs(th - c0) / hw;
  const dy = Math.abs(y - y0) / hh;
  const d = Math.max(dx, dy);
  return height * smoothstep(1.0, 0.86, d);
}

function jacketBump(th, y) {
  const a = Math.abs(th);
  let b = 0;
  // rolled lapels: the open edges near the top turn outward
  const edge = a - openAt(y);
  b += 0.012 * smoothstep(0.35, 0.0, edge) * smoothstep(1.2, 1.44, y);
  // chest pockets with flaps
  for (const s of [1, -1]) {
    b += patch(th, y, s * 0.78, 1.25, 0.2, 0.055, 0.0035);
    b += patch(th, y, s * 0.78, 1.3, 0.21, 0.016, 0.0028); // flap
    b += patch(th, y, s * 1.02, 0.905, 0.24, 0.06, 0.003); // lower pockets
  }
  // shoulder blades / back yoke
  b += 0.006 * gauss(a, 2.65, 0.4) * gauss(y, 1.33, 0.055);
  // soft wrinkles: horizontal folds at the waist, diagonal pulls at the back
  b += 0.0028 * fbm3(th * 1.6, y * 22, 3.3, 2) * (0.6 + 0.4 * gauss(y, 1.05, 0.08));
  b += 0.0016 * Math.sin(y * 210 + th * 2.2) * gauss(y, 1.06, 0.05) * gauss(a, 1.6, 0.9);
  // stitched seams (tiny grooves): side seams, back centre, yoke line
  b -= 0.0012 * gauss(a, 1.62, 0.025);
  b -= 0.0009 * gauss(a, Math.PI, 0.02) * smoothstep(1.4, 1.3, y);
  b -= 0.001 * gauss(y, 1.385, 0.004) * smoothstep(1.6, 2.2, a);
  // hem band
  b += 0.0018 * smoothstep(0.83, 0.8, y);
  return b;
}

// Hem bones sorted by angle for interpolation.
const HEM_SORTED = [...HEM_BONES].sort((a, b) => a[1] - b[1]);

function hemBonePair(phi) {
  // phi in [-π, π]; returns [boneA, boneB, f]
  const list = HEM_SORTED;
  const n = list.length;
  if (phi <= list[0][1]) {
    // between last (wrapped) and first
    const a = list[n - 1];
    const b = list[0];
    const span = b[1] + TAU - a[1];
    const f = (phi + TAU - a[1]) / span;
    return [a[0], b[0], f];
  }
  for (let i = 0; i < n - 1; i++) {
    if (phi <= list[i + 1][1]) {
      const f = (phi - list[i][1]) / (list[i + 1][1] - list[i][1]);
      return [list[i][0], list[i + 1][0], f];
    }
  }
  const a = list[n - 1];
  const b = list[0];
  const span = b[1] + TAU - a[1];
  return [a[0], b[0], (phi - a[1]) / span];
}

/** Spine-chain + shoulder weights for torso-shaped clothing. */
function torsoWeights(p, acc, { cloth = false, th = 0 } = {}) {
  const y = p.y;
  const ax = Math.abs(p.x);
  const left = p.x >= 0;
  let wPel = smoothstep(1.07, 0.95, y);
  let wChest = smoothstep(1.15, 1.29, y);
  let wSpine = Math.max(0, 1 - wPel - wChest);
  // shoulders hand off to clavicle / upper arm
  const sh = smoothstep(1.3, 1.42, y) * smoothstep(0.08, 0.165, ax);
  const ua = smoothstep(1.34, 1.44, y) * smoothstep(0.15, 0.205, ax);
  const wClav = sh * 0.5 * (1 - ua);
  const wUA = ua * 0.55;
  const keep = Math.max(0, 1 - wClav - wUA);
  wChest *= keep;
  wSpine *= keep;
  const wNeck = smoothstep(1.45, 1.5, y) * 0.35;
  wChest *= 1 - wNeck;

  let clothW = 0;
  let hemA = 0;
  let hemB = 0;
  let hemF = 0;
  let lapW = 0;
  if (cloth) {
    // lower jacket swings on the hem bones
    clothW = smoothstep(1.06, 0.83, y) * 0.92;
    [hemA, hemB, hemF] = hemBonePair(th);
    // front panel edges near the opening flutter on the lapel bones
    const edgeDist = Math.abs(th) - openAt(y); // angular distance from the opening edge
    lapW = smoothstep(0.6, 0.0, edgeDist) * smoothstep(1.47, 1.34, y) * smoothstep(1.02, 1.2, y) * 0.55;
  }
  const rest = (1 - clothW) * (1 - lapW);
  acc.add(B.pelvis, wPel * rest);
  acc.add(B.spine, wSpine * rest);
  acc.add(B.chest, wChest * rest);
  acc.add(B.neck, wNeck * rest);
  acc.add(left ? B.clavL : B.clavR, wClav * rest);
  acc.add(left ? B.upperArmL : B.upperArmR, wUA * rest);
  if (clothW > 0) {
    acc.add(B[hemA], clothW * (1 - hemF) * (1 - lapW));
    acc.add(B[hemB], clothW * hemF * (1 - lapW));
  }
  if (lapW > 0) acc.add(left ? B.lapelL : B.lapelR, lapW);
}

// ---------------------------------------------------------------------------

export class PlayerModel {
  constructor(game) {
    this.game = game;
    const quality = game.quality ?? 'high';
    this.quality = quality;
    const env = game.env;
    this._patch = (m) => {
      try {
        return env?.patchMaterial?.(m) ?? m;
      } catch (err) {
        console.warn('[Player] env.patchMaterial failed', err);
        return m;
      }
    };
    this.root = new THREE.Group();
    this.root.name = 'player-model';

    this.seg = quality === 'low' ? 14 : quality === 'medium' ? 20 : 26;
    this.texSize = quality === 'low' ? 256 : 512;
    this._iblTint = { value: new THREE.Color(1, 1, 1) };

    this._placeClothBones();
    this._buildSkeleton();
    this._buildMaterials();
    this._buildSkinnedParts();
    this._buildRigidParts();

    this.root.position.y = -BODY_CENTER_Y;

    // full-resolution cloth + head textures, painted in idle time
    this._upgrade = null;
    if (this.texSize > BOOT_TEX || (HEAD_TEX_SIZE[quality] ?? BOOT_TEX) > BOOT_TEX) {
      this._upgrade = this._textureUpgrade();
      this._scheduleUpgrade();
    }
  }

  /**
   * Per frame: tints the image-based light on skin and cloth by the water
   * light around the camera (see IBL_REF). Cheap: one colour write.
   */
  updateLight() {
    const fill = this.game.env?.hemi?.color;
    const t = this._iblTint.value;
    if (!fill) {
      t.setRGB(1, 1, 1);
      return;
    }
    t.setRGB(iblGain(fill.r, IBL_REF[0]), iblGain(fill.g, IBL_REF[1]), iblGain(fill.b, IBL_REF[2]));
  }

  /** Makes `material`'s IBL (diffuse fill + reflections) follow _iblTint. */
  _tintIbl(material) {
    const tint = this._iblTint;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = function onBeforeCompile(shader, renderer) {
      prev?.call(this, shader, renderer);
      shader.uniforms.uPlayerIbl = tint;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uPlayerIbl;')
        .replace(
          '#include <lights_fragment_maps>',
          `#include <lights_fragment_maps>
#if defined( RE_IndirectDiffuse )
  iblIrradiance *= uPlayerIbl;
#endif
#if defined( RE_IndirectSpecular )
  radiance *= uPlayerIbl;
  clearcoatRadiance *= uPlayerIbl;
#endif`,
        );
    };
    const prevKey = material.customProgramCacheKey;
    material.customProgramCacheKey = function customProgramCacheKey() {
      return `${prevKey ? prevKey.call(this) : ''}|playerIbl`;
    };
    return material;
  }

  /** True once the full-resolution textures are in place. */
  get texturesFinal() {
    return !this._upgrade;
  }

  /** Finishes the idle-time texture upgrade synchronously (tests, screenshots). */
  finishTextureUpgrade() {
    try {
      const gen = this._upgrade;
      let r = gen?.next();
      while (r && !r.done) r = gen.next();
    } catch (err) {
      console.warn('[Player] texture upgrade failed', err);
    }
    this._upgrade = null;
  }

  _scheduleUpgrade() {
    if (typeof requestIdleCallback === 'function') requestIdleCallback((d) => this._pumpUpgrade(d), { timeout: 250 });
    else setTimeout(() => this._pumpUpgrade(null), 16);
  }

  _pumpUpgrade(deadline) {
    const gen = this._upgrade;
    if (!gen) return;
    const t0 = performance.now();
    // the browser's idle budget when it has one, else a small fixed slice
    const budget = deadline && !deadline.didTimeout ? Math.max(1, Math.min(8, deadline.timeRemaining() - 1)) : 4;
    try {
      while (performance.now() - t0 < budget) {
        if (gen.next().done) {
          this._upgrade = null;
          return;
        }
      }
    } catch (err) {
      console.warn('[Player] texture upgrade failed', err);
      this._upgrade = null;
      return;
    }
    this._scheduleUpgrade();
  }

  /** Paints the full-size textures in slices, uploads them, then swaps them in. */
  *_textureUpgrade() {
    const fab = {};
    for (const k of ['jacket', 'trousers', 'shirt']) fab[k] = yield* paintFabric(this.texSize, FABRIC[k]);
    const head = yield* paintHeadTextures(HEAD_TEX_SIZE[this.quality] ?? BOOT_TEX);
    const fresh = [head.map, head.bumpMap, head.roughnessMap];
    for (const f of Object.values(fab)) fresh.push(f.map, f.normalMap, f.roughnessMap);
    for (const tex of fresh) {
      try {
        this.game.renderer?.initTexture?.(tex); // upload now, not on the next frame
      } catch {
        /* no GL: uploaded at first use */
      }
      yield;
    }
    // Same kinds of maps as before, so no shader recompiles: just swap.
    const m = this.materials;
    const old = new Set();
    const swap = (mat, key, tex) => {
      if (!mat || mat[key] === tex) return;
      if (mat[key]) old.add(mat[key]);
      mat[key] = tex;
    };
    for (const k of ['jacket', 'trousers', 'shirt']) {
      swap(m[k], 'map', fab[k].map);
      swap(m[k], 'normalMap', fab[k].normalMap);
      swap(m[k], 'roughnessMap', fab[k].roughnessMap);
    }
    swap(m.shoes, 'normalMap', fab.trousers.normalMap);
    swap(m.head, 'map', head.map);
    swap(m.head, 'bumpMap', head.bumpMap);
    swap(m.head, 'roughnessMap', head.roughnessMap);
    swap(m.head, 'aoMap', head.roughnessMap);
    for (const tex of old) tex.dispose();
  }

  bone(name) {
    return this.bones[B[name]];
  }

  // -------------------------------------------------------------------------
  _placeClothBones() {
    for (const [name, phi] of HEM_BONES) {
      const r = torsoRing(HEM_Y, JACKET_INFLATE, jacketFlare(HEM_Y));
      const s = Math.sin(phi);
      const c = Math.cos(phi);
      const p = bindPos(name);
      p.set(r.rx * s * 0.85, HEM_Y, r.c.z + (c >= 0 ? r.rzf : r.rzb) * c * 0.85);
    }
    for (const [name, side] of [['lapelL', 1], ['lapelR', -1]]) {
      const r = torsoRing(LAPEL_Y, JACKET_INFLATE, 0);
      const phi = side * (openAt(LAPEL_Y) + 0.15);
      bindPos(name).set(r.rx * Math.sin(phi), LAPEL_Y, r.c.z + r.rzf * Math.cos(phi));
    }
  }

  _buildSkeleton() {
    this.bones = [];
    for (const [name, parent, pos] of BONE_DEFS) {
      const b = new THREE.Bone();
      b.name = name;
      b.position.copy(pos);
      if (parent) {
        b.position.sub(bindPos(parent));
        this.bones[B[parent]].add(b);
      } else {
        this.root.add(b);
      }
      this.bones.push(b);
    }
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this.bones);
  }

  _buildMaterials() {
    // Built with small textures; medium/high repaint them at full size in idle
    // time (see _textureUpgrade) so the constructor stays cheap at boot.
    const t = BOOT_TEX;
    const jacketTex = makeFabric(t, FABRIC.jacket);
    const trouserTex = makeFabric(t, FABRIC.trousers);
    const shirtTex = makeFabric(t, FABRIC.shirt);
    this.envMap = makeUnderwaterEnvMap(this.game.renderer);
    // skin, eyes and cloth: water-tinted image-based light, then the world's
    // caustics/absorption patch (the knife keeps the untinted env: its
    // reflections are what keep the blade readable)
    const P = (m) => this._patch(this._tintIbl(m));
    // neck / hands: the same weathered tan as the painted head (head.js skin base)
    const skinColor = new THREE.Color().setRGB(0.54, 0.38, 0.295, THREE.SRGBColorSpace);

    this.materials = {
      jacket: P(
        new THREE.MeshStandardMaterial({
          color: new THREE.Color().setRGB(0.2, 0.22, 0.26, THREE.SRGBColorSpace),
          map: jacketTex.map,
          normalMap: jacketTex.normalMap,
          normalScale: new THREE.Vector2(0.75, 0.75),
          roughnessMap: jacketTex.roughnessMap,
          roughness: 1,
          envMap: this.envMap,
          envMapIntensity: 0.35,
        }),
      ),
      shirt: P(
        new THREE.MeshStandardMaterial({
          color: new THREE.Color().setRGB(0.31, 0.31, 0.32, THREE.SRGBColorSpace),
          map: shirtTex.map,
          normalMap: shirtTex.normalMap,
          normalScale: new THREE.Vector2(0.6, 0.6),
          roughnessMap: shirtTex.roughnessMap,
          roughness: 1,
          envMap: this.envMap,
          envMapIntensity: 0.3,
        }),
      ),
      trousers: P(
        new THREE.MeshStandardMaterial({
          color: new THREE.Color().setRGB(0.15, 0.155, 0.17, THREE.SRGBColorSpace),
          map: trouserTex.map,
          normalMap: trouserTex.normalMap,
          normalScale: new THREE.Vector2(0.7, 0.7),
          roughnessMap: trouserTex.roughnessMap,
          roughness: 1,
          envMap: this.envMap,
          envMapIntensity: 0.3,
        }),
      ),
      skin: P(
        new THREE.MeshPhysicalMaterial({
          color: skinColor,
          roughness: 0.6,
          sheen: 0.22,
          sheenColor: new THREE.Color(0.5, 0.26, 0.2),
          sheenRoughness: 0.5,
          envMap: this.envMap,
          envMapIntensity: 0.4,
        }),
      ),
      shoes: P(
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.95,
          normalMap: trouserTex.normalMap,
          normalScale: new THREE.Vector2(0.5, 0.5),
          envMap: this.envMap,
          envMapIntensity: 0.2,
        }),
      ),
    };
    const headTex = makeHeadTextures(BOOT_TEX);
    this.materials.head = P(
      new THREE.MeshPhysicalMaterial({
        map: headTex.map,
        bumpMap: headTex.bumpMap,
        bumpScale: 1.2,
        roughnessMap: headTex.roughnessMap,
        aoMap: headTex.roughnessMap, // R = cavity occlusion
        aoMapIntensity: 1,
        roughness: 1,
        sheen: 0.2,
        sheenColor: new THREE.Color(0.5, 0.26, 0.2),
        sheenRoughness: 0.5,
        envMap: this.envMap,
        envMapIntensity: 0.4,
      }),
    );
    this.materials.eyes = P(
      new THREE.MeshPhysicalMaterial({
        map: makeEyeTexture(),
        roughness: 0.12,
        clearcoat: 0.5,
        clearcoatRoughness: 0.1,
        envMap: this.envMap,
        envMapIntensity: 0.25,
      }),
    );
  }

  _skinned(geo, mat, name) {
    const m = new THREE.SkinnedMesh(geo, mat);
    m.name = name;
    m.frustumCulled = false;
    m.castShadow = this.quality !== 'low';
    m.receiveShadow = this.quality !== 'low';
    this.root.add(m);
    m.bind(this.skeleton, new THREE.Matrix4());
    return m;
  }

  // -------------------------------------------------------------------------
  _buildSkinnedParts() {
    this.meshes = {};
    this.meshes.jacket = this._skinned(this._jacketGeometry(), this.materials.jacket, 'jacket');
    this.meshes.shirt = this._skinned(this._shirtGeometry(), this.materials.shirt, 'shirt');
    this.meshes.trousers = this._skinned(this._trouserGeometry(), this.materials.trousers, 'trousers');
    this.meshes.skin = this._skinned(this._skinGeometry(), this.materials.skin, 'skin');
  }

  _jacketGeometry() {
    const seg = this.seg * 2;
    const rings = [];
    const n = this.quality === 'low' ? 22 : 36;
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const y = 0.79 + (1.482 - 0.79) * (s * 0.75 + 0.25 * (0.5 - 0.5 * Math.cos(Math.PI * s)));
      rings.push(torsoRing(y, JACKET_INFLATE, jacketFlare(y)));
    }
    const torsoW = buildLoft({
      rings,
      seg,
      arc: (i, r) => {
        const o = openAt(r.y);
        return [o, TAU - o];
      },
      bump: (i, th, r) => jacketBump(th > Math.PI ? th - TAU : th, r.y),
      weights: (p, i, th, acc) => torsoWeights(p, acc, { cloth: true, th: th > Math.PI ? th - TAU : th }),
      thickness: 0.006,
      rimStart: true,
      rimEnd: true,
      uScale: 8,
      vScale: 8,
    });
    const parts = [torsoW, ...this._collarGeometry(), this._sleeveGeometry('R'), this._sleeveGeometry('L')];
    return mergeParts(parts);
  }

  _collarGeometry() {
    // Turn-down work-jacket collar: a stand rising around the neck and a fall
    // folding back down over it. Open at the front where the lapels begin.
    const ringAt = (y, rx, rf, rb, cz) => {
      const tilt = 0.6;
      return {
        c: new THREE.Vector3(0, y, cz),
        ax: new THREE.Vector3(1, 0, 0),
        az: new THREE.Vector3(0, -tilt, 1).normalize(),
        rx,
        rzf: rf,
        rzb: rb,
        e: 2.2,
        y,
      };
    };
    const w = (p, i, th, acc) => {
      acc.add(B.chest, 0.65);
      acc.add(B.neck, 0.35);
    };
    // one fold-down collar: hugs the neck at the top, rolls out over the yoke
    const fall = buildLoft({
      rings: [
        ringAt(1.508, 0.086, 0.072, 0.08, -0.026),
        ringAt(1.498, 0.098, 0.083, 0.091, -0.026),
        ringAt(1.484, 0.114, 0.096, 0.104, -0.024),
        ringAt(1.47, 0.128, 0.106, 0.115, -0.022),
      ],
      seg: this.seg * 2,
      // around the sides and back only; the rolled lapels carry the front
      arc: (i) => [1.3 - i * 0.04, TAU - 1.3 + i * 0.04],
      bump: (i, th) => 0.0012 * Math.sin(th * 5 + i),
      weights: w,
      thickness: 0.0045,
      rimStart: true,
      rimEnd: true,
      uScale: 6,
      vScale: 8,
    });
    return [fall];
  }

  _sleeveGeometry(side) {
    const R = side === 'R';
    const dir = R ? ARM_DIR_R : ARM_DIR_L;
    const sh = bindPos(R ? 'upperArmR' : 'upperArmL');
    const el = bindPos(R ? 'foreArmR' : 'foreArmL');
    const wr = bindPos(R ? 'handR' : 'handL');
    const up = new THREE.Vector3(0, 1, 0);
    const pts = [
      sh.clone().addScaledVector(dir, -0.03).addScaledVector(up, -0.006),
      sh.clone().addScaledVector(dir, 0.08),
      el.clone(),
      el.clone().addScaledVector(dir, 0.13),
      wr.clone().addScaledVector(dir, 0.012),
    ];
    const prof = [
      { rx: 0.057, rzf: 0.062, rzb: 0.064, e: 2.1 },
      { rx: 0.058, rzf: 0.061, rzb: 0.063, e: 2.1 },
      { rx: 0.054, rzf: 0.056, rzb: 0.057, e: 2.1 },
      { rx: 0.051, rzf: 0.052, rzb: 0.053, e: 2.1 },
      { rx: 0.049, rzf: 0.05, rzb: 0.051, e: 2.1 },
    ];
    const rings = pathRings(pts, prof, new THREE.Vector3(0, 0, 1), this.quality === 'low' ? 14 : 24);
    const sElbow = 0.03 + UPPER_ARM_LEN;
    const sEnd = rings[rings.length - 1].s;
    const bClav = R ? B.clavR : B.clavL;
    const bUp = R ? B.upperArmR : B.upperArmL;
    const bFore = R ? B.foreArmR : B.foreArmL;
    const bSleeve = R ? B.sleeveR : B.sleeveL;
    const SHELL = 0.005;
    const sleeve = buildLoft({
      rings,
      seg: this.seg,
      bump: (i, th, r) => {
        const s = r.s;
        // creases at the inner elbow + bunching at the cuff + random folds
        let b = 0.0022 * fbm3(th * 1.3, s * 18, R ? 1 : 5, 2);
        b -= 0.003 * gauss(s, sElbow, 0.03) * gauss(Math.cos(th), 1, 0.5);
        b += 0.0018 * Math.sin(s * 160 + th) * smoothstep(sEnd - 0.12, sEnd, s);
        return b;
      },
      weights: (p, i, th, acc) => {
        const s = rings[i].s;
        const upW = smoothstep(-0.005, 0.075, s);
        const fore = smoothstep(sElbow - 0.06, sElbow + 0.05, s);
        const slv = smoothstep(sElbow + 0.08, sEnd, s) * 0.55;
        acc.add(bClav, 1 - upW);
        acc.add(bUp, upW * (1 - fore));
        acc.add(bFore, upW * fore * (1 - slv));
        acc.add(bSleeve, upW * fore * slv);
      },
      thickness: SHELL,
      rimEnd: true,
      uScale: 3,
      vScale: 8,
    });

    // Cuff lining: a short funnel just inside the cuff, from the sleeve's
    // inner wall down to slightly inside the wrist, so the sleeve never reads
    // as an open tube with a dark rim. The end ring's frame has az ≈ the hand's
    // width axis (w) and ax ≈ the palm normal (n), matching the wrist ellipse
    // (half-width ≈ 0.031 along w, ≈ 0.017 along n at the cuff).
    const end = rings[rings.length - 1];
    const lining = [
      [0.0025, 1.0],
      [0.008, 0.55],
      [0.015, 0.0],
    ].map(([back, f]) => ({
      c: end.c.clone().addScaledVector(end.tan, -back),
      ax: end.ax,
      az: end.az,
      rx: (end.rx - SHELL * 1.1) * f + 0.0155 * (1 - f),
      rzf: (end.rzf - SHELL * 1.1) * f + 0.026 * (1 - f),
      rzb: (end.rzb - SHELL * 1.1) * f + 0.026 * (1 - f),
      e: 2.1,
    }));
    const cuff = buildLoft({
      rings: lining,
      seg: this.seg,
      flip: true, // visible side faces the hand / the axis
      bump: (i, th) => 0.0008 * Math.sin(th * 7 + (R ? 0 : 2)) * (i === 2 ? 0 : 1), // gathered cloth
      weights: (p, i, th, acc) => {
        acc.add(bFore, 0.45);
        acc.add(bSleeve, 0.55);
      },
      uScale: 3,
      vScale: 8,
    });
    return mergeParts([sleeve, cuff]);
  }

  _shirtGeometry() {
    const rings = [];
    const n = this.quality === 'low' ? 16 : 26;
    for (let i = 0; i <= n; i++) {
      const y = 0.9 + ((1.497 - 0.9) * i) / n;
      rings.push(torsoRing(y, 0.0015 + Math.max(0, 0.96 - y) * 0.12, 0));
    }
    // shirt collar band around the neck
    const g = buildLoft({
      rings,
      seg: this.seg * 2,
      bump: (i, th, r) => 0.0015 * fbm3(th * 2, r.y * 30, 7.7, 2),
      weights: (p, i, th, acc) => torsoWeights(p, acc),
      thickness: 0.004,
      rimEnd: true,
      uScale: 9,
      vScale: 9,
    });
    // the visible strip of shirt between the open jacket panels gets a
    // button placket
    const placket = buildLoft({
      rings: [0.95, 1.1, 1.25, 1.38].map((y) => {
        const t = torsoAt(y);
        const tilt = neckTilt(y);
        return {
          c: new THREE.Vector3(0, y - t.rf * tilt * 0.9, t.cz + t.rf + 0.0012),
          ax: new THREE.Vector3(1, 0, 0),
          az: new THREE.Vector3(0, 0, 1),
          rx: 0.013,
          rzf: 0.0022,
          rzb: 0.0022,
          e: 4,
          y,
        };
      }),
      seg: 8,
      weights: (p, i, th, acc) => torsoWeights(p, acc),
      capStart: true,
      capEnd: true,
      uScale: 1,
      vScale: 9,
    });
    return mergeParts([g, placket]);
  }

  _trouserGeometry() {
    // pelvis / seat
    const PEL = [
      [1.07, 0.006, 0.138, 0.09, 0.09],
      [1.0, 0.003, 0.145, 0.091, 0.098],
      [0.94, 0.0, 0.152, 0.092, 0.108],
      [0.89, -0.004, 0.158, 0.092, 0.118],
      [0.85, -0.004, 0.145, 0.083, 0.108],
      [0.822, 0.0, 0.1, 0.056, 0.066],
      [0.806, 0.0, 0.04, 0.024, 0.026],
      [0.8, 0.0, 0.004, 0.003, 0.003],
    ];
    const pelRings = PEL.map(([y, cz, rx, rf, rb]) => ({
      c: new THREE.Vector3(0, y, cz),
      ax: new THREE.Vector3(1, 0, 0),
      az: new THREE.Vector3(0, 0, 1),
      rx,
      rzf: rf,
      rzb: rb,
      e: 2.3,
      y,
    }));
    const pelvis = buildLoft({
      rings: pelRings,
      seg: this.seg * 2,
      bump: (i, th, r) => 0.0018 * fbm3(th * 1.5, r.y * 20, 9.1, 2),
      weights: (p, i, th, acc) => {
        const y = p.y;
        const ax = Math.abs(p.x);
        const wSpine = smoothstep(1.0, 1.07, y) * 0.5;
        const thigh = smoothstep(0.98, 0.84, y) * smoothstep(0.02, 0.1, ax) * 0.6;
        acc.add(B.spine, wSpine);
        acc.add(p.x >= 0 ? B.thighL : B.thighR, thigh);
        acc.add(B.pelvis, Math.max(0, 1 - wSpine - thigh));
      },
      uScale: 9,
      vScale: 9,
    });
    return mergeParts([pelvis, this._legGeometry('R'), this._legGeometry('L')]);
  }

  _legGeometry(side) {
    const R = side === 'R';
    const sx = R ? -1 : 1;
    const pts = [
      new THREE.Vector3(sx * 0.082, 1.0, -0.004),
      new THREE.Vector3(sx * 0.088, 0.9, 0.0),
      new THREE.Vector3(sx * 0.092, 0.7, 0.006),
      new THREE.Vector3(sx * 0.095, 0.5, 0.012),
      new THREE.Vector3(sx * 0.098, 0.3, 0.002),
      new THREE.Vector3(sx * 0.1, 0.1, -0.01),
      new THREE.Vector3(sx * 0.1, 0.052, -0.012),
    ];
    const prof = [
      { rx: 0.07, rzf: 0.075, rzb: 0.085, e: 2.1 },
      { rx: 0.083, rzf: 0.084, rzb: 0.094, e: 2.1 },
      { rx: 0.073, rzf: 0.074, rzb: 0.077, e: 2.1 },
      { rx: 0.06, rzf: 0.063, rzb: 0.061, e: 2.1 },
      { rx: 0.057, rzf: 0.056, rzb: 0.066, e: 2.1 },
      { rx: 0.052, rzf: 0.054, rzb: 0.056, e: 2.1 },
      { rx: 0.055, rzf: 0.058, rzb: 0.058, e: 2.1 },
    ];
    const rings = pathRings(pts, prof, new THREE.Vector3(0, 0, 1), this.quality === 'low' ? 18 : 30);
    const bThigh = R ? B.thighR : B.thighL;
    const bShin = R ? B.shinR : B.shinL;
    const bFoot = R ? B.footR : B.footL;
    return buildLoft({
      rings,
      seg: this.seg,
      bump: (i, th, r) => {
        const y = r.c.y;
        let b = 0.0024 * fbm3(th * 1.4, y * 16, R ? 2 : 8, 2);
        b += 0.0022 * Math.sin(y * 140 + th * 1.5) * gauss(y, 0.12, 0.05); // bunching above the shoe
        b -= 0.002 * gauss(y, 0.5, 0.025) * gauss(Math.cos(th), -1, 0.5); // back of knee
        b += 0.0012 * gauss(Math.cos(th), 1, 0.12); // front crease
        return b;
      },
      weights: (p, i, th, acc) => {
        const y = p.y;
        const thigh = smoothstep(1.0, 0.86, y);
        const shin = smoothstep(0.56, 0.45, y);
        const foot = smoothstep(0.11, 0.055, y) * 0.45;
        acc.add(B.pelvis, 1 - thigh);
        acc.add(bThigh, thigh * (1 - shin));
        acc.add(bShin, thigh * shin * (1 - foot));
        acc.add(bFoot, thigh * shin * foot);
      },
      thickness: 0.004,
      rimEnd: true,
      uScale: 4,
      vScale: 9,
    });
  }

  _skinGeometry() {
    // neck
    const neckPts = [new THREE.Vector3(0, 1.4, -0.03), new THREE.Vector3(0, 1.48, -0.022), new THREE.Vector3(0, 1.55, -0.014), new THREE.Vector3(0, 1.625, -0.004)];
    const neckProf = [
      { rx: 0.064, rzf: 0.058, rzb: 0.066 },
      { rx: 0.06, rzf: 0.056, rzb: 0.064 },
      { rx: 0.057, rzf: 0.054, rzb: 0.062 },
      { rx: 0.058, rzf: 0.05, rzb: 0.062 },
    ];
    const neckRings = pathRings(neckPts, neckProf, new THREE.Vector3(0, 0, 1), 14);
    const neck = buildLoft({
      rings: neckRings,
      seg: this.seg * 2,
      bump: (i, th, r) => {
        const y = r.c.y;
        let b = 0.0055 * gauss(th, 0, 0.16) * gauss(y, 1.5, 0.014); // Adam's apple
        b += 0.003 * gauss(Math.abs(th), 0.75, 0.22) * gauss(y, 1.5, 0.05); // sternocleidomastoid
        b += 0.002 * gauss(Math.abs(th), 2.6, 0.3) * gauss(y, 1.47, 0.04); // trapezius
        return b;
      },
      weights: (p, i, th, acc) => {
        const y = p.y;
        const head = smoothstep(1.55, 1.61, y);
        const chest = smoothstep(1.49, 1.43, y);
        acc.add(B.head, head);
        acc.add(B.chest, chest);
        acc.add(B.neck, Math.max(0, 1 - head - chest));
      },
    });
    return mergeParts([neck, ...this._openHandGeometry(), ...this._fistGeometry()]);
  }

  /** Converts hand-frame coordinates (a, n, w) at a wrist to model space. */
  _hp(wrist, f, a, n, w) {
    return wrist.clone().addScaledVector(f.a, a).addScaledVector(f.n, n).addScaledVector(f.w, w);
  }

  _wristAndPalm(wrist, f, foreBone, handBone, palmLen) {
    // wrist stub (inside the cuff) + palm, lofted along a
    const pts = [];
    const prof = [];
    const stations = [
      [-0.06, 0.03, 0.022],
      [-0.025, 0.029, 0.019],
      [0.0, 0.031, 0.017],
      [0.03, 0.037, 0.0148],
      [0.065, 0.042, 0.0138],
      [palmLen - 0.01, 0.044, 0.0122],
      [palmLen, 0.04, 0.0098],
      [palmLen + 0.006, 0.032, 0.0058],
    ];
    for (const [a, hw, hn] of stations) {
      pts.push(this._hp(wrist, f, a, 0.002, -0.002));
      prof.push({ rx: hw, rzf: hn, rzb: hn * 1.05, e: a > 0.0 ? 3.0 : 2.2 });
    }
    // rings: az = n (palm normal is the ring "front"), ax = n × a
    const rings = pathRings(pts, prof, f.n.clone(), 16);
    for (const r of rings) {
      // ensure ax runs along ±w so rx is the hand's width
      r.ax.copy(f.w).addScaledVector(r.tan, -f.w.dot(r.tan)).normalize();
      r.az.crossVectors(r.tan, r.ax).normalize();
      if (r.az.dot(f.n) < 0) r.az.negate();
    }
    return buildLoft({
      rings,
      seg: this.seg,
      capEnd: true,
      bump: (i, th, r) => {
        const a = r.s - 0.06; // distance past the wrist
        const back = gauss(Math.cos(th), -1, 0.45);
        // tendons fanning to the knuckles, then the knuckle row itself
        let b = 0.0012 * back * smoothstep(0.0, 0.05, a) * (0.5 + 0.5 * Math.cos(Math.sin(th) * 14));
        b += 0.0026 * back * gauss(a, palmLen - 0.006, 0.006) * (0.55 + 0.45 * Math.cos(Math.sin(th) * 13));
        return b;
      },
      weights: (p, i, th, acc) => {
        const s = rings[i].s - 0.06; // 0 at the wrist
        const h = smoothstep(-0.02, 0.012, s);
        acc.add(foreBone, 1 - h);
        acc.add(handBone, h);
      },
    });
  }

  /**
   * A finger tapering r0 → r1 along `points`. `mult` (optional, one per point)
   * scales the section: > 1 at the knuckles, < 1 along the phalanges, so the
   * finger reads as jointed segments rather than a smooth tube.
   */
  _fingerTube(points, r0, r1, weightFn, tipRound = true, mult = null, samples = 0) {
    const n = points.length;
    const prof = points.map((_, i) => {
      const t = i / (n - 1);
      const r = (r0 + (r1 - r0) * t) * (mult?.[i] ?? 1);
      return { rx: r, rzf: r * 0.92, rzb: r * 0.86, e: 2.2 };
    });
    if (tipRound) {
      // extend with shrinking rings for a rounded fingertip
      const last = points[n - 1];
      const dir = last.clone().sub(points[n - 2]).normalize();
      points = [...points, last.clone().addScaledVector(dir, r1 * 0.55), last.clone().addScaledVector(dir, r1 * 0.85)];
      prof.push({ rx: r1 * 0.78, rzf: r1 * 0.7, rzb: r1 * 0.7 }, { rx: r1 * 0.3, rzf: r1 * 0.28, rzb: r1 * 0.28 });
    }
    const rings = pathRings(points, prof, new THREE.Vector3(0, 0, 1), samples || Math.max(8, points.length * 3));
    return buildLoft({
      rings,
      seg: Math.max(8, Math.round(this.seg * 0.5)),
      capStart: true,
      weights: (p, i, th, acc) => weightFn(rings[i].s, acc),
    });
  }

  _openHandGeometry() {
    const f = HAND_L;
    const wrist = bindPos('handL');
    const parts = [this._wristAndPalm(wrist, f, B.foreArmL, B.handL, 0.094)];
    // fingers: [w offset, length, radius, spread]
    const fingers = [
      [0.026, 0.084, 0.0092, 0.07],
      [0.0085, 0.094, 0.0096, 0.0],
      [-0.009, 0.088, 0.0091, -0.05],
      [-0.0255, 0.07, 0.008, -0.12],
    ];
    // section scale per control point (t = k/8): middle (t ≈ 0.5) and end
    // (t ≈ 0.75) knuckles swell, the phalanges between them slim a little
    const knuckles = [1.0, 0.97, 0.95, 0.98, 1.07, 0.97, 1.05, 0.96, 0.95];
    for (const [w, len, r, spread] of fingers) {
      const pts = [];
      const steps = knuckles.length - 1;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const a = 0.082 + len * t + 0.006;
        // slight natural curl toward the palm
        const n = 0.002 + 0.006 * t * t;
        pts.push(this._hp(wrist, f, a, n, w + spread * len * t));
      }
      parts.push(
        this._fingerTube(
          pts,
          r,
          r * 0.82,
          (s, acc) => {
            const f1 = smoothstep(0.004, 0.016, s);
            const f2 = smoothstep(0.044, 0.056, s);
            acc.add(B.handL, 1 - f1);
            acc.add(B.fingersL1, f1 * (1 - f2));
            acc.add(B.fingersL2, f1 * f2);
          },
          true,
          knuckles,
          18,
        ),
      );
    }
    // thumb
    const tp = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      tp.push(this._hp(wrist, f, 0.01 + 0.058 * t, 0.006 + 0.012 * t, 0.016 + 0.043 * t - 0.006 * t * t));
    }
    parts.push(
      this._fingerTube(tp, 0.0145, 0.0086, (s, acc) => {
        const k = smoothstep(0.01, 0.03, s);
        acc.add(B.handL, 1 - k);
        acc.add(B.thumbL, k);
      }),
    );
    return parts;
  }

  _fistGeometry() {
    const f = HAND_R;
    const wrist = bindPos('handR');
    const parts = [this._wristAndPalm(wrist, f, B.foreArmR, B.handR, 0.09)];
    const hand = (s, acc) => acc.add(B.handR, 1);
    // curled fingers wrap around the handle (axis ≈ w, tilted toward a)
    const tilt = KNIFE_DIR_BIND.dot(f.a) / KNIFE_DIR_BIND.dot(f.w);
    const gripA = GRIP_OFFSET_R.dot(f.a);
    const gripN = GRIP_OFFSET_R.dot(f.n);
    const fingers = [
      [0.025, 0.0094, 185],
      [0.008, 0.0097, 195],
      [-0.009, 0.0092, 185],
      [-0.025, 0.0081, 165],
    ];
    for (const [w, r, wrapDeg] of fingers) {
      const ca = gripA + tilt * w;
      const cn = gripN;
      const rad = 0.0245;
      const at = (deg, radius) => {
        const ang = THREE.MathUtils.degToRad(deg);
        return this._hp(wrist, f, ca + Math.cos(ang) * radius, cn + Math.sin(ang) * radius * 0.98, w);
      };
      // Three phalanges as near-straight chords bending at the joints (a
      // smooth arc reads as a sausage), knuckles swelling at each bend.
      let deg = -62;
      const pts = [this._hp(wrist, f, 0.074, 0.001, w), at(deg, rad)];
      const mult = [1.0, 1.06];
      for (const share of PHALANX_SHARE) {
        const span = wrapDeg * share;
        const half = THREE.MathUtils.degToRad(span / 2);
        pts.push(at(deg + span / 2, rad * (1 + Math.cos(half)) / 2)); // mid-phalanx, half the chord's sagitta
        mult.push(0.95);
        deg += span;
        pts.push(at(deg, rad));
        mult.push(1.06);
      }
      mult[mult.length - 1] = 0.97; // fingertip, not a knuckle
      parts.push(this._fingerTube(pts, r, r * 0.85, hand, true, mult));
    }
    // thumb pressed over index + middle
    const tp = [
      this._hp(wrist, f, 0.01, 0.004, 0.016),
      this._hp(wrist, f, 0.042, 0.022, 0.04),
      this._hp(wrist, f, 0.066, 0.042, 0.036),
      this._hp(wrist, f, 0.08, 0.054, 0.02),
      this._hp(wrist, f, 0.084, 0.055, 0.006),
    ];
    parts.push(this._fingerTube(tp, 0.0142, 0.009, hand));
    return parts;
  }

  // -------------------------------------------------------------------------
  _buildRigidParts() {
    // head + ears
    const headBone = this.bone('head');
    const headOffset = HEAD_ORIGIN.clone().sub(bindPos('head'));
    this.headMesh = new THREE.Mesh(buildHeadGeometry(this.quality), this.materials.head);
    this.headMesh.position.copy(headOffset);
    this.eyes = new THREE.Mesh(buildEyesGeometry(), this.materials.eyes);
    this.eyes.position.copy(headOffset);
    for (const m of [this.headMesh, this.eyes]) {
      m.castShadow = this.quality !== 'low';
      m.receiveShadow = this.quality !== 'low';
      m.frustumCulled = false;
      headBone.add(m);
    }
    this.eyes.castShadow = false;

    // shoes
    for (const side of ['R', 'L']) {
      const shoe = new THREE.Mesh(this._shoeGeometry(side), this.materials.shoes);
      shoe.castShadow = this.quality !== 'low';
      shoe.receiveShadow = this.quality !== 'low';
      shoe.frustumCulled = false;
      this.bone(`foot${side}`).add(shoe);
    }

    // knife in the right fist
    const { group, materials } = buildKnife({
      envMap: this.envMap,
      quality: this.quality,
      patch: this._patch,
      lightProbe: (out) => this._glintLight(out),
    });
    this.knife = group;
    Object.assign(this.materials, {
      knifeSteel: materials.steel,
      knifeEdge: materials.edge,
      knifeWood: materials.wood,
      knifeBrass: materials.brass,
      knifeGlint: materials.glint,
    });
    // knife-local +Z → blade direction, −Y → edge direction
    const z = KNIFE_DIR_BIND.clone();
    const y = KNIFE_EDGE_BIND.clone().negate();
    const x = new THREE.Vector3().crossVectors(y, z).normalize();
    quatFromBasis(group.quaternion, x, y, z);
    group.position.copy(GRIP_OFFSET_R);
    this.bone('handR').add(group);
  }

  /**
   * Linear radiance the knife's edge glint reflects: the diffuse water light
   * around the camera plus a share of the (depth-absorbed) sun, so the glint
   * dims and turns blue-green with depth like everything else.
   */
  _glintLight(out) {
    const env = this.game.env;
    const fill = env?.hemi?.color;
    const sun = env?.sun;
    if (!fill || !sun?.color) return out.setRGB(0.15, 0.5, 0.58);
    const k = GLINT_SUN * (sun.intensity ?? 1);
    return out.setRGB(fill.r * GLINT_FILL + sun.color.r * k, fill.g * GLINT_FILL + sun.color.g * k, fill.b * GLINT_FILL + sun.color.b * k);
  }

  _shoeGeometry(side) {
    const medial = side === 'L' ? -1 : 1;
    // [z, yBottom, yTop, halfWidth, xOffset(medial)]
    const T = [
      [-0.074, -0.085, -0.05, 0.024, 0],
      [-0.068, -0.085, -0.016, 0.032, 0],
      [-0.048, -0.085, -0.006, 0.037, 0],
      [-0.012, -0.085, -0.004, 0.039, 0.002],
      [0.03, -0.085, -0.012, 0.041, 0.004],
      [0.07, -0.085, -0.028, 0.046, 0.006],
      [0.11, -0.085, -0.043, 0.048, 0.006],
      [0.148, -0.085, -0.055, 0.044, 0.004],
      [0.172, -0.085, -0.063, 0.035, 0.002],
      [0.187, -0.085, -0.07, 0.022, 0.0],
      [0.194, -0.084, -0.075, 0.009, 0.0],
    ];
    const rings = T.map(([z, yb, yt, hw, xo]) => ({
      c: new THREE.Vector3(xo * medial, (yb + yt) / 2, z),
      ax: new THREE.Vector3(1, 0, 0),
      az: new THREE.Vector3(0, 1, 0),
      rx: hw,
      rzf: (yt - yb) / 2,
      rzb: (yt - yb) / 2,
      e: 3.2,
      yb,
    }));
    const sole = new THREE.Color().setRGB(0.38, 0.36, 0.33, THREE.SRGBColorSpace);
    const cloth = new THREE.Color().setRGB(0.045, 0.045, 0.05, THREE.SRGBColorSpace);
    const welt = new THREE.Color().setRGB(0.2, 0.19, 0.18, THREE.SRGBColorSpace);
    return buildLoft({
      rings,
      seg: this.seg,
      capStart: true,
      capEnd: true,
      bump: (i, th, r) => -0.0012 * gauss(Math.cos(th), 1, 0.05) * smoothstep(0.03, 0.12, r.c.z), // centre seam over the toes
      color: (p, i) => {
        const h = p.y - rings[i].yb;
        const s = smoothstep(0.0135, 0.011, h);
        const wl = gauss(h, 0.0145, 0.0012);
        const c = cloth.clone().lerp(sole, s).lerp(welt, wl * 0.8);
        return [c.r, c.g, c.b];
      },
    });
  }

  dispose() {
    this._upgrade = null;
    this.root.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
      }
    });
    for (const m of Object.values(this.materials)) {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'bumpMap', 'aoMap']) m[k]?.dispose?.();
      m.dispose?.();
    }
    this.envMap?.dispose?.();
  }
}
