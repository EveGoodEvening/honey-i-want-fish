// Parry-spam balance check (PLAYER.parryCooldown / parryWindow / parryWhiffStamina and the
// whiff recovery + spam fatigue in src/player/Player.js). Launches Chromium, so run
// it through the gate:
//   npm run build
//   ~/.claude/bin/heavy-gate -n 1 -l core -- node scripts/smoke.mjs --dist --step \
//       --params 'autostart&fixeddt&god&quality=high' --wait 300 --shots 0 \
//       --scenario scripts/core-parry-spam.mjs --out .smoke/core-parry
// Per wave, from a fresh wave start with god off and the render skipped: an idle player and
// parry spammers that never attack (all of them mash out of grabs): `rhythm` presses every
// 0.4 s, `mash` every 2 frames (cooldown-paced), `patient` every 2 s (about the fastest fixed
// rhythm whose spam fatigue stays under the grace, so every window is full length).
// Math.random is seeded per run, so every bot meets the same spawns (the fights still
// diverge). Each run's death time is the real one, or 100 HP / damage rate when it outlives
// the cap. Logs one `RUN {…}` line per run and one `RESULT …` line per wave × bot: median
// death time and its ratio to idle (a single run varies ±30 % and 16-seed medians still move
// ±0.1× between runs — never tune on fewer). ≈2.5 s wall per 100 s of game time on lavapipe
// (high); 16 seeds × 3 bots ≈ 5 min per cooldown.
// Target: every bot ≤ 1.3× idle on every wave. Measured (lavapipe, high, 16 seeds), shipped
// parryCooldown 0.6 with the whiff costs, waves 0 / 1 / 2: rhythm 1.20 / 1.25 / 1.09×, mash
// 1.12 / 1.19 / 1.29× (second run 1.20 / 1.20 / 0.98×, 1.14 / 1.17 / 0.99×); `patient`
// (cooldown-independent) read 1.15–1.37× from run to run — the noise floor. At 0.45 the
// masher vs the tiger pair sat at 1.29 / 1.33× (two runs). History: no whiff costs → 3–5× at
// 0.4 s; round-2 fatigue + 0.6 s → mash up to 1.8× (8 seeds).
// Env:
//   PARRY_SEEDS  '1,2,…'        default 1..16
//   PARRY_SEC    cap in s        default 160
//   PARRY_BOTS   'name:every,…'  press parry every N frames; default 'rhythm:24,mash:2,patient:120'
//   PARRY_CD     'a,b,…'         cooldown overrides to compare with the shipped value
export default async (page, { log, evaluate }) => {
  // (the `evaluate` helper takes no argument: use page.evaluate(fn, arg) to pass one)
  const env = process.env;
  const seeds = (env.PARRY_SEEDS || '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16').split(',').map(Number);
  const sec = +(env.PARRY_SEC || 160);
  const bots = (env.PARRY_BOTS || 'rhythm:24,mash:2,patient:120').split(',').map((s) => {
    const [name, every] = s.split(':');
    return { name, every: +every };
  });
  const cds = [null, ...(env.PARRY_CD ? env.PARRY_CD.split(',').map(Number) : [])];

  await evaluate(() => {
    const g = window.__game;
    const rnd0 = Math.random;
    // mulberry32
    const seed = (s) => {
      let a = s >>> 0;
      Math.random = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const tap = (a) => {
      g.input.simulate(a, true);
      g.input.simulate(a, false);
    };
    // One run: `every` = 0 is the idle player; `cd` overrides the parry cooldown (null = shipped).
    window.__parrySpam = (wave, every, cd, s, seconds) => {
      seed(s);
      const P = g.player;
      const ownTry = Object.prototype.hasOwnProperty.call(P, '_tryParry');
      const tryParry = P._tryParry;
      const render = g.post.render;
      const god = g.debug.god;
      const counts = { parried: 0, attacks: 0, hits: 0, grabs: 0 };
      const offs = [
        g.events.on('player:parry', (e) => { if (e?.success) counts.parried++; }),
        g.events.on('enemy:attack', () => counts.attacks++),
        g.events.on('player:hit', () => counts.hits++),
        g.events.on('grab:start', () => counts.grabs++),
      ];
      try {
        g.combat?.qte?.end?.(false, 'test');
        g.debug.god = false;
        P.reset();
        if (g.cameraRig) g.cameraRig.lockTarget = null;
        g.director.beginWave(wave, { immediate: true });
        for (const a of [...g.input.down]) g.input.simulate(a, false);
        if (cd !== null) {
          P._tryParry = function () {
            const ok = tryParry.call(this);
            if (ok) this._parryCooldown = cd;
            return ok;
          };
        }
        g.post.render = () => g.scene.updateMatrixWorld();
        const t0 = g.time.elapsed;
        let deathAt = null;
        let k = 0;
        let m = 0;
        for (let i = 0; i < seconds * 60; i++) {
          if (g.combat.grab) {
            if (++m % 4 === 0) tap('attack');
          } else if (every > 0 && ++k % every === 0) tap('parry');
          g.frame();
          if (!P.alive) {
            deathAt = g.time.elapsed - t0;
            break;
          }
        }
        const dur = g.time.elapsed - t0;
        const lost = 100 - Math.max(0, P.health);
        const est = deathAt ?? (lost > 0 ? (dur * 100) / lost : 999);
        return { wave, every, cd, seed: s, deathAt: deathAt === null ? null : +deathAt.toFixed(1), est: +Math.min(999, est).toFixed(1), hp: +P.health.toFixed(1), ...counts };
      } finally {
        for (const off of offs) off?.();
        g.post.render = render;
        if (ownTry) P._tryParry = tryParry;
        else delete P._tryParry;
        Math.random = rnd0;
        g.debug.god = god;
      }
    };
  });

  const rows = [];
  for (const s of seeds) {
    for (const wave of [0, 1, 2]) {
      const run = async (bot, every, cd) => {
        const r = await page.evaluate(([w, e, c, sd, sc]) => window.__parrySpam(w, e, c, sd, sc), [wave, every, cd, s, sec]);
        r.bot = bot;
        rows.push(r);
        log(`RUN ${JSON.stringify(r)}`);
      };
      await run('idle', 0, null);
      for (const b of bots) for (const cd of cds) await run(b.name, b.every, cd);
    }
  }

  const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  for (const wave of [0, 1, 2]) {
    const idle = median(rows.filter((r) => r.wave === wave && r.bot === 'idle').map((r) => r.est));
    log(`RESULT wave ${wave} idle: median death ${idle.toFixed(1)} s (n ${seeds.length})`);
    for (const b of bots) {
      for (const cd of cds) {
        const g = rows.filter((r) => r.wave === wave && r.bot === b.name && r.cd === cd);
        const med = median(g.map((r) => r.est));
        const atk = g.reduce((n, r) => n + r.attacks, 0);
        const par = g.reduce((n, r) => n + r.parried, 0);
        log(
          `RESULT wave ${wave} ${b.name} (every ${b.every} f, cooldown ${cd ?? 'shipped'}): median death ${med.toFixed(1)} s = ` +
            `${(med / idle).toFixed(2)}× idle, parried ${par}/${atk} attacks, died ${g.filter((r) => r.deathAt !== null).length}/${g.length}`,
        );
      }
    }
  }
};
