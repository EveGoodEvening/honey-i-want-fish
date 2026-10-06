// CombatSystem — see docs/DESIGN.md "CombatSystem".
//
// Each frame while game.state === 'playing':
//  1. player knife vs enemy hurtboxes — swept: the blade segment of this frame
//     plus interpolated segments between last frame's and this frame's blade,
//     so fast swings cannot tunnel through a fin at low fps. Once per attack id
//     per enemy; the best-multiplier part touched wins.
//  2. enemy attack volumes vs the player hurtbox — once per volume id:
//     parry → perfect dodge → hit (→ grab QTE for biting volumes). A parryable
//     attack about to arrive (≈0.25 s out) emits `enemy:strike {enemy, type,
//     eta}` once — the "now" cue the HUD / audio flash for parry timing. The
//     timing comes from the enemy's `getStrikeCue()` forecast when it has one
//     (sharks: their bite / ram volume goes live only after the cue), else
//     from a live volume's gap and the enemy's speed.
//  3. grab QTE (GrabQTE.js).
//  4. soft body separation (sharks are far heavier than 老公). The megalodon's
//     bow wave is applied by the Enemy module (Shark._wake).
// Feedback (hitstop, trauma, blood, impacts) scales with damage. Combat owns
// hit blood (Shark.takeHit does not spawn any). PostFX pulses itself from
// enemy:hit / enemy:death / player:parry / player:perfectDodge / grab:start,
// so those are not pulsed here (a second pulse would re-centre its rings).
import * as THREE from 'three';
import { PART_MULTIPLIER, PLAYER, WORLD } from '../core/config.js';
import { closestOnSegment, VolumeLedger } from './hitTests.js';
import { GrabQTE } from './GrabQTE.js';

const EMPTY = [];
/**
 * enemy:strike goes out when a parryable attack is this many seconds from
 * contact. A shark's volume goes live only SharkAI STRIKE_LEAD (0.22 s) after
 * the cue, so the cue leads contact by 0.22–0.32 s: reactable, not a guess.
 */
const STRIKE_ETA = 0.32;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _hitPt = new THREE.Vector3();
const _n = new THREE.Vector3();
const _slash = new THREE.Vector3();
const _v = new THREE.Vector3();
const _contact = new THREE.Vector3();

export class CombatSystem {
  constructor(game) {
    this.game = game;
    /** null | { enemy, progress: 0..1, timeLeft } */
    this.grab = null;
    this.qte = new GrabQTE(this);

    this._hitLedger = new VolumeLedger();
    this._dodgeLedger = new VolumeLedger();
    this._strikeLedger = new VolumeLedger();
    this._prevBase = new THREE.Vector3();
    this._prevTip = new THREE.Vector3();
    this._prevId = null;
    this._hasPrev = false;
    this._bumpCooldown = 0;
    this._dodgeAt = -Infinity;

    // Dodge start time: perfect-dodge detection does not depend on the Player
    // reporting state === 'dodge' (it may use its own state names).
    game.events.on('player:dodge', () => {
      this._dodgeAt = game.time.elapsed;
    });

    // A grab must end cleanly whenever play stops (death, wave transition,
    // victory, back to title). Pausing keeps it.
    game.events.on('game:state', ({ to }) => {
      if (this.grab && to !== 'playing' && to !== 'paused') this.qte.end(false, 'state');
      if (to !== 'playing') this._hasPrev = false;
    });
  }

  update(dt) {
    const game = this.game;
    if (game.state !== 'playing') {
      if (this.grab && game.state !== 'paused') this.qte.end(false, 'state');
      this._hasPrev = false;
      return;
    }
    const player = game.player;
    if (!player) return;
    this._bumpCooldown -= dt;

    this._playerAttacks(player);
    this._enemyAttacks(player);
    this.qte.update(dt);
    if (!this.grab) {
      this._separate(player);
      // The megalodon's bow wave is applied by Shark._wake (tuned per species).
    }
  }

  // ---------------------------------------------------------------------------
  // Player → enemies
  // ---------------------------------------------------------------------------

  _playerAttacks(player) {
    const atk = player.getActiveAttack?.();
    if (!atk || !atk.base || !atk.tip || atk.tip.distanceToSquared(atk.base) < 1e-6) {
      this._hasPrev = false;
      return;
    }
    // While held in the jaws the QTE owns the knife.
    if (this.grab && atk.type === 'grabStab') {
      this._storePrev(atk);
      return;
    }

    const usePrev = this._hasPrev && this._prevId === atk.id;
    let steps = 0;
    if (usePrev) {
      const moved = Math.max(this._prevBase.distanceTo(atk.base), this._prevTip.distanceTo(atk.tip));
      steps = Math.min(10, Math.max(1, Math.ceil(moved / Math.max(0.08, (atk.radius ?? 0.2) * 1.2))));
    }
    const enemies = this.game.enemies?.enemies ?? EMPTY;
    const sweep = atk.radius ?? 0.2;

    for (let e = 0; e < enemies.length; e++) {
      const enemy = enemies[e];
      if (!enemy?.alive || !enemy.hurtboxes || atk.hitEnemies?.has(enemy)) continue;
      let bestHb = null;
      let bestMult = -1;
      let bestPen = -Infinity;
      // with a previous blade, k = 0 would be last frame's (already tested) segment
      for (let k = usePrev ? 1 : 0; k <= steps; k++) {
        // k = steps is the current blade; earlier k sweep from last frame's blade
        const s = steps === 0 ? 1 : k / steps;
        if (usePrev && s < 1) {
          _a.lerpVectors(this._prevBase, atk.base, s);
          _b.lerpVectors(this._prevTip, atk.tip, s);
        } else {
          _a.copy(atk.base);
          _b.copy(atk.tip);
        }
        const hbs = enemy.hurtboxes;
        for (let h = 0; h < hbs.length; h++) {
          const hb = hbs[h];
          const rr = hb.radius + sweep;
          const d2 = closestOnSegment(_c, _a, _b, hb.center);
          if (d2 > rr * rr) continue;
          const mult = PART_MULTIPLIER[hb.part] ?? 1;
          const pen = rr - Math.sqrt(d2);
          if (mult > bestMult || (mult === bestMult && pen > bestPen)) {
            bestMult = mult;
            bestPen = pen;
            bestHb = hb;
            _hitPt.copy(_c);
          }
        }
      }
      if (bestHb) this._applyHit(enemy, atk, bestHb, bestMult, usePrev);
    }
    this._storePrev(atk);
  }

  _storePrev(atk) {
    this._prevBase.copy(atk.base);
    this._prevTip.copy(atk.tip);
    this._prevId = atk.id;
    this._hasPrev = true;
  }

  _applyHit(enemy, atk, hb, mult, usePrev) {
    const game = this.game;
    atk.hitEnemies?.add(enemy);

    // slash direction: how the tip travelled; a pure thrust uses the blade axis
    if (usePrev) _slash.subVectors(atk.tip, this._prevTip);
    else _slash.set(0, 0, 0);
    if (_slash.lengthSq() < 1e-6) _slash.subVectors(atk.tip, atk.base);
    _slash.normalize();

    // put the wound on the skin, not at the sphere centre
    _n.subVectors(_hitPt, hb.center);
    let len = _n.length();
    if (len < 1e-4) {
      _n.copy(_slash).negate();
      len = 0;
    }
    _n.normalize();
    const point = new THREE.Vector3().copy(hb.center).addScaledVector(_n, Math.min(Math.max(len, hb.radius * 0.85), hb.radius));

    const damage = Math.round(atk.damage * mult);
    const critical = mult >= 2;
    enemy.object3d?.updateWorldMatrix?.(true, false);
    const res = enemy.takeHit?.({ damage, part: hb.part, point: point.clone(), direction: _slash.clone(), attackType: atk.type });
    const dealt = res?.damage ?? damage;
    const killed = !!res?.killed || !enemy.alive;
    game.events.emit('enemy:hit', {
      enemy, damage: dealt, part: hb.part, position: point.clone(), critical, killed, attackType: atk.type,
    });

    // ---- feedback, scaled by how hard the hit was ----
    const s = Math.min(1, dealt / 60);
    const heavy = atk.type === 'heavy';
    let stop = 0.04 + 0.1 * s + (critical ? 0.03 : 0) + (heavy ? 0.02 : 0);
    if (killed) stop = 0.16;
    game.hitstop(Math.min(0.16, stop));
    game.cameraRig?.addTrauma?.(Math.min(0.9, 0.12 + 0.35 * s + (critical ? 0.1 : 0) + (killed ? 0.3 : 0)));

    // one burst per landed blow; a kill adds only the Enemy's own mouth gush
    const amount = Math.min(2.2, (0.4 + 1.0 * s) * (critical ? 1.4 : 1));
    _v.copy(_slash).multiplyScalar(0.7).addScaledVector(_n, 0.55);
    const vfx = game.vfx;
    vfx?.spawnBlood?.(point, _v, amount);
    vfx?.spawnImpact?.(point, _n, { strength: 0.4 + s * 1.2 });
    vfx?.addWound?.(enemy, point, { duration: 5 + s * 8 + (killed ? 8 : 0), rate: 4 + s * 8, size: 0.8 + s * 0.6 });

    if (killed) {
      const last = (game.enemies?.enemies ?? EMPTY).every((x) => !x.alive);
      game.slowmo(last ? 1.5 : 0.55, last ? 0.2 : 0.35);
    }
  }

  // ---------------------------------------------------------------------------
  // Enemies → player
  // ---------------------------------------------------------------------------

  _enemyAttacks(player) {
    const game = this.game;
    if (!player.alive || !player.hurtbox) return;
    const ph = player.hurtbox;
    const enemies = game.enemies?.enemies ?? EMPTY;
    const recentDodge = game.time.elapsed - this._dodgeAt <= (PLAYER.dodgeDuration ?? 0.4) + 0.05;
    const dodging = (player.state === 'dodge' || recentDodge) && !!player.isInvulnerable?.();

    for (let e = 0; e < enemies.length; e++) {
      const enemy = enemies[e];
      if (!enemy?.alive) continue;
      if (this.grab && this.grab.enemy === enemy) continue;
      // "Now" cue from the enemy's own forecast (sharks know their lunge; their
      // bite / ram volume goes live only after this cue, so it always leads).
      if (!this.grab && typeof enemy.getStrikeCue === 'function') {
        const fc = enemy.getStrikeCue();
        if (fc && fc.eta <= STRIKE_ETA && !this._strikeLedger.has(enemy, fc.id)) {
          this._strikeLedger.add(enemy, fc.id);
          game.events.emit('enemy:strike', { enemy, type: fc.type, eta: Math.max(0, fc.eta) });
        }
      }
      const vols = enemy.getAttackVolumes?.() ?? EMPTY;
      for (let i = 0; i < vols.length; i++) {
        const vol = vols[i];
        if (!vol?.center) continue;
        const vid = vol.id ?? vol; // ids are only unique per enemy; fall back to identity
        if (this._hitLedger.has(enemy, vid)) continue;
        const d = vol.center.distanceTo(ph.center);
        const rr = vol.radius + ph.radius;
        const parryable = vol.parryable ?? (vol.type === 'bite' || vol.type === 'ram');

        // "Now" cue for a live volume nobody forecast (a forecast strike is
        // already in the ledger): the jaws / snout arrive in about a quarter second.
        if (parryable && !this.grab && d > rr && !this._strikeLedger.has(enemy, vid)) {
          const spd = Math.max(1, enemy.speed ?? enemy.velocity?.length?.() ?? 6);
          const gap = d - rr;
          if (gap < Math.max(0.8, spd * STRIKE_ETA)) {
            this._strikeLedger.add(enemy, vid);
            game.events.emit('enemy:strike', { enemy, type: vol.type, eta: gap / spd });
          }
        }

        // Parry: a little generous (+0.5 m) so a parry timed as the jaws arrive counts.
        if (parryable && !this.grab && player.isParrying?.() && d <= rr + 0.5) {
          this._hitLedger.add(enemy, vid);
          this._parry(player, enemy, vol);
          continue;
        }

        // Perfect dodge: the attack reaches (or nearly reaches) you during i-frames.
        if (dodging && d <= rr + 1.0 && !this._dodgeLedger.has(enemy, vid)) {
          this._dodgeLedger.add(enemy, vid);
          if (d <= rr) this._hitLedger.add(enemy, vid); // it whiffed
          this._perfectDodge(enemy);
          continue;
        }

        if (d > rr) continue;
        this._hitLedger.add(enemy, vid);
        if (player.isInvulnerable?.()) continue; // god mode / cutscene / late i-frames
        this._hitPlayer(player, enemy, vol);
        if (!player.alive) return;
      }
    }
  }

  _parry(player, enemy, vol) {
    const game = this.game;
    enemy.onParried?.();
    game.events.emit('player:parry', { success: true, enemy });
    game.hitstop(0.09);
    game.slowmo(0.45, 0.25);
    game.cameraRig?.addTrauma?.(0.55);
    game.cameraRig?.kickFov?.(-3, 0.35);

    const ph = player.hurtbox;
    const t = ph.radius / (ph.radius + vol.radius);
    _contact.lerpVectors(ph.center, vol.center, t);
    _n.subVectors(ph.center, vol.center);
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    _n.normalize();
    const vfx = game.vfx;
    vfx?.spawnSpark?.(_contact, _n, 1.4);
    vfx?.spawnImpact?.(_contact, _n, { strength: 1.6 });
    vfx?.spawnBubbles?.(_contact, 28, { speed: 2.4, size: 1.2, spread: 0.3 });
    // recoil off a shark's snout — but not off the megalodon: shoving 老公
    // 3.5 m/s away would carry him out of reach of the punish window
    if (!enemy.isBoss) player.velocity?.addScaledVector?.(_n, 3.5);
  }

  _perfectDodge(enemy) {
    const game = this.game;
    game.events.emit('player:perfectDodge', { enemy });
    game.slowmo(0.5, 0.3);
    game.cameraRig?.kickFov?.(-4, 0.5);
  }

  _hitPlayer(player, enemy, vol) {
    const game = this.game;
    const shock = vol.type === 'shockwave';
    const heavy = shock || vol.type === 'ram' || vol.type === 'tail' || (vol.damage ?? 0) >= 25;
    let kb = vol.knockback ?? 6;
    if (shock) kb = Math.max(kb * 1.6, 14);
    const src = vol.center.clone();
    const landed = player.takeHit?.({ damage: vol.damage ?? 10, sourcePosition: src, knockback: kb, heavy });
    if (!landed) return;

    const dmg = vol.damage ?? 10;
    game.post?.flash?.(0x6e0606, Math.min(0.8, 0.3 + dmg / 50), heavy ? 0.5 : 0.35);
    game.hitstop(heavy ? 0.08 : 0.05);

    const ph = player.hurtbox;
    _n.subVectors(ph.center, vol.center);
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    _n.normalize();
    _contact.copy(ph.center).addScaledVector(_n, -ph.radius * 0.8);
    const vfx = game.vfx;
    if (!shock) vfx?.spawnBlood?.(_contact, _n, Math.min(2.5, 0.6 + dmg / 25));
    vfx?.spawnImpact?.(_contact, _n, { strength: shock ? 1.4 : 0.8 + dmg / 40 });
    if (shock) {
      // the pressure wave throws you: extra shove on top of the Player's knockback
      player.velocity?.addScaledVector?.(_n, kb * 0.35);
      vfx?.spawnBubbles?.(ph.center, 24, { speed: 2.5, size: 1.1, spread: 0.5 });
    }

    if (vol.canGrab && player.alive && player.health > 0 && !this.grab && enemy.alive) {
      this.qte.start(enemy);
    }
  }

  // ---------------------------------------------------------------------------
  // Bodies
  // ---------------------------------------------------------------------------

  /** Push 老公 out of shark bodies (they are far heavier, so he takes all of it). */
  _separate(player) {
    const game = this.game;
    const enemies = game.enemies?.enemies ?? EMPTY;
    const pr = player.radius ?? 0.45;
    const pos = player.position;
    const vel = player.velocity;
    let impact = 0;
    for (let e = 0; e < enemies.length; e++) {
      const enemy = enemies[e];
      const hbs = enemy?.hurtboxes;
      if (!hbs) continue;
      for (let h = 0; h < hbs.length; h++) {
        const hb = hbs[h];
        if (hb.part === 'eye') continue;
        const minD = hb.radius + pr;
        _n.subVectors(pos, hb.center);
        const d2 = _n.lengthSq();
        if (d2 >= minD * minD) continue;
        const d = Math.sqrt(d2);
        if (d < 1e-4) _n.set(0, 1, 0);
        else _n.multiplyScalar(1 / d);
        const push = minD - d;
        pos.addScaledVector(_n, push);
        player.hurtbox?.center?.addScaledVector(_n, push);
        if (vel) {
          // remove the part of the relative velocity driving into the body
          const evx = enemy.velocity?.x ?? 0;
          const evy = enemy.velocity?.y ?? 0;
          const evz = enemy.velocity?.z ?? 0;
          const vn = (vel.x - evx) * _n.x + (vel.y - evy) * _n.y + (vel.z - evz) * _n.z;
          if (vn < 0) {
            vel.addScaledVector(_n, -vn);
            if (-vn > impact) {
              impact = -vn;
              _contact.copy(pos).addScaledVector(_n, -pr);
            }
          }
        }
      }
    }
    if (impact > 0) {
      // stay inside the playable water column after being shoved
      const env = game.env;
      const floor = (env?.getSeabedHeight?.(pos.x, pos.z) ?? -1e9) + 0.7;
      const ceil = WORLD.surfaceY - 1.2;
      const y = Math.min(ceil, Math.max(floor, pos.y));
      if (y !== pos.y) {
        player.hurtbox?.center && (player.hurtbox.center.y += y - pos.y);
        pos.y = y;
      }
    }
    if (impact > 4 && this._bumpCooldown <= 0) {
      this._bumpCooldown = 0.45;
      game.cameraRig?.addTrauma?.(Math.min(0.35, 0.05 * impact));
      game.vfx?.spawnBubbles?.(_contact, 8, { speed: 1.2, size: 1 });
    }
  }
}
