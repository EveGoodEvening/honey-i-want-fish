// Spatially bucketed scenery.
//
// One arena-wide InstancedMesh has a bounding sphere the size of the arena, so
// neither the camera frustum, the sun's shadow box nor the fog-distance cull
// can ever skip it: every instance is drawn in every pass. Splitting the
// instances into a few compact buckets (one mesh each, with a tight bounding
// sphere) lets three cull them per pass.
//
//  - makeInstancedBuckets: one InstancedMesh per bucket (for shaders that need
//    instanceMatrix, e.g. the swaying kelp).
//  - makeMergedBuckets: static props sharing one material (several different
//    geometries) baked into one plain mesh per bucket — one draw call per
//    visible bucket however many variants it holds.
import * as THREE from 'three';

const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();

const cellKey = (e, cell, cellY) =>
  `${Math.floor(e[12] / cell)},${Math.floor(e[14] / cell)},${cellY ? Math.floor(e[13] / cellY) : 0}`;

/**
 * Group items by a bucket key. `matrixOf(item)` gives the item's Matrix4;
 * `keyOf(item, index)` returns any string/number (default: the grid cell of
 * size `cell` in x/z and `cellY` in y — 0 = one band). Returns arrays of
 * items in order of first appearance.
 */
export function bucketItems(items, { cell = 40, cellY = 0, keyOf = null, matrixOf = (m) => m } = {}) {
  const map = new Map();
  items.forEach((it, i) => {
    const key = keyOf ? keyOf(it, i) : cellKey(matrixOf(it).elements, cell, cellY);
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(it);
  });
  return [...map.values()];
}

/**
 * Build one InstancedMesh per bucket of instance matrices. Options:
 *   cell / keyOf — see bucketItems
 *   name, castShadow, receiveShadow, customDepthMaterial,
 *   pad — metres added to each bounding sphere (vertex animation headroom).
 */
export function makeInstancedBuckets(geometry, material, matrices, opts = {}) {
  const meshes = [];
  bucketItems(matrices, opts).forEach((list, b) => {
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    list.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    if (opts.pad) mesh.boundingSphere.radius += opts.pad;
    finish(mesh, opts, b);
    meshes.push(mesh);
  });
  return meshes;
}

/**
 * Bake `items` ([{ geometry, matrix }]) into one static Mesh per bucket.
 * Every geometry must be indexed and carry the same attributes; position and
 * normal are transformed (normals by the inverse-transpose), any other
 * attribute (e.g. vertex colour) is copied. Options as makeInstancedBuckets.
 */
export function makeMergedBuckets(items, material, opts = {}) {
  const meshes = [];
  bucketItems(items, { ...opts, matrixOf: (it) => it.matrix }).forEach((list, b) => {
    const mesh = new THREE.Mesh(mergeTransformed(list), material);
    finish(mesh, opts, b);
    meshes.push(mesh);
  });
  return meshes;
}

function finish(mesh, opts, b) {
  mesh.castShadow = !!opts.castShadow;
  mesh.receiveShadow = !!opts.receiveShadow;
  if (opts.customDepthMaterial) mesh.customDepthMaterial = opts.customDepthMaterial;
  mesh.name = `${opts.name ?? 'bucket'}-${b}`;
  mesh.matrixAutoUpdate = false; // static scenery at the origin
}

function mergeTransformed(list) {
  const names = Object.keys(list[0].geometry.attributes);
  let nv = 0;
  let ni = 0;
  for (const { geometry } of list) {
    nv += geometry.attributes.position.count;
    ni += geometry.index.count;
  }
  const arrays = {};
  for (const name of names) arrays[name] = new Float32Array(nv * list[0].geometry.attributes[name].itemSize);
  const index = new (nv > 65535 ? Uint32Array : Uint16Array)(ni);
  let vo = 0;
  let io = 0;
  for (const { geometry, matrix } of list) {
    _nm.getNormalMatrix(matrix);
    const count = geometry.attributes.position.count;
    for (const name of names) {
      const src = geometry.attributes[name];
      const dst = arrays[name];
      const size = src.itemSize;
      for (let i = 0; i < count; i++) {
        const o = (vo + i) * size;
        if (name === 'position') {
          _v.fromBufferAttribute(src, i).applyMatrix4(matrix);
          dst[o] = _v.x;
          dst[o + 1] = _v.y;
          dst[o + 2] = _v.z;
        } else if (name === 'normal') {
          _v.fromBufferAttribute(src, i).applyMatrix3(_nm).normalize();
          dst[o] = _v.x;
          dst[o + 1] = _v.y;
          dst[o + 2] = _v.z;
        } else {
          for (let c = 0; c < size; c++) dst[o + c] = src.array[i * size + c];
        }
      }
    }
    const idx = geometry.index.array;
    for (let i = 0; i < idx.length; i++) index[io + i] = idx[i] + vo;
    vo += count;
    io += idx.length;
  }
  const geo = new THREE.BufferGeometry();
  for (const name of names) geo.setAttribute(name, new THREE.BufferAttribute(arrays[name], list[0].geometry.attributes[name].itemSize));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return geo;
}
