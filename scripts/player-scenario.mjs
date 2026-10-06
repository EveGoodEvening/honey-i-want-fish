// Player module test scenario for scripts/smoke.mjs (needs ?fixeddt&god).
//
//   ~/.claude/bin/heavy-gate -n 1 -l player -- node scripts/smoke.mjs \
//       --params "autostart&fixeddt&god" --wait 4000 --shots 0 \
//       --scenario scripts/player-scenario.mjs --out .smoke/player
//
// Stops the render loop and steps __game.frame() deterministically so every
// screenshot lands on a known animation phase: idle, breaststroke, sprint,
// the 3-hit combo, heavy charge + thrust, dodge, parry (+ its whiff recovery,
// and a fatigued whiff after mashing), hurt, grab + stab and death. Parry
// balance against real sharks: scripts/player-parry-scenario.mjs. Real enemies are parked; a minimal fake target (position, hurtboxes,
// getMouthPosition) is used as the lock-on target and as the grabber, so the
// scenario does not depend on the enemies module. Logs player state per shot
// and a count of player:* events and vfx.spawnBubbles calls at the end.
export default async (page, { shot, evaluate, log }) => {
  await evaluate(`(() => {
    const g = __game;
    g.renderer.setAnimationLoop(null);
    window.__counts = { bubbles: 0, bubbleParticles: 0 };
    const sb = g.vfx?.spawnBubbles?.bind(g.vfx);
    if (g.vfx) g.vfx.spawnBubbles = (pos, n, o) => {
      window.__counts.bubbles++;
      window.__counts.bubbleParticles += n;
      if (!Number.isFinite(pos.x + pos.y + pos.z)) window.__counts.badPos = true;
      return sb?.(pos, n, o);
    };
    const emit = g.events.emit.bind(g.events);
    g.events.emit = (name, payload) => {
      if (name.startsWith('player:')) {
        const key = name + (payload?.type ? ':' + payload.type : '') + (payload?.level !== undefined ? ':L' + payload.level : '') + (payload?.attempt ? ':attempt' : '') + (payload?.success ? ':success' : '');
        window.__counts[key] = (window.__counts[key] ?? 0) + 1;
      }
      return emit(name, payload);
    };
    g.cameraRig.update = () => {};
    for (const e of g.enemies?.enemies ?? []) { e.update = () => {}; e.position?.set(80, -20, 80); }
    const V = g.player.position.constructor;
    const target = {
      alive: true, name: 'dummy', position: new V(80, -20, 80), forward: new V(1, 0, 0), length: 5,
      hurtboxes: [
        { center: new V(), radius: 0.7, part: 'head' },
        { center: new V(), radius: 0.25, part: 'eye' },
        { center: new V(), radius: 1.0, part: 'body' },
      ],
      getMouthPosition() { return this.position.clone().addScaledVector(this.forward, 2.2); },
      place(d, side = 0) {
        const p = g.player; const h = p._heading;
        this.position.set(p.position.x + h.x * d - h.z * side, p.position.y + 0.2, p.position.z + h.z * d + h.x * side);
        this.forward.set(-h.x, 0, -h.z);
        this.hurtboxes[0].center.copy(this.position).addScaledVector(this.forward, 1.6);
        this.hurtboxes[1].center.copy(this.hurtboxes[0].center).setY(this.position.y + 0.35);
        this.hurtboxes[2].center.copy(this.position);
      },
      park() { this.position.set(80, -20, 80); for (const hb of this.hurtboxes) hb.center.copy(this.position); },
    };
    target.park();
    window.__target = target;
    window.__view = 'shoulder';
    window.__placeCam = () => {
      const p = g.player; const h = p._heading; const c = g.camera; const pos = p.position;
      if (window.__view === 'side') {
        c.position.set(pos.x - h.z * 3.4, pos.y + 0.3, pos.z + h.x * 3.4);
        c.lookAt(pos.x + h.x * 0.3, pos.y, pos.z + h.z * 0.3);
      } else if (window.__view === 'front') {
        c.position.set(pos.x + h.x * 3.2 + h.z * 1.0, pos.y + 0.5, pos.z + h.z * 3.2 - h.x * 1.0);
        c.lookAt(pos.x, pos.y + 0.1, pos.z);
      } else {
        c.position.set(pos.x - h.x * 3.0 - h.z * 0.75, pos.y + 0.75, pos.z - h.z * 3.0 + h.x * 0.75);
        c.lookAt(pos.x + h.x * 2.5, pos.y + 0.2, pos.z + h.z * 2.5);
      }
      c.fov = 55; c.updateProjectionMatrix();
    };
    window.__step = (n) => {
      for (let i = 0; i < n; i++) { window.__placeCam(); g.frame(); }
      window.__placeCam(); g.post.render(0);
      const p = g.player; const a = p.getActiveAttack();
      return { state: p.state, combo: p._combo, phase: p._phaseName, atk: a ? a.type + '#' + a.id + ' dmg ' + a.damage : null,
        prone: +p._prone.toFixed(2), speed: +p.velocity.length().toFixed(2), st: Math.round(p.stamina), hp: p.health,
        pos: p.position.toArray().map((v) => +v.toFixed(2)) };
    };
  })()`);
  const step = async (n, label) => {
    const r = await evaluate(`__step(${n})`);
    if (label) {
      log(label, JSON.stringify(r));
      await shot(label);
    }
    return r;
  };
  const sim = (a, on) => evaluate(`__game.input.simulate('${a}', ${on})`);
  const tap = async (a) => {
    await sim(a, true);
    await step(1);
    await sim(a, false);
  };
  const view = (v) => evaluate(`window.__view = '${v}'`);
  const lock = (on) => evaluate(`__game.cameraRig.lockTarget = ${on ? '__target' : 'null'}`);

  await step(40, 'a-idle');
  await view('side');
  await step(1, 'a-idle-side');
  await view('shoulder');

  // breaststroke, then sprint (dodge + keep holding dodge)
  await sim('forward', true);
  await step(80, 'b-swim1');
  await step(22, 'b-swim2');
  await view('side');
  await step(14, 'b-swim-side');
  await view('shoulder');
  await sim('dodge', true);
  await step(55, 'c-sprint');
  await view('side');
  await step(8, 'c-sprint-side');
  await view('shoulder');
  await sim('dodge', false);
  await sim('forward', false);
  await step(70);

  // 3-hit combo on a locked target ahead
  await evaluate('__target.place(3.4)');
  await lock(true);
  await step(5);
  await tap('attack');
  await view('front');
  await step(10, 'd-combo1');
  await tap('attack');
  await step(18, 'd-combo2');
  await tap('attack');
  await step(16, 'd-combo3');
  await view('side');
  await step(3, 'd-combo3-side');
  await view('shoulder');
  await step(40);

  // heavy: charge to level 3, release
  await evaluate('__target.place(4.2)');
  await sim('heavy', true);
  await step(100, 'e-charge');
  await view('side');
  await step(1, 'e-charge-side');
  await view('shoulder');
  await sim('heavy', false);
  await step(8, 'e-thrust');
  await view('side');
  await step(2, 'e-thrust-side');
  await step(50);

  // sideways dodge
  await lock(false);
  await evaluate('__target.park()');
  await step(20);
  await sim('right', true);
  await tap('dodge');
  await step(5, 'f-dodge1');
  await step(6, 'f-dodge2');
  await sim('right', false);
  await view('shoulder');
  await step(40);

  // parry; nothing arrives, so the window closes on a whiff: stamina cost,
  // whiff recovery (off-balance dip), spam fatigue
  await evaluate('__target.place(3.0)');
  await lock(true);
  await tap('parry');
  await step(5, 'g-parry');
  await view('side');
  await step(17, 'g-parry-whiff'); // window (18 frames) closed, mid whiff recovery
  await view('shoulder');
  await step(40);
  // mash: three more whiffs back to back build fatigue → shorter window, bigger dip
  for (let i = 0; i < 3; i++) {
    await tap('parry');
    await step(i < 2 ? 29 : 0);
  }
  log('g-parry-fatigued', JSON.stringify(await evaluate('({ win: +__game.player._parryWin.toFixed(3), fatigue: +__game.player._parryFatigue.toFixed(2), st: Math.round(__game.player.stamina) })')));
  await view('side');
  await step(Number(await evaluate('Math.round(__game.player._parryWin * 60) + 3')), 'g-parry-whiff-fatigued');
  await view('shoulder');
  await step(60);

  // hurt (heavy hit from the front)
  await evaluate(`(() => { const g = __game; g.debug.god = false; g.player.takeHit({ damage: 5, sourcePosition: __target.position.clone(), knockback: 5, heavy: true }); g.debug.god = true; })()`);
  await step(9, 'h-hurt');
  await step(50);

  // grabbed + stab
  await evaluate('__target.place(3.0)');
  await evaluate('__game.player.setGrabbed(__target)');
  await view('side');
  await step(20, 'i-grabbed');
  await tap('attack');
  await step(6, 'i-grabstab');
  await evaluate('__game.player.setGrabbed(null)');
  await lock(false);
  await view('shoulder');
  await step(60);

  // death: limp, sinking
  await evaluate(`(() => { const g = __game; g.debug.god = false; g.player.takeHit({ damage: 999, sourcePosition: __target.position.clone(), knockback: 2, heavy: true }); })()`);
  await view('side');
  await step(150, 'j-dead');
  log('counts', JSON.stringify(await evaluate('window.__counts')));
};
