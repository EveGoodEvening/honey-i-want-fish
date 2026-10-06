// Smoke scenario for the Environment ("world") module: frames the key views
// and takes one named screenshot each. Run through the heavy-gate:
//
//   ~/.claude/bin/heavy-gate -n 1 -l world -- node scripts/smoke.mjs \
//     --params "autostart&fixeddt&god" --wait 4000 --shots 0 \
//     --scenario scripts/world-scenario.mjs --out .smoke/world
//
// Optional env: WORLD_VIEWS=spawn,up,wreck (subset), WORLD_FRAMES=3 (frames to
// settle per view). It drives the camera through the CameraRig's yaw/pitch
// and moves the player, so it works with the stub and the real rig alike.
const VIEWS = {
  // Player spawn, looking forward (north).
  spawn: { pos: [0, -20, 12], yaw: 0, pitch: -0.1 },
  // Straight up at Snell's window.
  up: { pos: [0, -22, 12], yaw: 0, pitch: 1.1 },
  // Snell's window from near the seabed: still a dim blue disc, not gone.
  upDeep: { pos: [0, -41, 12], yaw: -0.35, pitch: 1.0 },
  // Toward the wreck, with the reef wall behind it.
  wreck: { pos: [-13, -40, -19], yaw: 0.78, pitch: -0.12 },
  // Close on the wreck's port side (net, tyres, registration).
  wreck2: { pos: [-22.6, -42.5, -28.4], yaw: 0.62, pitch: -0.18 },
  // Over the abyss edge, looking out and down.
  abyss: { pos: [60, -38, 22], yaw: -1.92, pitch: -0.95 },
  // Hanging over the void, looking back at the wall dropping into the dark.
  abyss2: { pos: [82.7, -55, 30.1], yaw: 1.22, pitch: -0.15 },
  // The wreck's bow with its faded registration.
  bow: { pos: [-21.6, -44.6, -32.9], yaw: 0.52, pitch: -0.05, hidePlayer: true },
  // Close to the seabed: caustics, sand ripples, grass.
  seabed: { pos: [4, -43.6, 6], yaw: 0.6, pitch: -0.55 },
  // Under the cliff, looking up the wall.
  cliff: { pos: [-14, -40, -46], yaw: 0.1, pitch: 0.35 },
  // Kelp forest silhouettes against the light.
  kelp: { pos: [-44, -42, -14], yaw: 1.2, pitch: 0.45 },
};

export default async function scenario(page, { shot, wait, evaluate, log }) {
  const pick = (process.env.WORLD_VIEWS || Object.keys(VIEWS).join(',') + ',title').split(',');
  const settle = Number(process.env.WORLD_FRAMES || 3);
  const waitFrames = async (n) => {
    const start = await evaluate('window.__game.time.frame');
    for (let i = 0; i < 600; i++) {
      await wait(100);
      const f = await evaluate('window.__game.time.frame');
      if (f - start >= n) return;
    }
  };
  for (const name of pick) {
    if (name === 'title') {
      await evaluate(`(() => { const g = window.__game; g.setState('title'); })()`);
      await waitFrames(settle);
      await shot('world-title');
      continue;
    }
    const v = VIEWS[name];
    if (!v) continue;
    await evaluate(`(() => {
      const g = window.__game;
      if (g.state !== 'playing') g.setState('playing');
      g.player.object3d.visible = ${!v.hidePlayer};
      g.player.position.set(${v.pos.join(',')});
      g.player.velocity?.set?.(0, 0, 0);
      g.cameraRig.yaw = ${v.yaw};
      g.cameraRig.pitch = ${v.pitch};
      for (const e of g.enemies?.enemies ?? []) e.position?.set?.(${v.pos[0] + 30}, ${v.pos[1]}, ${v.pos[2] - 30});
    })()`);
    await waitFrames(settle);
    await evaluate(`(() => {
      const g = window.__game;
      g.player.position.set(${v.pos.join(',')});
      g.cameraRig.yaw = ${v.yaw};
      g.cameraRig.pitch = ${v.pitch};
    })()`);
    await waitFrames(1);
    await shot(`world-${name}`);
    const info = await evaluate(`(() => { const g = window.__game; const c = g.camera.position; return { cam: [c.x, c.y, c.z].map(v => +v.toFixed(1)), calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles, fps: g.stats.fps }; })()`);
    log(name, JSON.stringify(info));
  }
}
