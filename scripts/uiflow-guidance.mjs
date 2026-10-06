// First-time guidance and HUD layout checks for scripts/smoke.mjs (round 3:
// uiflow-r3-1 / uiflow-r3-2). Starts at the title (no autostart), plays the
// real intro and wave 0, then clears waves 0–1 to see their cards:
//
//   npx vite build
//   ~/.claude/bin/heavy-gate -n 1 -l uiflow -- node scripts/smoke.mjs --dist --step \
//     --params 'fixeddt&god&stats&quality=high' --wait 300 --shots 0 \
//     --scenario scripts/uiflow-guidance.mjs --out .smoke/uiflow-guidance
//
// Checks (one PASS / FAIL log line each, then "GUIDANCE OK" or "GUIDANCE FAIL: …"):
//   controls panel: the parry row says 蓄力中也可格挡 on one line, the grab row lists J,
//     the title block behind it is hidden; intro: the phone screen reads 老婆 / 来电,
//     lit while ringing, 通话中 once picked up; wave card: no HUD while the letterbox is
//     up (+0.1 / +0.5 s), the bar has cleared the player bars when the HUD fades in, the
//     card block stays clear of 老公 (waves 0–2); wave-0 tips list movement and stay
//     clear of the player bars; 「现在 —— E 格挡」 on the first two enemy:strike cues of
//     wave 0 (beside the reticle when locked) and never again; the QTE prompt lists
//     左键/J; 闪避 + 格挡 within 0.5 s don't overlap; 要害 at most once per 0.3 s.
//
// Harness notes (wall clock vs --step): CSS / WAAPI animations run on the wall
// clock while the test compresses game time, so
// - an animation created inside a long stepping evaluate gets a start time
//   from the frozen document timeline and can already be finished by the next
//   frame: the strike hint is pinned (paused + seeked) inside the same evaluate;
// - at the card, the intro's dip / veil lift / subtitles (11.6 s of game time
//   in ~1 s of wall time) are still running: they are finished before the card
//   shots, which pin only the HUD / letterbox / card animations;
// - paused opacity / transform animations live on the compositor: wait two
//   rAFs before a screenshot;
// - the phone is shot on the wall clock (the title → intro dip runs for real).

export default async function guidance(page, { shot, wait, evaluate, log }) {
  const fail = [];
  const check = (ok, what, extra) => {
    log(`${ok ? 'PASS' : 'FAIL'} ${what}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
    if (!ok) fail.push(what);
  };
  let outDir = null; // from the first shot's path, for the zoomed clips
  const snap = async (name) => {
    const file = await shot(name);
    outDir ??= file.slice(0, file.lastIndexOf('/'));
    return file;
  };
  const clip = (name, x, y, width, height) =>
    outDir ? page.screenshot({ path: `${outDir}/${name}.png`, clip: { x, y, width, height } }) : null;

  /** Step the game (rendering off) until `pred`; `after` runs in the same evaluate once it holds. */
  const until = async (pred, what, frames = 60 * 90, after = '') => {
    const ok = await page.evaluate(
      ({ pred, frames, after }) => {
        const g = window.__game;
        const holds = new Function(`return (${pred});`);
        const then = new Function(after);
        const test = () => (holds() ? (then(), true) : false);
        const render = g.post.render;
        g.post.render = () => g.scene.updateMatrixWorld();
        try {
          for (let i = 0; i < frames; i++) {
            if (test()) return true;
            g.frame();
          }
          return test();
        } finally {
          g.post.render = render;
        }
      },
      { pred, frames, after },
    );
    if (!ok) check(false, `reached ${what}`, await evaluate('__game.state'));
    return ok;
  };
  /** Pause the document animations under `sel` at `ms` of their own time. */
  const pin = async (ms, sel) => {
    await evaluate(`(() => {
      for (const a of document.getAnimations()) {
        if (!a.effect?.target?.closest?.(${JSON.stringify(sel)})) continue;
        a.pause();
        a.currentTime = ${ms};
      }
    })()`);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  const resume = () => evaluate(`document.getAnimations().forEach((a) => a.playState === 'paused' && a.play())`);
  const box = (sel) =>
    evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect();
      return r && { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }; })()`);
  const overlap = (a, b) => !!(a && b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b);
  /** 老公's body on screen, feet → head (CSS px). */
  const playerBody = () =>
    evaluate(`(() => {
      const g = __game;
      g.camera.updateMatrixWorld();
      const pts = [];
      for (const dy of [-0.9, -0.4, 0, 0.4, 0.8]) {
        const p = g.player.position.clone();
        p.y += dy;
        p.project(g.camera);
        pts.push([Math.round((p.x * 0.5 + 0.5) * innerWidth), Math.round((0.5 - p.y * 0.5) * innerHeight)]);
      }
      return pts;
    })()`);
  const cardClear = async (wave) => {
    const card = await evaluate(`[...document.querySelectorAll('.fish-card > *')].map((el) => Math.round(el.getBoundingClientRect().left))`);
    const pts = await playerBody();
    const left = Math.min(...card.filter((x) => x > 0));
    check(pts.every(([x]) => x < left - 20), `wave-${wave} card clear of 老公`, { cardLeft: left, playerBody: pts });
  };
  const killAll = () => evaluate(`for (const e of __game.enemies.enemies) { e.health = 0; e.alive = false; }`);

  await page.waitForFunction(() => window.__game?.state === 'title', null, { timeout: 60000 });
  await evaluate(`(() => {
    const g = __game;
    window.__gd = { strikes: 0, shows: 0, waves: [] };
    g.events.on('enemy:strike', () => { __gd.strikes++; __gd.waves.push(g.director.waveIndex); });
    const sh = g.ui.hud.strikeHint;
    const show = sh.show.bind(sh);
    sh.show = (e) => { __gd.shows++; return show(e); };
  })()`);

  // ------------------------------------------------------ controls panel
  await wait(4600); // title reveal (wall clock)
  await evaluate(`__game.ui.controls.open(__game.ui.title.menu)`);
  await wait(800);
  await snap('01-controls');
  const ctl = await evaluate(`(() => {
    const note = [...document.querySelectorAll('.fish-controls__note')].find((n) => n.textContent.includes('蓄力中也可格挡'));
    return { note: note?.textContent, h: note && Math.round(note.getBoundingClientRect().height),
      grab: [...document.querySelectorAll('.fish-controls__keys')].map((k) => k.textContent).find((t) => t.includes('狂按')),
      title: +getComputedStyle(document.querySelector('.fish-title__block')).opacity };
  })()`);
  check(!!ctl.note && ctl.h < 26, 'controls: parry note on one line incl. 蓄力中也可格挡', ctl);
  check(/J/.test(ctl.grab || ''), 'controls: grab row lists J', ctl.grab);
  check(ctl.title < 0.05, 'controls: title block hidden behind the panel', ctl.title);
  await evaluate(`__game.ui.controls.close()`);
  await wait(600);

  // --------------------------------------------------------------- intro
  await page.keyboard.press('Enter');
  await until(`__game.state === 'intro'`, 'the intro', 300);
  const t0 = Date.now();
  const phone = () =>
    evaluate(`({ who: document.querySelector('.fish-phone__who').textContent, screen: +getComputedStyle(document.querySelector('.fish-phone')).opacity,
      ring: +getComputedStyle(document.querySelector('.fish-phone__ring')).opacity, call: +getComputedStyle(document.querySelector('.fish-phone__call')).opacity })`);
  await wait(1250);
  const ringing = await phone();
  await page.screenshot({ path: `${outDir}/02-intro-phone.png` });
  await clip('02b-phone-zoom', 960, 380, 240, 240);
  check(ringing.screen > 0.95 && ringing.ring > 0.95, 'intro: phone lit while ringing', ringing);
  await wait(Math.max(0, 2900 - (Date.now() - t0)));
  const picked = await phone();
  await clip('03-phone-call', 960, 380, 240, 240);
  check(picked.ring < 0.05 && picked.call > 0.95 && picked.screen < 0.8, 'intro: picked up → 通话中, dimmer', picked);

  // ---------------------------------------- wave card + HUD vs letterbox
  await until(`__game.state === 'transition'`, 'the wave-0 card', 60 * 15);
  await evaluate(`(() => {
    for (const a of document.getAnimations()) {
      if (!a.effect?.target?.closest?.('.fish-fade, .fish-introveil, .fish-subs, .fish-location')) continue;
      try { a.finish(); } catch { a.cancel(); }
    }
  })()`);
  const lb = async (ms) => {
    await pin(ms, '.fish-hud, .fish-letterbox, .fish-card');
    return evaluate(`(() => {
      const bar = document.querySelector('.fish-letterbox__bar--bot');
      const m = getComputedStyle(bar).transform; // matrix(1, 0, 0, sy, 0, 0)
      const sy = m === 'none' ? 1 : +m.slice(7, -1).split(',')[3];
      return { hud: +getComputedStyle(document.querySelector('.fish-hud')).opacity, barTop: Math.round(innerHeight - bar.offsetHeight * sy),
        playerTop: Math.round(document.querySelector('.fish-player').getBoundingClientRect().top) };
    })()`);
  };
  const c01 = await lb(100);
  await snap('04-card+0.1');
  check(c01.hud < 0.01, 'card +0.1 s: no HUD under the letterbox', c01);
  const c05 = await lb(500);
  await snap('05-card+0.5');
  check(c05.hud < 0.01, 'card +0.5 s: HUD still hidden', c05);
  const c10 = await lb(1050);
  check(c10.hud < 0.01 || c10.barTop >= c10.playerTop + 10, 'card +1.05 s: bar clear of the player bars once the HUD shows', c10);
  const c30 = await lb(3000);
  await snap('06-card+3.0');
  check(c30.hud > 0.95, 'card +3.0 s: HUD on', c30);
  await cardClear(0);
  await resume();

  // ---------------------------------------------------------------- tips
  await until(`__game.state === 'playing'`, 'wave 0', 60 * 6);
  await until(`__game.ui.hud.tips.classList.contains('is-on')`, 'the tips', 10);
  await pin(1600, '.fish-hud');
  await snap('07-tips');
  const tips = { tips: await box('.fish-tips'), player: await box('.fish-player'), text: await evaluate(`document.querySelector('.fish-tips').textContent`) };
  check(/WASD/.test(tips.text) && /Space/.test(tips.text) && /上下/.test(tips.text), 'tips list movement', tips.text);
  check(!overlap(tips.tips, tips.player), 'tips clear of the player bars', tips);
  await resume();

  // ------------------------------------------- strike hint (wave 0, first two)
  const PIN_HINT = `const a = __game.ui.hud.strikeHint.anim; if (a) { a.pause(); a.currentTime = 260; }`;
  const hint = () =>
    evaluate(`(() => { const h = __game.ui.hud.strikeHint;
      return { shows: __gd.shows, on: h.el.classList.contains('is-on'), side: h.el.dataset.side, at: h.el.style.transform,
        reticle: !!__game.ui.hud.reticle.anchorFor(h.enemy, {}), op: +getComputedStyle(h.pop).opacity }; })()`);
  await evaluate(`__game.cameraRig.lockTarget = __game.enemies.enemies[0]`); // first cue: beside the reticle
  if (await until(`__gd.strikes >= 1`, 'strike cue 1', 60 * 120, PIN_HINT)) {
    await pin(260, '.fish-strikehint');
    await snap('08-strike-hint-1');
    const h1 = await hint();
    check(h1.shows === 1 && h1.on && h1.op > 0.9, 'strike cue 1: hint shown', h1);
    await resume();
  }
  await evaluate(`__game.cameraRig.lockTarget = null`);
  if (await until(`__gd.strikes >= 2`, 'strike cue 2', 60 * 120, PIN_HINT)) {
    await pin(260, '.fish-strikehint');
    await snap('09-strike-hint-2');
    const h2 = await hint();
    check(h2.shows === 2 && h2.on && h2.op > 0.9, 'strike cue 2: hint shown', h2);
    await resume();
  }
  await wait(1500); // the second hint runs out (wall clock)
  if (await until(`__gd.strikes >= 3`, 'strike cue 3', 60 * 120)) {
    const h3 = await evaluate(`({ shows: __gd.shows, active: __game.ui.hud.strikeHint.active })`);
    check(h3.shows === 2 && !h3.active, 'strike cue 3: no hint (first two only)', h3);
  }

  // ----------------------------------------------------------------- QTE
  await evaluate(`__game.combat.qte.start(__game.enemies.enemies[0])`);
  await until(`!!__game.combat.grab`, 'a grab', 5);
  await evaluate(`__game.frame(); __game.frame();`);
  await pin(400, '.fish-grab');
  await snap('10-qte');
  const qte = await evaluate(`document.querySelector('.fish-grab__text').textContent`);
  check(qte === '狂按 左键/J —— 刺它的眼！', 'QTE prompt lists 左键/J', qte);
  await resume();
  await evaluate(`__game.combat.qte.end?.(false, 'restart')`);
  await until(`!__game.combat.grab`, 'the grab end', 5);

  // ------------------------------------------------- centre words, 要害 cap
  await evaluate(`__game.events.emit('player:perfectDodge', { enemy: __game.enemies.enemies[0] })`);
  await wait(400);
  await evaluate(`__game.events.emit('player:parry', { success: true, enemy: __game.enemies.enemies[0] })`);
  await wait(90);
  const words = await evaluate(`__game.ui.hud.ctext.items.filter((it) => it.anim?.playState === 'running').map((it) => {
    it.anim.pause();
    const r = it.span.getBoundingClientRect();
    return { kind: it.kind, rate: it.anim.playbackRate, op: +getComputedStyle(it.span).opacity,
      box: { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) } };
  })`);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await snap('11-words');
  const seen = words.filter((w) => w.op > 0.05);
  const dodge = seen.find((w) => w.kind === 'dodge');
  const parry = seen.find((w) => w.kind === 'parry');
  check(!overlap(dodge?.box, parry?.box), '闪避 + 格挡 do not overlap', words);
  check(!dodge || dodge.rate > 1, 'a running 闪避 is hurried out by the 格挡', dodge);
  await resume();
  await wait(1300);
  const critLive = `__game.ui.hud.ctext.items.filter((it) => it.kind === 'crit' && it.anim?.playState === 'running').length`;
  const crit = `__game.events.emit('enemy:hit', { enemy: __game.enemies.enemies[0], damage: 1, part: 'eye',
    position: __game.enemies.enemies[0].position.clone(), critical: true, killed: false, attackType: 'light' })`;
  const burst = await evaluate(`(() => { ${crit}; ${crit}; ${crit}; return ${critLive}; })()`);
  await wait(350);
  const later = await evaluate(`(() => { ${crit}; return ${critLive}; })()`);
  check(burst === 1 && later === 2, '要害: at most one per 0.3 s', { burst, later });

  // --------------------------------------- later cards; no hint past wave 0
  await killAll();
  if (await until(`__game.state === 'transition'`, 'the wave-1 card', 60 * 12)) {
    await pin(3000, '.fish-hud, .fish-card');
    await snap('12-card-wave1');
    await cardClear(1);
    await resume();
  }
  await until(`__game.state === 'playing'`, 'wave 1', 60 * 6);
  const s0 = await evaluate('__gd.strikes');
  if (await until(`__gd.strikes > ${s0}`, 'a wave-1 strike cue', 60 * 60)) {
    const w1 = await evaluate(`({ shows: __gd.shows, waves: __gd.waves })`);
    check(w1.shows === 2, 'no strike hint in wave 1', w1);
  }
  await killAll();
  if (await until(`__game.state === 'transition'`, 'the boss card', 60 * 14)) {
    await pin(3000, '.fish-hud, .fish-card');
    await snap('13-card-boss');
    await cardClear(2);
    await resume();
  }

  log(fail.length ? `GUIDANCE FAIL: ${fail.join(' | ')}` : 'GUIDANCE OK');
  if (fail.length) throw new Error(`guidance: ${fail.length} check(s) failed`);
}
