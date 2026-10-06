// Procedural "particulate in front of the lens" texture (tileable).
//   R channel: large, soft, out-of-focus bokeh discs (suspended matter close
//              to the camera) with a faint bright rim like real defocused motes
//   G channel: small, sharper specks and a few short smudges
// Built once on a canvas — no external assets.
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping } from 'three';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Draw a shape on all tile copies that it overlaps so the texture wraps.
function wrapped(size, x, y, r, draw) {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const cx = x + ox * size;
      const cy = y + oy * size;
      if (cx + r < 0 || cx - r > size || cy + r < 0 || cy - r > size) continue;
      draw(cx, cy);
    }
  }
}

function layer(size, rand, { count, rMin, rMax, rim, alphaMin, alphaMax, smudges = 0 }) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < count; i++) {
    const x = rand() * size;
    const y = rand() * size;
    // bias toward small radii
    const r = rMin + (rMax - rMin) * Math.pow(rand(), 2.2);
    const a = alphaMin + (alphaMax - alphaMin) * rand();
    wrapped(size, x, y, r, (cx, cy) => {
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      if (rim) {
        grad.addColorStop(0, `rgba(255,255,255,${a * 0.55})`);
        grad.addColorStop(0.72, `rgba(255,255,255,${a * 0.7})`);
        grad.addColorStop(0.88, `rgba(255,255,255,${a})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
      } else {
        grad.addColorStop(0, `rgba(255,255,255,${a})`);
        grad.addColorStop(0.5, `rgba(255,255,255,${a * 0.45})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
      }
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
    });
  }
  for (let i = 0; i < smudges; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = 6 + rand() * 18;
    const ang = rand() * Math.PI;
    const a = 0.05 + rand() * 0.08;
    wrapped(size, x, y, len, (cx, cy) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(ang);
      g.scale(1, 0.18);
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, len);
      grad.addColorStop(0, `rgba(255,255,255,${a})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(0, 0, len, 0, Math.PI * 2);
      g.fill();
      g.restore();
    });
  }
  return g.getImageData(0, 0, size, size).data;
}

export function createParticulateTexture(size = 256, seed = 1337) {
  const rand = mulberry32(seed);
  // big discs stay faint: they only light up looking toward the sun
  const big = layer(size, rand, { count: 26, rMin: 5, rMax: 22, rim: true, alphaMin: 0.06, alphaMax: 0.15 });
  const small = layer(size, rand, { count: 140, rMin: 0.8, rMax: 3.2, rim: false, alphaMin: 0.15, alphaMax: 0.7, smudges: 10 });

  const out = document.createElement('canvas');
  out.width = out.height = size;
  const g = out.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    img.data[i * 4 + 0] = big[i * 4];
    img.data[i * 4 + 1] = small[i * 4];
    img.data[i * 4 + 2] = 0;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);

  const tex = new CanvasTexture(out);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.name = 'PostFX.particulate';
  return tex;
}
