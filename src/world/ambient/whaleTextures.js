// Procedural sperm-whale skin textures (canvas, built once).
//   colour: slate grey-brown, darker back, paler belly, pale scratch scars
//           and squid sucker rings on the head, mottling along the body
//   bump  : tiling, prune-like circumferential wrinkles (strongest behind the
//           head on a real animal; here everywhere, the head is mostly seen
//           from a distance anyway)
// UV convention (see whaleGeometry): u around the body (0.25 = top,
// 0.75 = belly), v along it (0 = nose → 1 = tail).
import * as THREE from 'three';
import { createRng } from './util.js';

// Tileable value noise on a `period` grid.
function makeNoise(rng, period) {
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % period) + period) % period;
    const y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;
    const a = g[y0 * period + x0];
    const b = g[y0 * period + x1];
    const c = g[y1 * period + x0];
    const d = g[y1 * period + x1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

export function createWhaleBumpTexture(size = 256, seed = 41) {
  const rng = createRng(seed);
  const n1 = makeNoise(rng, 8);
  const n2 = makeNoise(rng, 32);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const wrinkles = 38; // ridges per tile
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // wavy circumferential ridges (constant v → wrinkle line)
      const warp = n1(u * 8, v * 8) * 1.6 + n2(u * 32, v * 32) * 0.35;
      const ph = (v * wrinkles + warp) * Math.PI * 2;
      let r = 0.5 + 0.5 * Math.sin(ph);
      r = Math.pow(r, 2.2); // sharp creases, soft crests
      // break the ridges up into short segments
      const breakup = 0.55 + 0.45 * n1(u * 8 + 3.1, v * 8 + 7.7);
      const fine = n2(u * 32 + 11.0, v * 32 + 5.0);
      const h = 0.25 + 0.55 * r * breakup + 0.2 * fine;
      const o = (y * size + x) * 4;
      const b = Math.max(0, Math.min(255, h * 255));
      img.data[o] = b;
      img.data[o + 1] = b;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 6);
  tex.anisotropy = 4;
  tex.name = 'Whale.bump';
  return tex;
}

export function createWhaleColorTexture(width = 256, height = 512, seed = 17) {
  const rng = createRng(seed);
  const noise = makeNoise(rng, 16);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  const img = g.createImageData(width, height);
  // sRGB palette
  const back = [38, 37, 36];
  const flank = [62, 60, 57];
  const belly = [92, 90, 86];
  for (let y = 0; y < height; y++) {
    // canvas top row is v = 1 (CanvasTexture flipY)
    const v = 1 - y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const s = Math.sin(u * Math.PI * 2); // +1 top, -1 belly
      const kBack = Math.max(0, Math.min(1, (s - 0.1) / 0.7));
      const kBelly = Math.max(0, Math.min(1, (-s - 0.35) / 0.55));
      let r = flank[0] + (back[0] - flank[0]) * kBack + (belly[0] - flank[0]) * kBelly;
      let gg = flank[1] + (back[1] - flank[1]) * kBack + (belly[1] - flank[1]) * kBelly;
      let b = flank[2] + (back[2] - flank[2]) * kBack + (belly[2] - flank[2]) * kBelly;
      const m = 0.85 + 0.3 * noise(u * 16, v * 32) + 0.08 * noise(u * 64, v * 128);
      r *= m;
      gg *= m;
      b *= m;
      const o = (y * width + x) * 4;
      img.data[o] = r;
      img.data[o + 1] = gg;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  // pale scratch scars and sucker rings on the head (v < 0.34 → bottom of canvas)
  g.lineCap = 'round';
  const headTop = height * (1 - 0.34);
  for (let i = 0; i < 70; i++) {
    const x = rng() * width;
    const y = headTop + rng() * (height - headTop);
    const len = 6 + rng() * 26;
    const ang = rng() * Math.PI;
    g.strokeStyle = `rgba(150,146,138,${0.25 + rng() * 0.45})`;
    g.lineWidth = 0.6 + rng() * 1.2;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(
      x + Math.cos(ang) * len * 0.5 + (rng() - 0.5) * 6,
      y + Math.sin(ang) * len * 0.5 + (rng() - 0.5) * 6,
      x + Math.cos(ang) * len,
      y + Math.sin(ang) * len,
    );
    g.stroke();
  }
  for (let i = 0; i < 26; i++) {
    const x = rng() * width;
    const y = headTop + rng() * (height - headTop);
    g.strokeStyle = `rgba(140,136,128,${0.3 + rng() * 0.3})`;
    g.lineWidth = 0.8;
    g.beginPath();
    g.arc(x, y, 1.5 + rng() * 3.5, 0, Math.PI * 2);
    g.stroke();
  }
  // fainter scars along the body
  for (let i = 0; i < 40; i++) {
    const x = rng() * width;
    const y = rng() * headTop;
    const len = 4 + rng() * 14;
    const ang = rng() * Math.PI;
    g.strokeStyle = `rgba(120,117,110,${0.12 + rng() * 0.2})`;
    g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.name = 'Whale.color';
  return tex;
}
