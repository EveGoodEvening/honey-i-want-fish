// Distance-sorted draw lists over the tiles of one big static mesh.
//
// A large surface (the seabed grid, the reef wall) is one shared vertex
// buffer whose index buffer is cut into many small tiles. Instead of one mesh
// per tile (one draw call each), the tiles are sorted per camera position into
// a few lists — e.g. near / far fog-LOD, with or without shadows — and each
// list is one mesh with its own dynamic index buffer: one draw call per list
// however many tiles it holds, while the LOD switches tile by tile.
//
// Lists are rebuilt (index copy + one buffer upload per list, a few times a
// second at most) only once the camera has moved more than `hysteresis`
// metres from where they were last sorted, so in between they must stay
// valid: the classifier pads its distance thresholds by that margin, erring
// toward keeping a tile / the costlier list. Each list's bounding sphere is
// the union of its tiles, so three still culls whole lists per camera (shadow
// camera included).
import * as THREE from 'three';

const _box = new THREE.Box3();

export class TileLists {
  /**
   * @param {object} tiles `{ index, start, len, box, count }`: the tile-major
   *   index source (tile t owns index[start[t] .. start[t] + len[t])) and the
   *   tiles' world AABBs (6 floats each: min xyz, max xyz); count ≤ 65536.
   * @param {object} attributes BufferAttributes shared by every list.
   * @param {object[]} defs one per list: `{ name, material, capacity,
   *   castShadow, receiveShadow }` (capacity: max indices the list can hold).
   * @param {object} opts `{ hysteresis = 4, renderOrder = 0 }`.
   */
  constructor(tiles, attributes, defs, { hysteresis = 4, renderOrder = 0 } = {}) {
    this.tiles = tiles;
    this.hysteresis = hysteresis;
    this.group = new THREE.Group();
    this.meshes = defs.map((def) => {
      const geo = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(attributes)) geo.setAttribute(name, attr);
      const index = new THREE.BufferAttribute(new tiles.index.constructor(Math.max(def.capacity, 3)), 1);
      index.setUsage(THREE.DynamicDrawUsage);
      geo.setIndex(index);
      geo.setDrawRange(0, 0);
      geo.boundingSphere = new THREE.Sphere();
      const mesh = new THREE.Mesh(geo, def.material);
      mesh.name = def.name;
      mesh.castShadow = !!def.castShadow;
      mesh.receiveShadow = !!def.receiveShadow;
      mesh.renderOrder = renderOrder;
      mesh.matrixAutoUpdate = false; // static, at the origin
      mesh.visible = false;
      if (def.capacity > 0) this.group.add(mesh);
      return mesh;
    });
    const n = tiles.count;
    this._keys = new Float64Array(n);
    this._cls = new Int8Array(n);
    this._count = new Uint32Array(defs.length);
    this._bounds = new Float32Array(defs.length * 6);
    this._anchor = new THREE.Vector3(Infinity, 0, 0);
    this._key = NaN;
    this._warm = false;
  }

  /**
   * Re-sort the tiles when the camera `cam` (world position) has moved more
   * than the hysteresis since the last rebuild, or `key` (anything the
   * classification depends on, e.g. the fog density) changed.
   * `classify(dist, tile)` → list index, or −1 to drop the tile; `dist` is
   * the distance from the camera to the tile's AABB (pad thresholds by the
   * hysteresis). Returns true on a rebuild.
   */
  update(cam, key, classify) {
    const M = this.hysteresis;
    if (key === this._key && cam.distanceToSquared(this._anchor) < M * M) return false;
    this._rebuild(cam, classify);
    this._anchor.copy(cam);
    this._key = key;
    return true;
  }

  /** Warm-up: every list drawn (programs compile even when it is empty), no culling. */
  setWarm(on) {
    this._warm = on;
    for (const mesh of this.meshes) {
      mesh.visible = on || mesh.geometry.drawRange.count > 0;
      mesh.frustumCulled = !on;
    }
  }

  _rebuild(cam, classify) {
    const { index, start, len, box, count } = this.tiles;
    const keys = this._keys;
    const cls = this._cls;
    let n = 0;
    for (let t = 0; t < count; t++) {
      const o = t * 6;
      const dx = Math.max(box[o] - cam.x, 0, cam.x - box[o + 3]);
      const dy = Math.max(box[o + 1] - cam.y, 0, cam.y - box[o + 4]);
      const dz = Math.max(box[o + 2] - cam.z, 0, cam.z - box[o + 5]);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const li = classify(d, t);
      if (li < 0) continue;
      cls[t] = li;
      // Front to back (coarse distance, then tile id) helps early depth test.
      keys[n++] = Math.floor(d * 4) * 65536 + t;
    }
    keys.subarray(0, n).sort();
    const counts = this._count.fill(0);
    const b = this._bounds;
    for (let i = 0; i < b.length; i++) b[i] = i % 6 < 3 ? Infinity : -Infinity;
    const meshes = this.meshes;
    for (let i = 0; i < n; i++) {
      const t = keys[i] % 65536;
      const li = cls[t];
      const s = start[t];
      const c = len[t];
      meshes[li].geometry.index.array.set(index.subarray(s, s + c), counts[li]);
      counts[li] += c;
      const o = t * 6;
      const lo = li * 6;
      for (let k = 0; k < 3; k++) {
        if (box[o + k] < b[lo + k]) b[lo + k] = box[o + k];
        if (box[o + 3 + k] > b[lo + 3 + k]) b[lo + 3 + k] = box[o + 3 + k];
      }
    }
    for (let li = 0; li < meshes.length; li++) {
      const mesh = meshes[li];
      const geo = mesh.geometry;
      const c = counts[li];
      if (c > 0) {
        geo.index.clearUpdateRanges();
        geo.index.addUpdateRange(0, c);
        geo.index.needsUpdate = true;
        const lo = li * 6;
        _box.min.set(b[lo], b[lo + 1], b[lo + 2]);
        _box.max.set(b[lo + 3], b[lo + 4], b[lo + 5]);
        _box.getBoundingSphere(geo.boundingSphere);
      }
      geo.setDrawRange(0, c);
      mesh.visible = this._warm || c > 0;
    }
  }
}
