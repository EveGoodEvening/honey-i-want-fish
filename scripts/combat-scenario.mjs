// Smoke scenario for the combat module (CombatSystem + CameraRig + VFX).
// Run through the heavy-gate (it launches a browser), with --step so the
// simulation only advances through the scenario:
//
//   npx vite build && ~/.claude/bin/heavy-gate -n 1 -l combat -- node scripts/smoke.mjs --dist --step \
//     --params 'autostart&fixeddt&god' --wait 300 --shots 0 \
//     --scenario scripts/combat-scenario.mjs --out .smoke/combat
//
// Enemies are frozen in place and their hurtboxes / attack volumes are laid
// out by the scenario through the public contract (hurtboxes /
// getAttackVolumes), against the real Player: the eye-crit check first
// records a real light swing and puts the eye on that arc. Frames between
// screenshots run with rendering off (fast). Logs a `combat-results` JSON line
// with pass/fail per check.

export default async function combatScenario(page, { shot, log }) {
  // n simulation frames, rendering skipped (shots render their own frame)
  const frames = (n) => page.evaluate((n) => {
    const g = window.__game;
    const r = g.post.render;
    g.post.render = () => {};
    try {
      for (let i = 0; i < n; i++) g.frame();
    } finally {
      g.post.render = r;
    }
  }, n);
  const ev = (fn, arg) => page.evaluate(fn, arg);

  // ---- setup: event counters + helpers living in the page -----------------
  await ev(() => {
    const g = window.__game;
    const V = g.player.position.constructor;
    const T = window.__t = { V, counts: {}, last: {}, results: {} };
    for (const n of ['enemy:hit', 'player:parry', 'player:perfectDodge', 'grab:start', 'grab:end', 'grab:progress', 'player:hit']) {
      g.events.on(n, (p) => { T.counts[n] = (T.counts[n] || 0) + 1; T.last[n] = p; });
    }
    T.count = (n) => T.counts[n] || 0;
    // Freeze an enemy at pos facing fwd; hurtboxes are laid out like a shark:
    // eye/head at the front, body centre, tail behind (works for stub + real
    // enemies because we only touch contract fields).
    T.freeze = (e, pos, fwd) => {
      e.position.copy(pos);
      e.forward.copy(fwd).normalize();
      e.velocity.set(0, 0, 0);
      if (!e.__origUpdate) e.__origUpdate = e.update;
      if (!e.__origVols) e.__origVols = e.getAttackVolumes;
      const s = e.scaleFactor ?? 1;
      const lay = () => {
        e.object3d.lookAt(new V().copy(e.position).sub(e.forward));
        const hb = e.hurtboxes;
        for (const h of hb) {
          if (h.part === 'head') h.center.copy(e.position).addScaledVector(e.forward, 2.2 * s);
          else if (h.part === 'eye') { h.center.copy(e.position).addScaledVector(e.forward, 2.0 * s); h.center.y += 0.35 * s; }
          else if (h.part === 'body') h.center.copy(e.position);
          else if (h.part === 'tail') h.center.copy(e.position).addScaledVector(e.forward, -2.4 * s);
          else h.center.copy(e.position);
        }
      };
      e.update = () => lay();
      lay();
      T.vols = [];
      e.getAttackVolumes = () => T.vols;
    };
    T.enemy = g.enemies.enemies[0];
    // Records a light swing's knife segments (attack.base / tip per active frame).
    T.arc = [];
    T.recOrig = g.player.update.bind(g.player);
    T.record = (on) => {
      g.player.update = on ? (dt) => {
        T.recOrig(dt);
        const a = g.player.getActiveAttack();
        if (a) T.arc.push([a.base.clone(), a.tip.clone()]);
      } : T.recOrig;
    };
  });

  // ---- 1. light hit on the body (stub knife: x=-0.45, z 12.6 → 11.7) -------
  await ev(() => {
    const g = window.__game; const T = window.__t; const V = T.V;
    g.player.position.set(0, -20, 12);
    T.freeze(T.enemy, new V(-0.45, -20, 10.7), new V(1, 0, 0));
    T.h0 = T.enemy.health;
  });
  await frames(5);
  await ev(() => window.__game.input.simulate('attack', true));
  await frames(3);
  await ev(() => window.__game.input.simulate('attack', false));
  await frames(30);
  await ev(() => {
    const T = window.__t; const p = T.last['enemy:hit'];
    T.results.bodyHit = { pass: T.count('enemy:hit') === 1 && p?.part === 'body' && T.enemy.health < T.h0, part: p?.part, damage: p?.damage, crit: p?.critical };
  });
  await shot('c1-body-hit');

  // ---- 2. swept test: a blade that jumps across a fin between two frames ---
  await ev(() => {
    const g = window.__game; const T = window.__t; const V = T.V;
    T.freeze(T.enemy, new V(8, -20, 0), new V(0, 0, 1));
    // fin hurtbox sits at x=8; the blade moves from x=7 to x=9 in one frame
    const fin = T.enemy.hurtboxes.find((h) => h.part === 'body');
    T.fake = { id: 77001, type: 'light', damage: 12, base: new V(7, -20, -0.6), tip: new V(7, -20, 0.6), radius: 0.2, knockback: 1, hitEnemies: new Set() };
    T.origAtk = g.player.getActiveAttack.bind(g.player);
    g.player.getActiveAttack = () => T.fake;
    T.hitsBefore = T.count('enemy:hit');
    T.finR = fin.radius;
  });
  await frames(2);
  await ev(() => { const T = window.__t; T.fake.base.set(9.5, -20, -0.6); T.fake.tip.set(9.5, -20, 0.6); });
  await frames(2);
  await ev(() => {
    const g = window.__game; const T = window.__t;
    g.player.getActiveAttack = T.origAtk;
    T.results.sweep = { pass: T.count('enemy:hit') === T.hitsBefore + 1, part: T.last['enemy:hit']?.part };
  });

  // ---- 3. eye critical on the real swing arc --------------------------------
  // The eye is laid on the arc the real light swing sweeps (alone: a swing
  // registers one hit per enemy, so a bigger head sphere met earlier on the arc
  // would mask it). The soft aim turns the swing toward the eye, so the arc is
  // re-recorded with the eye in place and the eye moved onto it (≤ 3 tries).
  await ev(() => {
    const g = window.__game; const T = window.__t; const V = T.V;
    T.sep = g.combat._separate;
    g.combat._separate = () => {};
    // body far away; only the eye sits in front of 老公
    T.freeze(T.enemy, new V(0, -20, -30), new V(1, 0, 0));
    T.eyeAt = new V(0, -19.6, 10.9);
    T.layEye = () => {
      const e = T.enemy;
      e.update = () => {
        for (const h of e.hurtboxes) {
          if (h.part === 'eye') h.center.copy(T.eyeAt);
          else h.center.set(0, -20, -30);
        }
      };
      e.update();
    };
    T.layEye();
    T.eyeTries = [];
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await ev(() => {
      const g = window.__game; const T = window.__t;
      g.player.reset();
      g.cameraRig.yaw = 0; g.cameraRig.pitch = -0.05;
      T.hitsBefore = T.count('enemy:hit');
      T.arc.length = 0;
      T.record(true);
    });
    await frames(4);
    await ev(() => window.__game.input.simulate('attack', true));
    await frames(2);
    await ev(() => window.__game.input.simulate('attack', false));
    await frames(40);
    const r = await ev(() => {
      const g = window.__game; const T = window.__t; const p = T.last['enemy:hit'];
      T.record(false);
      const hit = T.count('enemy:hit') === T.hitsBefore + 1 && p?.part === 'eye' && p?.critical === true;
      // next try: the point of this swing's arc closest to the eye
      let best = null; let bestD = Infinity;
      const c = new T.V();
      for (const [b, t] of T.arc) {
        for (let k = 0; k <= 10; k++) {
          c.lerpVectors(b, t, 0.45 + 0.05 * k);
          const d = c.distanceTo(T.eyeAt);
          if (d < bestD) { bestD = d; best = c.clone(); }
        }
      }
      T.eyeTries.push({ hit, part: p?.part, frames: T.arc.length, miss: +bestD.toFixed(2) });
      if (!hit && best) { T.eyeAt.copy(best); T.layEye(); }
      return hit;
    });
    if (r) break;
    await frames(40); // let the combo window lapse
  }
  await ev(() => {
    const g = window.__game; const T = window.__t; const p = T.last['enemy:hit'];
    g.combat._separate = T.sep;
    T.results.eyeCrit = { pass: T.eyeTries.some((x) => x.hit), part: p?.part, damage: p?.damage, tries: T.eyeTries };
  });
  await frames(30);

  // ---- 4. heavy swing arc in front of the camera: knife trail + blood ------
  await ev(() => {
    const g = window.__game; const T = window.__t; const V = T.V;
    g.player.reset();
    g.player.position.set(0, -20, 12);
    g.cameraRig.yaw = 0; g.cameraRig.pitch = -0.08;
    T.freeze(T.enemy, new V(0.6, -20.1, 10.6), new V(1, 0, 0.15));
    const P = g.player;
    T.t0 = g.time.elapsed;
    T.fake = { id: 77002, type: 'heavy', damage: 28, base: new V(), tip: new V(), radius: 0.25, knockback: 3, hitEnemies: new Set() };
    const dur = 0.42;
    const place = () => {
      const k = Math.min(1, (g.time.elapsed - T.t0) / dur);
      const e = k * k * (3 - 2 * k);
      const ang = -1.5 + e * 3.0;
      const d = new V(Math.sin(ang), 0.25 - e * 0.5, -Math.cos(ang)).normalize();
      T.fake.base.copy(P.position).addScaledVector(d, 0.35); T.fake.base.y += 0.15;
      T.fake.tip.copy(P.position).addScaledVector(d, 1.45); T.fake.tip.y += 0.15;
    };
    place();
    T.origUpd = P.update.bind(P);
    P.update = (dt) => { T.origUpd(dt); place(); };
    P.getActiveAttack = () => (g.time.elapsed - T.t0 < dur ? T.fake : null);
  });
  await frames(14);
  await shot('c2-heavy-swing-mid');
  await frames(14);
  await shot('c3-heavy-swing-end');
  await frames(40);
  await shot('c4-after-swing');
  await ev(() => {
    const g = window.__game; const T = window.__t;
    g.player.update = T.origUpd; g.player.getActiveAttack = T.origAtk;
  });

  // ---- 5. parry: press parry, then a bite volume arrives -------------------
  await ev(() => {
    const g = window.__game; const T = window.__t; const V = T.V;
    T.freeze(T.enemy, new V(-4, -20, 12), new V(1, 0, 0));
    T.parryBefore = T.count('player:parry');
    g.input.simulate('parry', true);
  });
  await frames(2);
  await ev(() => {
    const g = window.__game; const T = window.__t; const V = T.V;
    g.input.simulate('parry', false);
    T.vols = [{ id: 501, center: new V().copy(g.player.position).add(new V(-0.9, 0, 0)), radius: 0.8, damage: 18, type: 'bite', canGrab: true, knockback: 6, parryable: true }];
  });
  await frames(3);
  await shot('c5-parry');
  await ev(() => {
    const T = window.__t;
    T.vols = [];
    const p = T.last['player:parry'];
    T.results.parry = { pass: T.count('player:parry') > T.parryBefore && p?.success === true && p?.enemy === T.enemy };
  });
  await frames(40);

  // ---- 6. perfect dodge: dodge, then a ram volume reaches you --------------
  await ev(() => {
    const g = window.__game; const T = window.__t;
    T.pdBefore = T.count('player:perfectDodge');
    g.input.simulate('dodge', true);
  });
  await frames(2);
  await ev(() => {
    const g = window.__game; const T = window.__t; const V = T.V;
    g.input.simulate('dodge', false);
    T.vols = [{ id: 502, center: new V().copy(g.player.position), radius: 1.0, damage: 20, type: 'ram', canGrab: false, knockback: 8, parryable: true }];
  });
  await frames(3);
  await ev(() => {
    const T = window.__t;
    T.vols = [];
    T.results.perfectDodge = { pass: T.count('player:perfectDodge') === T.pdBefore + 1 };
  });
  await frames(40);

  // ---- 7. hit → grab → mash to stab the eye --------------------------------
  await ev(() => {
    const g = window.__game; const T = window.__t; const V = T.V;
    g.debug.god = false;
    g.player.health = g.player.maxHealth;
    g.cameraRig.yaw = 0.9; g.cameraRig.pitch = -0.1;
    T.freeze(T.enemy, new V(-3, -20, 12.4), new V(1, 0, -0.15));
    T.hp0 = g.player.health; T.eh0 = T.enemy.health;
    T.grabBefore = T.count('grab:start');
    T.vols = [{ id: 503, center: new V().copy(g.player.position), radius: 0.9, damage: 18, type: 'bite', canGrab: true, knockback: 6, parryable: true }];
  });
  await frames(3);
  await ev(() => { const T = window.__t; T.vols = []; T.results.grabStart = { pass: T.count('grab:start') === T.grabBefore + 1 && !!window.__game.combat.grab }; });
  await frames(20);
  await shot('c6-grabbed');
  for (let i = 0; i < 16; i++) {
    await ev(() => window.__game.input.simulate('attack', true));
    await frames(2);
    await ev(() => window.__game.input.simulate('attack', false));
    await frames(2);
    const done = await ev(() => !window.__game.combat.grab);
    if (done) break;
  }
  await frames(4);
  await shot('c7-grab-escape');
  await ev(() => {
    const g = window.__game; const T = window.__t; const end = T.last['grab:end'];
    const hit = T.last['enemy:hit'];
    T.results.grabEscape = {
      pass: !g.combat.grab && end?.success === true && hit?.part === 'eye' && hit?.critical === true && T.enemy.health <= T.eh0 - 60 + 1e-6,
      playerHpLost: +(T.hp0 - g.player.health).toFixed(1), enemyHpLost: T.eh0 - T.enemy.health, progressEvents: T.count('grab:progress'),
    };
  });
  await frames(60);
  await shot('c8-escape-blood');

  // ---- 8. grab timeout: bite + every grinding tick + the fail bite ---------
  await ev(() => {
    const g = window.__game; const T = window.__t; const V = T.V;
    // fresh 老公: the escape above left a post-grab grace that slow-mo stretches
    g.player.reset();
    T.enemy.health = T.enemy.maxHealth; T.enemy.alive = true;
    T.hp0 = g.player.health;
    T.biteDmg = 10;
    T.vols = [{ id: 504, center: new V().copy(g.player.position), radius: 0.9, damage: T.biteDmg, type: 'bite', canGrab: true, knockback: 6, parryable: true }];
  });
  await frames(3);
  await ev(() => { window.__t.vols = []; });
  await frames(240);
  await ev(() => {
    const g = window.__game; const T = window.__t; const end = T.last['grab:end'];
    const hpLost = T.hp0 - g.player.health;
    // 7 ticks of 3.5 over 3.5 s; the fail bite = the enemy's grabDamage (GrabQTE fallback 25)
    const expect = T.biteDmg + 7 * 3.5 + (T.enemy.grabDamage ?? 25);
    T.results.grabTimeout = { pass: !g.combat.grab && end?.success === false && !end?.interrupted && hpLost >= expect - 0.5, hpLost: +hpLost.toFixed(1), expect };
    g.debug.god = true;
    g.player.health = g.player.maxHealth;
    g.player.alive = true;
    if (g.state !== 'playing') g.setState('playing');
  });

  // ---- 9. separation: shove the body onto the player -----------------------
  await ev(() => {
    const g = window.__game; const T = window.__t; const V = T.V;
    g.player.position.set(0, -20, 12);
    g.player.velocity.set(0, 0, 0);
    T.freeze(T.enemy, new V(0.2, -20, 12), new V(1, 0, 0));
  });
  await frames(3);
  await ev(() => {
    const g = window.__game; const T = window.__t;
    const body = T.enemy.hurtboxes.find((h) => h.part === 'body');
    const d = body.center.distanceTo(g.player.position);
    T.results.separation = { pass: d >= body.radius + g.player.radius - 0.02, dist: +d.toFixed(3) };
  });

  // ---- 10. lock-on ----------------------------------------------------------
  await ev(() => {
    const g = window.__game; const T = window.__t; const V = T.V;
    g.player.position.set(0, -20, 12);
    T.freeze(T.enemy, new V(10, -18, -2), new V(-1, 0, 0));
    g.cameraRig.yaw = 0; g.cameraRig.pitch = 0;
    g.cameraRig.lockTarget = null;
    g.input.simulate('lock', true);
  });
  await frames(2);
  await ev(() => window.__game.input.simulate('lock', false));
  await frames(90);
  await shot('c9-lock-on');
  await ev(() => {
    const g = window.__game; const T = window.__t;
    const cam = g.camera; const dir = new T.V(); cam.getWorldDirection(dir);
    const to = new T.V().subVectors(T.enemy.position, cam.position).normalize();
    T.results.lockOn = { pass: g.cameraRig.lockTarget === T.enemy && dir.dot(to) > 0.9, dot: +dir.dot(to).toFixed(3) };
    g.cameraRig.lockTarget = null;
  });

  // ---- 11. camera states (blend, no errors) --------------------------------
  const states = [['dead', 150], ['victory', 200], ['title', 200], ['intro', 300], ['playing', 120]];
  for (const [s, n] of states) {
    await ev((s) => window.__game.setState(s), s);
    await frames(20);
    await shot(`s-${s}-blend`);
    await frames(n);
    await shot(`s-${s}`);
  }

  const res = await ev(() => {
    const g = window.__game;
    return { results: window.__t.results, counts: window.__t.counts, vfx: { clouds: g.vfx.clouds.count, bubbles: g.vfx.bubbles.count, dust: g.vfx.dust.count }, errors: [...g._moduleErrors] };
  });
  log('combat-results', JSON.stringify(res));
}
