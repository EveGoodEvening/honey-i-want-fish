// One draw call worth of camera-facing quads (instanced). Systems write
// packed per-instance data into `posSize`, `color`, `params` (Float32Arrays,
// 4 floats per instance) and call `commit(count)`; only the used range is
// uploaded. No allocation after construction.
import * as THREE from 'three';
import { BILLBOARD_VERTEX } from './shaderChunks.js';

const BUFFERS = 3;

export class BillboardBatch {
  /**
   * @param {object} opts
   * @param {number} opts.capacity
   * @param {string} opts.fragmentShader
   * @param {object} opts.uniforms         extra uniforms (shared objects are kept by reference)
   * @param {object} opts.shared           shared uniform objects (light, viewport, sun)
   * @param {object} opts.blend            { blending, blendSrc, blendDst, blendSrcAlpha, blendDstAlpha }
   * @param {number} opts.renderOrder
   */
  constructor({ capacity, fragmentShader, uniforms = {}, shared, blend, renderOrder = 10, name = 'vfx', depthBias = 0 }) {
    this.capacity = capacity;
    this.posSize = new Float32Array(capacity * 4);
    this.color = new Float32Array(capacity * 4);
    this.params = new Float32Array(capacity * 4);

    // GPU buffers are ring-buffered: each frame uploads into a different set
    // of instance attributes (all sharing the CPU arrays above), so we never
    // overwrite a buffer the previous frame's draw may still be reading —
    // that forces an implicit GPU sync (stall) on many drivers.
    const quad = new THREE.PlaneGeometry(1, 1);
    this._sets = [];
    for (let b = 0; b < BUFFERS; b++) {
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = quad.index;
      geo.setAttribute('position', quad.getAttribute('position'));
      const attrs = [
        new THREE.InstancedBufferAttribute(this.posSize, 4).setUsage(THREE.DynamicDrawUsage),
        new THREE.InstancedBufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage),
        new THREE.InstancedBufferAttribute(this.params, 4).setUsage(THREE.DynamicDrawUsage),
      ];
      geo.setAttribute('iPosSize', attrs[0]);
      geo.setAttribute('iColor', attrs[1]);
      geo.setAttribute('iParams', attrs[2]);
      geo.instanceCount = 0;
      // Bounds are irrelevant (frustumCulled = false) but keep three happy.
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      this._sets.push({ geo, attrs });
    }
    this._cur = 0;

    const u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
    Object.assign(u, uniforms, shared);
    u.uDepthBias = { value: depthBias };
    this.material = new THREE.ShaderMaterial({
      name,
      uniforms: u,
      vertexShader: BILLBOARD_VERTEX,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: true,
      ...blend,
    });

    this.mesh = new THREE.Mesh(this._sets[0].geo, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
  }

  get geometry() {
    return this.mesh.geometry;
  }

  /** Upload the first `count` instances and draw them. */
  commit(count) {
    const n = Math.min(count, this.capacity);
    this.mesh.visible = n > 0;
    if (n === 0) return;
    this._cur = (this._cur + 1) % BUFFERS;
    const set = this._sets[this._cur];
    this.mesh.geometry = set.geo;
    set.geo.instanceCount = n;
    for (let i = 0; i < 3; i++) {
      const a = set.attrs[i];
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * 4);
      a.needsUpdate = true;
    }
  }

  dispose() {
    for (const set of this._sets) set.geo.dispose();
    this.material.dispose();
  }
}

/** Premultiplied-alpha "over" blending. Output (rgb*a, a*k): k < 1 → partially additive. */
export const PREMULTIPLIED_BLEND = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};

export const ALPHA_BLEND = {
  blending: THREE.NormalBlending,
};
