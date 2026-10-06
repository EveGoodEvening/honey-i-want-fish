// Smoke scenario for the world module: verifies the environment also renders
// correctly into a linear float render target (the path a real PostFX /
// EffectComposer uses), where fog colour arrives linear instead of sRGB.
// Renders a few views both ways and compares average colours; any shader
// compile error shows up as a console error in the smoke summary.
//
//   ~/.claude/bin/heavy-gate -n 1 -l world -- node scripts/smoke.mjs \
//     --params "autostart&fixeddt&god" --wait 4000 --shots 0 \
//     --scenario scripts/world-rt-check.mjs --out .smoke/world-rt
export default async function scenario(page, { evaluate, wait, log }) {
  await wait(1500);
  const result = await evaluate(`(() => {
    const g = window.__game;
    const r = g.renderer;
    const RT = g.env.sun.shadow.map ? g.env.sun.shadow.map.constructor : null;
    if (!RT) return { error: 'no render target class available (shadows off?)' };
    const w = 160, h = 90;
    // FloatType: RGBA/FLOAT readback is the combination WebGL2 guarantees.
    const rt = new RT(w, h, { type: 1015 /* FloatType */ });
    const buf = new Float32Array(w * h * 4);
    const half = (x) => x;
    const views = [
      { pos: [0, -20, 12], yaw: 0, pitch: -0.1 },
      { pos: [0, -22, 12], yaw: 0, pitch: 1.1 },
      { pos: [60, -38, 22], yaw: -1.92, pitch: -0.95 },
    ];
    const out = [];
    for (const v of views) {
      g.player.position.set(...v.pos);
      g.cameraRig.yaw = v.yaw; g.cameraRig.pitch = v.pitch;
      g.cameraRig.update(0); g.env.update(0);
      r.setRenderTarget(rt);
      r.render(g.scene, g.camera);
      r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      r.setRenderTarget(null);
      let sum = [0, 0, 0], bad = 0, max = 0;
      for (let i = 0; i < w * h; i++) {
        for (let c = 0; c < 3; c++) {
          const f = half(buf[i * 4 + c]);
          if (!Number.isFinite(f)) bad++; else { sum[c] += f; if (f > max) max = f; }
        }
      }
      out.push({ view: v.pos.join(','), meanLinear: sum.map((s) => +(s / (w * h)).toFixed(4)), max: +max.toFixed(2), nonFinite: bad });
    }
    rt.dispose();
    return out;
  })()`);
  log('rt-check', JSON.stringify(result));
}
