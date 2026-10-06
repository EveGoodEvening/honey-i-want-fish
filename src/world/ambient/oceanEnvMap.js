// Procedural underwater reflection environment (equirectangular, linear HDR).
//
// What a silver fish flank actually reflects underwater: a bright Snell's
// window straight up, a fast falloff to the water colour at ~49° from the
// zenith, dim blue-green water around the horizon and near-black depth below.
// Used as envMap for the fish (silvery flashes when they turn) and, faintly,
// for the whale's wet skin. three.js converts it to PMREM on first use.
import * as THREE from 'three';

export function createOceanEnvMap(waterColor = new THREE.Color(0x0b3140), { width = 128, height = 64 } = {}) {
  const data = new Float32Array(width * height * 4);
  const water = waterColor.clone();
  // keep some saturation but ensure the band is not pitch black
  const wr = Math.max(0.01, water.r);
  const wg = Math.max(0.03, water.g);
  const wb = Math.max(0.045, water.b);
  const snellEdge = Math.cos((48.6 * Math.PI) / 180);

  for (let y = 0; y < height; y++) {
    // equirect: v = 1 at the top (up)
    const v = 1 - (y + 0.5) / height;
    const elev = (v - 0.5) * Math.PI; // -pi/2..pi/2
    const up = Math.sin(elev); // cos of zenith angle
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const az = u * Math.PI * 2;
      let r;
      let g;
      let b;
      if (up > snellEdge) {
        // inside Snell's window: bright, slightly rippled sky
        const k = (up - snellEdge) / (1 - snellEdge);
        const ripple = 0.85 + 0.15 * Math.sin(az * 9 + k * 14) * Math.sin(az * 5 - k * 9);
        const I = (0.9 + 2.6 * k * k) * ripple;
        r = 0.62 * I;
        g = 0.9 * I;
        b = 1.0 * I;
      } else {
        // outside: total internal reflection of the deep → water colour,
        // brightest just under the window edge, fading to black below
        const k = (up + 1) / (1 + snellEdge); // 0 straight down .. 1 at the window edge
        const glow = Math.pow(k, 3.2);
        const edgeBoost = Math.exp(-Math.pow((up - snellEdge) / 0.06, 2)) * 0.9;
        const I = 0.04 + 1.6 * glow + edgeBoost;
        r = wr * I + edgeBoost * 0.12;
        g = wg * I + edgeBoost * 0.25;
        b = wb * I + edgeBoost * 0.3;
      }
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.name = 'AmbientLife.oceanEnv';
  return tex;
}
