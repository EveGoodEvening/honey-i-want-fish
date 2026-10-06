// Smoke-test scenario for the enemies module: poses each shark type for
// close-up screenshots (side / front with the jaw open), the megalodon next to
// the player for scale, a telegraph pose and a dead shark sinking.
//
//   ~/.claude/bin/heavy-gate -n 1 -l enemies -- node scripts/smoke.mjs \
//       --params "autostart&fixeddt&god" --wait 4000 --shots 0 \
//       --scenario scripts/enemies-scenario.mjs --out .smoke/enemies/poses
//
// Set ENEMY_SHOTS to a comma-separated subset of shot names to run fewer.
const ONLY = (process.env.ENEMY_SHOTS ?? '').split(',').filter(Boolean);

export default async function scenario(page, { shot, wait, log }) {
  const want = (name) => ONLY.length === 0 || ONLY.includes(name);

  await page.evaluate(() => {
    const g = window.__game;
    g.cameraRig.update = () => {};
    g.enemies.clear();
    g.player.object3d.visible = false;
    const V = g.camera.position.constructor;
    window.__V = V;
    window.__pose = (shark, pose) => {
      Object.assign(shark.pose, pose);
      Object.assign(shark.poseT, pose);
    };
    window.__spawn = (type, pos, fwd, pose = {}) => {
      g.enemies.clear();
      const s = g.enemies.debugSpawn(type, { position: new V(...pos), forward: new V(...fwd), freeze: true });
      s.freezeSwim = true;
      s.pose.phase = 1.2;
      window.__pose(s, pose);
      return s;
    };
    window.__cam = (pos, look, fov = 62) => {
      g.camera.fov = fov;
      g.camera.updateProjectionMatrix();
      g.camera.position.set(...pos);
      g.camera.lookAt(new V(...look));
    };
  });

  const shotsFor = async (type, L, prefix) => {
    const y = -20;
    if (want(`${prefix}-side`)) {
      await page.evaluate(([t, yy]) => window.__spawn(t, [0, yy, 0], [1, 0, 0]), [type, y]);
      await page.evaluate(([LL, yy]) => window.__cam([-0.14 * LL, yy + 0.2 * LL, 1.0 * LL], [-0.14 * LL, yy + 0.02 * LL, 0]), [L, y]);
      await wait(1200);
      await shot(`${prefix}-side`);
    }
    if (want(`${prefix}-side-open`)) {
      await page.evaluate(([t, yy]) => window.__spawn(t, [0, yy, 0], [1, 0, 0], { jaw: 1, snout: 1, protrude: 1, eyeRoll: 1, pecDrop: 0.6 }), [type, y]);
      await page.evaluate(([LL, yy]) => window.__cam([0.32 * LL, yy, 0.42 * LL], [0.3 * LL, yy - 0.02 * LL, 0]), [L, y]);
      await wait(1200);
      await shot(`${prefix}-side-open`);
    }
    if (want(`${prefix}-front`)) {
      await page.evaluate(([t, yy]) => window.__spawn(t, [0, yy, 0], [0, 0, 1], { jaw: 1, snout: 1, protrude: 1, pecDrop: 0.4 }), [type, y]);
      await page.evaluate(([LL, yy]) => window.__cam([0.18 * LL, yy - 0.06 * LL, 0.95 * LL], [0, yy - 0.02 * LL, 0.2 * LL]), [L, y]);
      await wait(1200);
      await shot(`${prefix}-front`);
    }
  };

  await shotsFor('greatWhite', 6, 'gw');

  if (want('gw-side-flat')) {
    // Debug A/B: same side view with the skin normal map disabled.
    await page.evaluate(() => {
      const s = window.__spawn('greatWhite', [0, -20, 0], [1, 0, 0]);
      const m = s.mesh.material[0];
      window.__savedNormal = m.normalMap;
      m.normalMap = null;
      m.needsUpdate = true;
      window.__cam([-0.84, -18.8, 6], [-0.84, -19.88, 0]);
    });
    await wait(1200);
    await shot('gw-side-flat');
    await page.evaluate(() => {
      const m = window.__game.enemies.enemies[0].mesh.material[0];
      m.normalMap = window.__savedNormal;
      m.needsUpdate = true;
    });
  }
  await shotsFor('tiger', 4.5, 'tiger');
  await shotsFor('megalodon', 16, 'mega');

  if (want('gw-quarter')) {
    await page.evaluate(() => window.__spawn('greatWhite', [0, -20, 0], [1, 0, 0.3]));
    await page.evaluate(() => window.__cam([-4.5, -17.5, 4.5], [0.3, -20, 0]));
    await wait(1200);
    await shot('gw-quarter');
  }

  if (want('gw-telegraph')) {
    await page.evaluate(() => window.__spawn('greatWhite', [0, -20, 0], [1, 0, 0], { arch: 1, pecDrop: 1, jaw: 0.5, snout: 0.35, protrude: 0.2, headPitch: 0.05 }));
    await page.evaluate(() => window.__cam([0, -19.2, 6.4], [0, -19.8, 0]));
    await wait(1200);
    await shot('gw-telegraph');
  }

  if (want('mega-scale')) {
    await page.evaluate(() => {
      const g = window.__game;
      const s = window.__spawn('megalodon', [0, -22, 0], [1, 0, 0.15], { jaw: 0.35, pecDrop: 0.3 });
      g.player.object3d.visible = true;
      g.player.position.set(5, -19.5, 4.5);
      g.player.velocity.set(0, 0, 0);
      window.__cam([-2, -17, 22], [1, -20.5, 0]);
      return s.length;
    });
    await wait(1500);
    await shot('mega-scale');
    await page.evaluate(() => {
      window.__game.player.object3d.visible = false;
    });
  }

  if (want('gw-dead-settled')) {
    // Fast-forward the death sequence (simulation only) until it rests on the seabed.
    const info = await page.evaluate(() => {
      const g = window.__game;
      const s = window.__spawn('greatWhite', [0, -36, 0], [1, 0, 0.2]);
      s.freeze = false;
      s.freezeSwim = false;
      s.takeHit({ damage: 9999, part: 'gills', point: s.hurtboxes[2].center.clone(), direction: new window.__V(0, 1, 0) });
      let t = 0;
      while (t < 40 && s.state !== 'dead') {
        s.update(1 / 30);
        t += 1 / 30;
      }
      for (let k = 0; k < 90; k++) s.update(1 / 30); // let the roll finish
      const p = s.position;
      window.__cam([p.x + 2.5, p.y + 2.2, p.z + 6.5], [p.x - 0.6, p.y - 0.2, p.z]);
      return { state: s.state, t: +t.toFixed(1), y: +p.y.toFixed(2), roll: +s.pose.roll.toFixed(2) };
    });
    log('settled', JSON.stringify(info));
    await wait(1500);
    await shot('gw-dead-settled');
  }

  if (want('gw-dead')) {
    await page.evaluate(() => {
      const g = window.__game;
      const s = window.__spawn('greatWhite', [0, -24, 0], [1, 0, 0]);
      s.freeze = false;
      s.freezeSwim = false;
      s.takeHit({ damage: 9999, part: 'gills', point: s.hurtboxes[2].center.clone(), direction: new window.__V(0, 1, 0) });
      window.__cam([2, -25, 9], [0, -26.5, 0]);
    });
    await wait(5000);
    await page.evaluate(() => {
      const s = window.__game.enemies.enemies[0];
      window.__cam([s.position.x + 1, s.position.y + 1.5, s.position.z + 8], [s.position.x, s.position.y, s.position.z]);
    });
    await wait(800);
    const info = await page.evaluate(() => {
      const s = window.__game.enemies.enemies[0];
      return { state: s.state, y: +s.position.y.toFixed(2), roll: +s.pose.roll.toFixed(2), alive: s.alive };
    });
    log('dead shark', JSON.stringify(info));
    await shot('gw-dead');
  }
}
