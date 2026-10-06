// Audio module self-test, run as a smoke.mjs scenario (launches a browser, so
// ALWAYS through the gate, in the background):
//
//   ~/.claude/bin/heavy-gate -n 1 -l audio -- node scripts/smoke.mjs --dist --step \
//     --params 'autostart&fixeddt&god' --wait 3000 --shots 0 \
//     --scenario scripts/audio-scenario.mjs --out .smoke/audio > .smoke/audio.log 2>&1
//
// Works on the dev server and on the production build (--dist: the audio
// sources, which only import each other, are served straight from src/audio/)
// and with or without --step (frames are pumped when the render loop is off).
// The live phase stubs out rendering (scene + camera matrices are still
// updated, so the audio listener follows): on a software GL a single rendered
// frame can take 1-11 s (first-time shader compiles), which used to starve the
// waits. Waits poll the audio clock / game state with generous limits, and a
// wait never gives up before it has pumped at least a few frames.
//
// 1. Numeric: renders every public sound, the score in several modes/danger
//    levels, the ambience and a worst-case pile-up through OfflineAudioContext
//    (src/audio/offline.js) and asserts non-silent / finite / no clipping /
//    sane durations / danger changes the music. Throws on failure.
// 2. Visual: spectrogram sheets of the sounds (screenshots audio-*.png).
//    Includes the strike cue's swell at a hurt-dip cutoff (420 Hz) vs calm water
//    and a fatigued parry miss louder than a lone one.
// 3. Live: unlocks the real AudioContext, drives every game event + every
//    play() name, checks voices are cleaned up (no leaks) and nothing threw,
//    plus the engine's event logic: heavy-charge tiers, the strike cue (bite /
//    ram, eta clamp), parry press / miss (fatigue mirror), the held-telegraph
//    tail, a 4 s pause mid-wind-up (silent in the pause, picked up on resume),
//    one hurt grunt per frame, one bite on a grab start, heartbeats cancelled on
//    death, the death sting released by a retry, the intro dive on its cue.
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const SHEETS = [
  ['audio-player', ['slash', 'slashHeavy', 'heavyCharge', 'chargeTier', 'chargeReady', 'dodge', 'perfectDodge', 'parryRaise', 'parryMiss', 'parry', 'playerHurt', 'grabStab', 'grabBreak', 'grabStruggle']],
  ['audio-combat', ['fleshHit', 'critHit', 'bite', 'jawSnap', 'strike', 'lunge', 'telegraph', 'telegraphHold', 'ram', 'tail', 'tailHit', 'shockwave', 'roar', 'enemyDeath', 'thrash', 'swimBy', 'wake', 'killSting']],
  ['audio-world', ['bubbles', 'exhale', 'creak', 'deepBoom', 'whaleMoan', 'whaleSong', 'heartbeat', 'waveStart', 'waveClear', 'victory', 'death', 'phoneRing', 'phonePickup', 'diveSplash', 'diveBubbles', 'uiHover', 'uiClick', 'subtitleTick']],
];

const MUSIC_SHEET = [
  { label: 'music combat d=0', music: { mode: 'combat', danger: 0, seconds: 10 } },
  { label: 'music combat d=0.5', music: { mode: 'combat', danger: 0.5, seconds: 10 } },
  { label: 'music combat d=1', music: { mode: 'combat', danger: 1, seconds: 10 } },
  { label: 'music boss d=0.3', music: { mode: 'boss', danger: 0.3, seconds: 10 } },
  { label: 'music boss d=1 phase2', music: { mode: 'boss', danger: 1, phase: 2, seconds: 10 } },
  { label: 'music title', music: { mode: 'title', danger: 0, seconds: 14 }, seconds: 14 },
  { label: 'music breather', music: { mode: 'breather', danger: 0, seconds: 10 } },
  { label: 'music telegraph @3s', music: { mode: 'combat', danger: 0.6, telegraphAt: 3, seconds: 10 } },
  { label: 'ambience 12s', ambience: { seconds: 12 }, seconds: 12 },
];

export default async function audioScenario(page, { shot, wait, evaluate, log }) {
  // ---- 0. production build: serve the (dependency-free) audio sources ----
  const dev = await page.evaluate(() => !!document.querySelector('script[src*="@vite/client"]'));
  if (!dev) {
    await page.route('**/src/audio/*.js', (route) => {
      const file = resolve('src/audio', basename(new URL(route.request().url()).pathname));
      if (existsSync(file)) route.fulfill({ path: file, contentType: 'text/javascript' });
      else route.continue();
    });
  }

  // ---- 1. numeric self-test ----
  const report = await page.evaluate(async () => {
    const m = await import('/src/audio/offline.js');
    return m.runAudioSelfTest();
  });
  log(`audio self-test: ${Object.keys(report.sounds).length} sounds in ${report.ms} ms, failures: ${report.failures.length}`);
  for (const [name, a] of Object.entries(report.sounds)) {
    const swell = a.swellDb != null ? ` swell ${a.swellDb}dB` : '';
    log(`  sfx ${name.padEnd(13)} sched ${String(a.scheduled).padStart(6)}s pk ${String(a.peakDb).padStart(6)}dB loud ${String(a.loudestDb).padStart(6)}dB centroid ${String(a.centroid).padStart(5)}Hz <120 ${String(Math.round(100 * a.bands.sub)).padStart(3)}% span ${a.activeStart}-${a.activeEnd}s${swell}`);
  }
  for (const [name, a] of Object.entries(report.music)) {
    log(`  music ${name.padEnd(11)} pk ${a.peakDb}dB rms ${a.rmsDb}dB centroid ${a.centroid}Hz bands ${JSON.stringify(a.bands)}`);
  }
  if (report.ambience) log(`  ambience pk ${report.ambience.peakDb}dB rms ${report.ambience.rmsDb}dB centroid ${report.ambience.centroid}Hz`);
  if (report.stress) log(`  stress (master) pk ${report.stress.peak} rms ${report.stress.rmsDb}dB nan ${report.stress.nan}`);
  for (const f of report.failures) log(`  FAIL ${f}`);

  // ---- 2. spectrogram sheets ----
  for (const [file, names] of SHEETS) {
    await page.evaluate(async ({ names, file }) => {
      const m = await import('/src/audio/offline.js');
      document.querySelectorAll('canvas[data-audio-sheet]').forEach((c) => c.remove());
      await m.showSpectrogramSheet(names.map((name) => ({ name })), { title: file });
      document.body.lastElementChild.dataset.audioSheet = '1';
    }, { names, file });
    await shot(file);
  }
  await page.evaluate(async (items) => {
    const m = await import('/src/audio/offline.js');
    document.querySelectorAll('canvas[data-audio-sheet]').forEach((c) => c.remove());
    await m.showSpectrogramSheet(items, { cols: 3, panelW: 410, panelH: 150, title: 'audio-music' });
    document.body.lastElementChild.dataset.audioSheet = '1';
  }, MUSIC_SHEET);
  await shot('audio-music');
  await page.evaluate(() => document.querySelectorAll('canvas[data-audio-sheet]').forEach((c) => c.remove()));

  // ---- 3. live AudioContext ----
  const live = await page.evaluate(async () => {
    const g = window.__game;
    const a = g.audio;
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    // No rendering during the live phase: a first-time shader compile on a
    // software GPU can stall one frame for seconds. The matrices the audio
    // listener reads are still updated.
    const ownRender = g.post && Object.prototype.hasOwnProperty.call(g.post, 'render') ? g.post.render : null;
    if (g.post) {
      g.post.render = () => {
        g.scene?.updateMatrixWorld?.();
        g.camera?.updateMatrixWorld?.();
      };
    }
    const out = {};
    try {
      // With --step the render loop is off: pump frames ourselves while waiting
      // (1.5 s window, so one slow frame of a running loop isn't mistaken for it).
      const f0 = g.time.frame;
      await pause(1500);
      const stepped = g.time.frame === f0;
      out.stepped = stepped;
      const sleep = async (ms) => {
        if (!stepped) return pause(ms);
        const end = performance.now() + ms;
        do {
          g.frame();
          await pause(10);
        } while (performance.now() < end);
      };
      // Poll `cond` for up to `ms` of wall time, but never give up before at
      // least `minFrames` game frames have run (a stalled page can't fail it).
      const until = async (cond, ms, minFrames = 30) => {
        const end = performance.now() + ms;
        const fStart = g.time.frame;
        while (!cond() && (performance.now() < end || g.time.frame - fStart < minFrames)) await sleep(50);
        return cond();
      };
      const frames = async (n) => {
        const fStart = g.time.frame;
        while (g.time.frame - fStart < n) await sleep(stepped ? 0 : 20);
      };
      a.unlock();
      await sleep(800);
      out.afterUnlock = a.debugInfo();
      const e = g.enemies.enemies.find((x) => x.alive) ?? g.enemies.enemies[0];
      const ev = (n, p) => g.events.emit(n, p);
      // record pool.play calls (name, opts, voice) while `rec` is on
      const calls = [];
      let rec = false;
      const wrap = (pool) => {
        const orig = pool.play;
        pool.play = function (name, opts) {
          const v = orig.call(this, name, opts);
          if (rec) calls.push({ name, opts: opts ?? {}, v, t: a.ctx.currentTime });
          return v;
        };
        return () => (pool.play = orig);
      };
      const unwrap = [wrap(a.pool), wrap(a.musicPool)];
      const take = () => calls.splice(0, calls.length);

      // heavy charge with the Player's real tiers (0 → 1 → 2 → 3 at 0.4 / 0.9 /
      // 1.5 s, wall-clock spaced): the whine control must only rise, levels 1
      // and 2 tick, and the full glint comes with level 3 — never before.
      for (let attempt = 0; attempt < 2; attempt++) {
        const p = g.player;
        const pUpdate = Object.prototype.hasOwnProperty.call(p, 'update') ? p.update : null;
        const prevState = p.state;
        // hold the Player in 'heavyCharge' (nothing else may change it meanwhile)
        p.update = () => {};
        Object.defineProperty(p, 'state', { configurable: true, get: () => 'heavyCharge', set: () => {} });
        const t0 = performance.now();
        const ms = () => Math.round(performance.now() - t0);
        const log = { plays: [], ctl: [], events: [], attempt };
        const origPlay = a.pool.play;
        a.pool.play = function (name, opts) {
          const v = origPlay.call(this, name, opts);
          if (name === 'chargeReady' || name === 'chargeTier') log.plays.push([name, ms(), opts?.tier ?? null, !!v]);
          if (name === 'heavyCharge' && v?.ctl) {
            const set = v.ctl.set;
            v.ctl.set = (x, time) => {
              log.ctl.push(+x.toFixed(3));
              return set(x, time);
            };
          }
          return v;
        };
        try {
          for (const [level, at] of [[0, 0], [1, 400], [2, 900], [3, 1500]]) {
            await until(() => ms() >= at, at + 100, 0);
            log.events.push([level, ms()]);
            ev('player:heavyCharge', { level });
          }
          await sleep(400);
          log.gameState = g.state; // diagnostics: the whine only runs while 'playing'
          ev('player:attack', { type: 'heavy', combo: 1, level: 3 });
        } finally {
          a.pool.play = origPlay;
          delete p.state;
          p.state = prevState;
          if (pUpdate) p.update = pUpdate;
          else delete p.update;
        }
        out.charge = log;
        // retry once if the page stalled anyway (tier events < 300 ms apart)
        if (log.events.every((x, i) => i === 0 || x[1] - log.events[i - 1][1] >= 300)) break;
        await sleep(600);
      }

      // every event the engine listens to
      ev('cinematic', { name: 'intro' });
      ev('subtitle', { speaker: '老婆', text: '老公，我想吃鱼了。', duration: 2 });
      ev('subtitle', { speaker: '老公', text: '好嘞，晚饭交给我！', duration: 1 });
      ev('player:attack', { type: 'light', combo: 1 });
      ev('player:attack', { type: 'light', combo: 3 });
      ev('player:dodge', {});
      ev('player:parry', { attempt: true });
      if (e) {
        ev('enemy:spawn', { enemy: e });
        ev('enemy:telegraph', { enemy: e, type: 'bite', duration: 0.8 });
        ev('enemy:attack', { enemy: e, type: 'bite' });
        ev('player:parry', { success: true, enemy: e });
        ev('player:perfectDodge', { enemy: e });
        ev('enemy:hit', { enemy: e, damage: 10, part: 'body', position: e.position.clone(), critical: false, killed: false, attackType: 'light' });
        ev('enemy:hit', { enemy: e, damage: 30, part: 'eye', position: e.position.clone(), critical: true, killed: false, attackType: 'heavy' });
        ev('player:hit', { damage: 10, health: 90, sourcePosition: e.position.clone(), heavy: false });
        ev('grab:start', { enemy: e });
        ev('grab:progress', { value: 0.3 });
        ev('grab:progress', { value: 0.6 });
        ev('grab:end', { success: true, enemy: e });
        ev('enemy:attack', { enemy: e, type: 'tail' });
        ev('enemy:attack', { enemy: e, type: 'shockwave' });
        ev('enemy:roar', { enemy: e });
      }
      ev('ambient:whale', {});
      ev('wave:start', { index: 2, wave: { boss: true } });
      ev('wave:clear', { index: -1 }); // stale index: the Director ignores it (no breather / wave card mid-test)
      ev('game:victory', { stats: {} });
      ev('cinematic', { name: 'dive' });
      await sleep(1500);
      out.afterEvents = a.debugInfo();

      // ---- engine event logic (round-2 fixes) ----
      if (e) {
        // strike cue: one 'strike' per enemy:strike, bite and ram variants, eta
        // clamped to the possible contact range (0 → 0.17, 0.55 → 0.4)
        rec = true;
        ev('enemy:strike', { enemy: e, type: 'bite', eta: 0 });
        await sleep(150);
        ev('enemy:strike', { enemy: e, type: 'ram', eta: 0.32 });
        await sleep(150);
        ev('enemy:strike', { enemy: e, type: 'bite', eta: 0.55 });
        await frames(2);
        rec = false;
        out.strike = take()
          .filter((c) => c.name === 'strike' || c.name === 'jawSnap')
          .map((c) => ({ name: c.name, kind: c.opts.kind, eta: c.opts.eta, ok: !!c.v }));
        await sleep(600);

        // parry: a press → parryRaise; whiffs → parryMiss, its fatigue mirroring
        // Player's (1 → ≈2 → ≈3 back to back, back to 1 after a clean parry; a
        // `fatigue` the event carries is used as is)
        rec = true;
        ev('player:parry', { attempt: true });
        await frames(2);
        for (const p of [{}, {}, {}, { success: true, enemy: e }, {}, { fatigue: 2.5 }]) {
          ev('player:parry', p.success ? p : { whiff: true, ...p });
          await sleep(150);
        }
        rec = false;
        out.parry = take()
          .filter((c) => c.name.startsWith('parry'))
          .map((c) => [c.name, c.opts.fatigue != null ? +c.opts.fatigue.toFixed(2) : null, !!c.v]);
        await sleep(400);

        // several player:hit in one frame → one grunt, the heaviest; a grab
        // starting on the bite that just crunched → no second bite
        rec = true;
        ev('player:hit', { damage: 3.5, health: 80, sourcePosition: e.position.clone(), heavy: false });
        ev('player:hit', { damage: 25, health: 55, sourcePosition: e.position.clone(), heavy: true });
        await frames(2);
        out.hurt = take()
          .filter((c) => c.name === 'playerHurt')
          .map((c) => ({ heavy: !!c.opts.heavy, ok: !!c.v }));
        await sleep(400);
        ev('enemy:attack', { enemy: e, type: 'bite' }); // the hit below is this bite
        ev('player:hit', { damage: 20, health: 35, sourcePosition: e.position.clone(), heavy: false });
        ev('grab:start', { enemy: e });
        await frames(2);
        ev('grab:end', { success: false, enemy: e, interrupted: true, reason: 'restart' });
        rec = false;
        out.grabBite = take().filter((c) => c.name === 'bite').length;
        await sleep(400);

        // a wind-up held past its sting: 'telegraphHold' takes over (the sting
        // isn't released early) until the attack starts, which cuts both
        const eUpdate = Object.prototype.hasOwnProperty.call(e, 'update') ? e.update : null;
        const ai = e.ai;
        const prevAi = ai?.state;
        e.update = () => {}; // freeze the shark (its AI would leave 'telegraph')
        try {
          if (ai) ai.state = 'telegraph';
          e.state = 'telegraph';
          ev('enemy:telegraph', { enemy: e, type: 'bite', duration: 0.3 });
          const st = a._enemies.get(e);
          const tele = st?.tele;
          const teleEnd = st?.teleEnd ?? 0;
          // well past the sting's peak + plateau
          await until(() => a.ctx.currentTime > teleEnd + 0.5, 3000, 4);
          out.hold = {
            tele: !!tele,
            teleReleasedDuringWindUp: !!tele?.released,
            hold: !!st?.hold,
            holdLive: !!(st?.hold && !st.hold.released && !st.hold.ended),
            late: +(a.ctx.currentTime - teleEnd).toFixed(3),
          };
          const holdVoice = st?.hold;
          if (ai) ai.state = 'attack';
          e.state = 'attack';
          await frames(2);
          out.hold.releasedOnAttack = !!holdVoice?.released || !!holdVoice?.ended;
          out.hold.trackedAfterAttack = !!(st?.hold || st?.tele);
          await sleep(300);

          // paused 4 s mid-wind-up (longer than HOLD_MAX): nothing sounds under the
          // pause menu, and on resume the rest of the wind-up still does — a fresh
          // sting over what was left (early pause) or the held tail at once (late)
          out.pause = [];
          const level = (v) => {
            const an = a.ctx.createAnalyser();
            an.fftSize = 1024;
            v.out.connect(an);
            return () => {
              const b = new Float32Array(an.fftSize);
              an.getFloatTimeDomainData(b);
              let s = 0;
              for (let i = 0; i < b.length; i++) s += b[i] * b[i];
              return +(10 * Math.log10(s / b.length + 1e-12)).toFixed(1);
            };
          };
          for (const [label, at] of [['early', 0.25], ['late', 1.05]]) {
            if (ai) ai.state = 'telegraph';
            e.state = 'telegraph';
            ev('enemy:telegraph', { enemy: e, type: 'bite', duration: 0.9 });
            const st2 = a._enemies.get(e);
            const t0 = st2?.tele?.t0 ?? a.ctx.currentTime;
            await until(() => a.ctx.currentTime >= t0 + at, 3000, 2);
            const before = { tele: st2?.tele, hold: st2?.hold, cluster: st2?.cluster };
            const pausedAt = a.ctx.currentTime;
            g.setState('paused');
            await sleep(4000);
            const r = {
              label,
              pausedAfter: +(pausedAt - t0).toFixed(2),
              pausedFor: +(a.ctx.currentTime - pausedAt).toFixed(2),
              releasedInPause: [before.tele, before.hold, before.cluster].every((v) => !v || v.released || v.ended),
              liveInPause: !!(st2?.tele || st2?.hold),
              left: st2?.frozenLeft != null ? +st2.frozenLeft.toFixed(2) : null,
            };
            g.setState('playing');
            await frames(2);
            const v = st2?.tele ?? st2?.hold ?? null;
            r.resumed = v ? v.name : null;
            r.resumedDur = st2?.tele && st2.teleEnd != null ? +(st2.teleEnd - st2.tele.t0).toFixed(2) : null;
            if (v && !v.released && !v.ended) {
              const lv = level(v);
              await sleep(300);
              r.levelDb = lv();
            }
            out.pause.push(r);
            if (ai) ai.state = 'attack';
            e.state = 'attack';
            await frames(2);
            r.cutOnAttack = !!(v && (v.released || v.ended)) && !st2?.tele && !st2?.hold;
            await sleep(300);
          }
        } finally {
          if (ai) ai.state = prevAi === 'telegraph' || prevAi === 'attack' ? 'circle' : prevAi;
          e.state = ai?.state ?? 'circle';
          if (eUpdate) e.update = eUpdate;
          else delete e.update;
        }
        await sleep(300);
      }

      // every public play() name, positional where it makes sense
      const { SOUNDS, PUBLIC_SOUNDS: names } = await import('/src/audio/sfx.js');
      out.names = names.length;
      // sounds with a long retrigger guard were just fired by the events above
      out.guarded = names.filter((n) => SOUNDS[n].minInterval > 1).length;
      let played = 0;
      const dropped0 = a.pool.stats.dropped + a.musicPool.stats.dropped;
      for (const n of names) {
        const v = a.play(n, { position: g.player.position, follow: n === 'wake' || n === 'telegraphHold' ? e : undefined });
        if (v) played++;
        if (v?.loop) setTimeout(() => v.release(0.2), 600);
      }
      out.played = played;
      // firing every name at once exceeds the voice cap (24 on quality=low):
      // low-priority sounds are dropped by design
      out.droppedByCap = a.pool.stats.dropped + a.musicPool.stats.dropped - dropped0;
      out.unknownIgnored = a.play('no-such-sound') === null;
      // voice-cap / leak check: a storm of one-shots
      for (let i = 0; i < 200; i++) a.play(i % 2 ? 'bubbles' : 'fleshHit', { position: [Math.random() * 10, -20, Math.random() * 10], delay: i * 0.004 });
      await sleep(1200);
      out.duringStorm = a.debugInfo();
      // UI auto-hooks
      const b = document.createElement('button');
      b.textContent = 'test';
      b.style.cssText = 'position:fixed;left:10px;top:10px;pointer-events:auto';
      document.getElementById('ui-root').appendChild(b);
      b.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      b.click();
      b.remove();
      // pause duck + mute toggles
      const prev = g.state;
      g.setState('paused');
      await sleep(300);
      g.setState(prev);
      a.setMuted(true);
      await sleep(200);
      a.setMuted(false);
      // title → title music mode
      g.setState('title');
      await sleep(200);
      out.titleMode = a.mode;
      // heartbeats the score had scheduled ahead are cancelled on player:death
      // (emitted on the title screen, where the Director ignores it)
      // A quick retry (wave:start {retry}) releases the death sting and the
      // heartbeats after it — the ones not started yet never sound.
      {
        const hb = a.musicPool.play('heartbeat', { when: a.ctx.currentTime + 0.35, vel: 0.5, bpm: 100 });
        rec = true;
        ev('player:death', {});
        rec = false;
        out.deathHeartbeat = { scheduled: !!hb, released: !!hb?.released };
        const dv = take().filter((c) => (c.name === 'death' || c.name === 'heartbeat') && c.v).map((c) => c.v);
        await sleep(1000);
        const sting = dv.find((v) => v.name === 'death');
        const at = a.ctx.currentTime;
        const pending = dv.filter((v) => v.name === 'heartbeat' && v.t0 > at);
        const stingLive = !!sting && !sting.released && !sting.ended;
        ev('wave:start', { index: 0, wave: {}, retry: true });
        out.deathRetry = { voices: dv.length, stingLive, stingReleased: !!sting?.released, pending: pending.length, pendingReleased: pending.filter((v) => v.released).length };
        await sleep(300);
      }
      // intro: phone rings, is picked up on the first subtitle (after ≥ 1 ring
      // cycle), 老公 answers — and the splash waits for the Director's dive cue.
      g.setState('intro');
      ev('cinematic', { name: 'intro' });
      out.introRinging = !!a._intro.ring;
      out.introMode = a.mode;
      await sleep(400);
      ev('subtitle', { speaker: '老婆', text: '老公，我想吃鱼了。', duration: 2 });
      // pickup ≥ 2.1 s after the ring starts (audio clock, run from audio.update())
      out.introPickedUp = await until(() => !a._intro.ring, 8000);
      out.introStateAtAnswer = g.state;
      ev('subtitle', { speaker: '老公', text: '好嘞，晚饭交给我！', duration: 1 });
      await sleep(400);
      out.introDivedBeforeCue = a._intro.dived;
      rec = true;
      const cueAt = a.ctx.currentTime;
      ev('cinematic', { name: 'dive' });
      rec = false;
      const splash = take().find((c) => c.name === 'diveSplash');
      out.introDived = a._intro.dived;
      out.diveSplashLead = splash?.v ? +(splash.v.t0 - cueAt).toFixed(3) : null;
      // no dive cue at all: the game-clock fallback still takes him under,
      // ≈ duration + 1 s of game time after 老公's line
      g.setState('title');
      g.setState('intro');
      const fb0 = g.time.realElapsed;
      ev('subtitle', { speaker: '老公', text: '好嘞，晚饭交给我！', duration: 0.5 });
      out.fallbackDived = await until(() => a._intro.dived, 8000, 120);
      out.fallbackAfter = +(g.time.realElapsed - fb0).toFixed(3);
      g.setState(prev);
      await sleep(9000);
      out.settled = a.debugInfo();
      for (const u of unwrap) u();
    } finally {
      if (g.post) {
        if (ownRender) g.post.render = ownRender;
        else delete g.post.render;
      }
    }
    return out;
  });
  for (const [k, v] of Object.entries(live)) log(`live ${k}: ${JSON.stringify(v)}`);

  // Let the game run with live audio for a few frames of combat.
  await evaluate(`(() => { const g = __game; g.input.simulate('attack', true); setTimeout(() => g.input.simulate('attack', false), 300); })()`);
  await wait(1500);

  const problems = [...report.failures];
  if (!live.afterUnlock.ready) problems.push('live: not ready after unlock()');
  if (live.played + live.droppedByCap < live.names - live.guarded) {
    problems.push(`live: only ${live.played}/${live.names} names played (${live.guarded} retrigger-guarded, ${live.droppedByCap} dropped by the voice cap)`);
  }
  if (!live.unknownIgnored) problems.push('live: unknown name did not return null');
  if (live.titleMode !== 'title') problems.push(`live: title state gave music mode ${live.titleMode}`);
  if (!live.introRinging || live.introMode !== 'intro') problems.push('live: intro cinematic did not start the phone ring');
  if (!live.introPickedUp) problems.push('live: phone was not picked up after the first subtitle');
  if (live.introDivedBeforeCue) problems.push('live: dived on 老公\'s line, before the cinematic dive cue');
  if (!live.introDived) problems.push(`live: no dive on the cinematic dive cue (state at the answer: ${live.introStateAtAnswer})`);
  if (live.diveSplashLead == null || Math.abs(live.diveSplashLead) > 0.05) problems.push(`live: diveSplash not on the dive cue (t0 − cue = ${live.diveSplashLead} s)`);
  if (!live.fallbackDived) problems.push('live: no fallback dive when the cue never comes');
  else if (live.fallbackAfter < 1.4) problems.push(`live: fallback dive too early (${live.fallbackAfter} s of game time after the line)`);
  const ch = live.charge;
  const lvl3 = ch.events.find((x) => x[0] === 3)?.[1] ?? Infinity;
  if (!ch.events.every((x, i) => i === 0 || x[1] - ch.events[i - 1][1] >= 300)) problems.push(`live: page stalled during the charge test (events ${JSON.stringify(ch.events)})`);
  const ready = ch.plays.filter((x) => x[0] === 'chargeReady' && x[3]);
  const ticks = ch.plays.filter((x) => x[0] === 'chargeTier' && x[3]);
  if (ready.length !== 1) problems.push(`live: chargeReady played ${ready.length}× (want exactly 1) ${JSON.stringify(ch.plays)}`);
  else if (ready[0][1] < lvl3) problems.push(`live: chargeReady at ${ready[0][1]} ms, before level 3 (${lvl3} ms)`);
  if (ticks.length !== 2) problems.push(`live: chargeTier played ${ticks.length}× (want 2: levels 1 and 2)`);
  if (ch.ctl.some((x, i) => i > 0 && x < ch.ctl[i - 1] - 1e-6)) problems.push(`live: heavy-charge whine control fell back: ${JSON.stringify(ch.ctl)}`);
  if (!(ch.ctl.length && Math.max(...ch.ctl) >= 0.999)) problems.push(`live: heavy-charge whine never reached full (${ch.ctl.at(-1)}; game state ${ch.gameState})`);
  if (live.strike) {
    const got = live.strike.filter((x) => x.name === 'strike' && x.ok).map((x) => `${x.kind}@${x.eta}`).join(' ');
    if (got !== 'bite@0.17 ram@0.32 bite@0.4') problems.push(`live: enemy:strike cues ${JSON.stringify(live.strike)} (want 'strike' bite@0.17 ram@0.32 bite@0.4: one each, eta clamped)`);
    if (live.strike.some((x) => x.name === 'jawSnap')) problems.push('live: enemy:strike still plays jawSnap');
  }
  if (live.parry) {
    const P = live.parry;
    const names = P.map((x) => x[0]).join(' ');
    const f = P.filter((x) => x[0] === 'parryMiss').map((x) => x[1]);
    const ok =
      names === 'parryRaise parryMiss parryMiss parryMiss parry parryMiss parryMiss' &&
      P.every((x) => x[2]) &&
      Math.abs(f[0] - 1) < 0.05 && f[1] > f[0] + 0.7 && f[2] > f[1] + 0.7 && f[2] <= 3 &&
      Math.abs(f[3] - 1) < 0.05 && f[4] === 2.5;
    if (!ok) problems.push(`live: parry sounds ${JSON.stringify(P)} (want parryRaise, parryMiss with fatigue 1 → ≈2 → ≈3, parry, parryMiss 1, parryMiss 2.5)`);
  }
  for (const r of live.pause ?? []) {
    const want = r.label === 'early' ? 'telegraph' : 'telegraphHold';
    if (!(r.releasedInPause && !r.liveInPause && r.resumed === want && r.levelDb > -70 && r.cutOnAttack)) problems.push(`live: telegraph paused ${r.label} ${JSON.stringify(r)} (want silent in the pause, '${want}' sounding on resume, cut on attack)`);
    if (r.label === 'early' && !(Math.abs(r.resumedDur - r.left) < 0.02 && r.left > 0.5)) problems.push(`live: resumed sting ${r.resumedDur} s for ${r.left} s of wind-up left`);
  }
  const dr = live.deathRetry;
  if (!(dr && dr.voices === 4 && dr.stingLive && dr.stingReleased && dr.pending === 2 && dr.pendingReleased === 2)) problems.push(`live: death sting / heartbeats not released on a retry ${JSON.stringify(dr)}`);
  if (live.hurt && !(live.hurt.length === 1 && live.hurt[0].heavy && live.hurt[0].ok)) problems.push(`live: two player:hit in one frame gave ${JSON.stringify(live.hurt)} (want one heavy playerHurt)`);
  if (live.grabBite != null && live.grabBite !== 1) problems.push(`live: grab start on a bite hit played ${live.grabBite} bites (want 1)`);
  const h = live.hold;
  if (h && !(h.tele && !h.teleReleasedDuringWindUp && h.holdLive && h.releasedOnAttack && !h.trackedAfterAttack)) problems.push(`live: held telegraph ${JSON.stringify(h)}`);
  if (!(live.deathHeartbeat?.scheduled && live.deathHeartbeat.released)) problems.push(`live: heartbeat scheduled before player:death not cancelled ${JSON.stringify(live.deathHeartbeat)}`);
  if (live.settled.voices > 12) problems.push(`live: ${live.settled.voices} voices still alive after settling (leak?)`);
  if (live.duringStorm.activeVoices > live.duringStorm.maxVoices) problems.push(`live: voice cap exceeded (${live.duringStorm.activeVoices} > ${live.duringStorm.maxVoices})`);
  if (problems.length) throw new Error(`audio test failed:\n  ${problems.join('\n  ')}`);
  log('audio test: PASS');
}
