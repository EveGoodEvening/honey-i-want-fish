// Shared tuning constants. Every module reads from here instead of hard-coding
// world dimensions so the arena stays consistent. See docs/DESIGN.md.

export const WORLD = {
  surfaceY: 0, // water surface plane
  floorY: -46, // nominal seabed height (Environment adds relief around this)
  arenaRadius: 110, // soft horizontal boundary around the origin
  visibility: 55, // metres until things fade into murk (fog tuning target)
  playerSpawn: [0, -20, 12],
};

export const PLAYER = {
  maxHealth: 100,
  maxStamina: 100,
  swimSpeed: 4.2, // m/s cruising
  sprintSpeed: 6.5, // holding forward + dodge key after dash
  dodgeSpeed: 13,
  dodgeDuration: 0.38,
  dodgeIFrames: 0.3,
  dodgeCost: 22,
  heavyCost: 18,
  staminaRegen: 22, // per second
  parryWindow: 0.3, // seconds
  // Seconds from a parry press until the next one is accepted (a press inside it
  // is dropped — except the retry Player allows after one lone, unfatigued whiff
  // (PARRY_RETRY), so a single panicked press before the wind-up ends never
  // swallows the real press on the strike cue; round 2 had a 0.10-0.55 s dead
  // zone there, and at 1.2 s even a press 0.6 s early ate the bite, 0/6). Spam is
  // held back mainly by the whiff costs and spam fatigue in Player (no retry once
  // fatigued): 0.45 s (= window + whiff recovery) left a cooldown-paced masher at
  // ≈1.3× an idle player's survival against the tiger pair, 0.6 s ≈1.2×. A
  // successful parry clears it, so parry → riposte → parry flows. Balance:
  // scripts/core-parry-spam.mjs (browser), core-parry-sim.mjs (Node).
  parryCooldown: 0.6,
  parryWhiffStamina: 8, // stamina a parry costs when its window closes without a success
  radius: 0.45,
};

// Waves are played in order by the Director. EnemyManager.spawnWave(index)
// must understand every `type` listed here.
export const WAVES = [
  {
    id: 'white',
    title: '第一条鱼',
    subtitle: '大白鲨',
    intro: '水底下有东西在转圈。',
    enemies: [{ type: 'greatWhite' }],
  },
  {
    id: 'tigers',
    title: '第二条鱼',
    subtitle: '虎鲨群',
    intro: '血腥味引来了更多的。',
    enemies: [{ type: 'tiger' }, { type: 'tiger' }],
  },
  {
    id: 'mega',
    title: '最后一条鱼',
    subtitle: '巨齿鲨',
    intro: '这条，够吃一整年。',
    boss: true,
    enemies: [{ type: 'megalodon' }],
  },
];

// Damage multipliers per hurtbox part (CombatSystem applies these).
export const PART_MULTIPLIER = {
  eye: 3.0,
  gills: 2.0,
  head: 1.25,
  body: 1.0,
  fin: 0.8,
  tail: 0.7,
};

export const LAYERS = {
  default: 0,
};
