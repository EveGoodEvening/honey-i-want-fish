// Grab QTE: a shark has 老公 in its jaws. Mash `attack` to drive the knife
// into its eye before time runs out; meanwhile the bite grinds health away.
//
// State lives in combat.grab = { enemy, progress: 0..1, timeLeft } (contract)
// and is null when no grab is active.
//
// Outcomes (grab:end payloads):
//   success  {success:true, enemy}                 eye stabbed, 老公 shoved free
//   fail     {success:false, enemy}                 timeout: the fail bite lands
//                                                  while still held (before the
//                                                  release grace), then the spit
//   end()    {success, enemy, interrupted:true, reason}  no outcome: restart,
//                                                  state change, death, enemy gone
// Cost of a failed grab from full HP = bite + ticks + grabDamage, e.g. great
// white 20 + 7×3.5 + 25 = 69.5, megalodon 30 + 6×5 + 30 = 90. A tick that falls
// on the timeout frame (the great white's 7th) is folded into the fail bite —
// 20 + 6×3.5 + 28.5 — so the timeout is one hit, not two in the same frame.
import * as THREE from 'three';

export const GRAB = {
  duration: 3.5,
  durationBoss: 3.3,
  stab: 0.11, // progress per attack press (≈4.4 presses/s needed)
  stabBoss: 0.09, // the megalodon's eye is harder to reach (≈5.6 presses/s)
  decay: 0.2, // progress lost per second
  dps: 7, // damage per second while held
  dpsBoss: 10,
  tick: 0.5, // damage is applied in ticks (gives the bite a grinding rhythm)
  successDamage: 60,
  successDamageBoss: 120,
  // timeout bite when the enemy has no grabDamage (species bite.grabDamage)
  failDamage: 25,
  failDamageBoss: 30,
  pulseEvery: 0.7,
};

const isBoss = (enemy) => !!(enemy?.isBoss || enemy?.type === 'megalodon');
const TIME_EPS = 1e-4; // s

const _eye = new THREE.Vector3();
const _mouth = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class GrabQTE {
  constructor(combat) {
    this.combat = combat;
    this.game = combat.game;
    this._tick = 0;
    this._pulse = 0;
    this._payload = { value: 0, timeLeft: 0, enemy: null };
  }

  get active() {
    return this.combat.grab !== null;
  }

  start(enemy) {
    const game = this.game;
    const player = game.player;
    if (this.active || !enemy?.alive || !player?.alive) return false;
    this.combat.grab = { enemy, progress: 0, timeLeft: isBoss(enemy) ? GRAB.durationBoss : GRAB.duration };
    this._tick = GRAB.tick;
    // PostFX starts its grab tunnel from the grab:start event; the periodic
    // re-pulse below keeps it throbbing while held
    this._pulse = GRAB.pulseEvery;
    player.setGrabbed?.(enemy);
    enemy.startGrab?.(player);
    game.events.emit('grab:start', { enemy });
    game.cameraRig?.addTrauma?.(0.6);
    game.hitstop(0.1);
    this._mouthPos(enemy, _mouth);
    game.vfx?.spawnBlood?.(_mouth, _dir.subVectors(player.position, _mouth), 1.4);
    game.vfx?.spawnBubbles?.(_mouth, 30, { speed: 2, size: 1.3, spread: 0.5 });
    return true;
  }

  update(dt) {
    const grab = this.combat.grab;
    if (!grab) return;
    const game = this.game;
    const player = game.player;
    const enemy = grab.enemy;

    if (!enemy?.alive || !player?.alive || !game.enemies?.enemies?.includes(enemy)) {
      this.end(false, 'interrupted');
      return;
    }

    const boss = isBoss(enemy);
    this._mouthPos(enemy, _mouth);

    // keep 老公 in the jaws even if the Player module does not attach itself
    const d = player.position.distanceTo(_mouth);
    if (d > 0.9) {
      _tmp.subVectors(player.position, _mouth).multiplyScalar(0.9 / d).add(_mouth);
      _dir.subVectors(_tmp, player.position);
      player.position.add(_dir);
      player.hurtbox?.center?.add(_dir);
    }
    player.velocity?.set?.(0, 0, 0);

    // decay first so a stab that reaches 1 this frame counts
    grab.progress = Math.max(0, grab.progress - GRAB.decay * dt);
    grab.timeLeft = Math.max(0, grab.timeLeft - dt);
    // (epsilon: timeLeft and the tick clock are summed separately, so the last
    // tick and the timeout may be a rounding error apart)
    if (grab.timeLeft < TIME_EPS) grab.timeLeft = 0;

    // mash
    if (game.input.pressed('attack')) {
      grab.progress = Math.min(1, grab.progress + (boss ? GRAB.stabBoss : GRAB.stab));
      this._eyePos(enemy, player, _eye);
      _dir.subVectors(player.position, _eye);
      game.vfx?.spawnBlood?.(_eye, _dir, 0.4 + grab.progress * 0.5);
      game.vfx?.spawnBubbles?.(_eye, 5, { speed: 1, size: 0.8 });
      game.cameraRig?.addTrauma?.(0.14);
      game.hitstop(0.025);
    }
    const timingOut = grab.timeLeft <= 0 && grab.progress < 1;
    // grinding bite damage
    this._tick -= dt;
    let owed = 0;
    if (this._tick <= TIME_EPS) {
      this._tick += GRAB.tick;
      const dmg = (boss ? GRAB.dpsBoss : GRAB.dps) * GRAB.tick;
      if (timingOut) {
        // the timeout bite lands this same frame: fold the tick into it (one
        // hit, one grunt, same total cost)
        owed = dmg;
      } else {
        player.takeHit?.({ damage: dmg, sourcePosition: _mouth.clone(), knockback: 0, heavy: false });
        game.vfx?.spawnBlood?.(player.hurtbox?.center ?? player.position, _dir.set(0, 0.3, 0), 0.3);
        if (!player.alive || player.health <= 0) {
          this.end(false, 'death');
          return;
        }
      }
    }

    this._pulse -= dt;
    if (this._pulse <= 0) {
      this._pulse = GRAB.pulseEvery;
      game.post?.pulse?.('grab');
    }

    const p = this._payload;
    p.value = grab.progress;
    p.timeLeft = grab.timeLeft;
    p.enemy = enemy;
    game.events.emit('grab:progress', p);

    if (grab.progress >= 1) this._succeed(enemy, boss);
    else if (timingOut) this._fail(enemy, boss, owed);
  }

  _succeed(enemy, boss) {
    const game = this.game;
    const player = game.player;
    this._eyePos(enemy, player, _eye);
    const eye = _eye.clone();
    const dir = _dir.subVectors(player.position, eye);
    if (dir.lengthSq() < 1e-6) dir.copy(enemy.forward ?? _tmp.set(0, 0, 1));
    dir.normalize();
    const away = dir.clone();

    this.combat.grab = null;
    enemy.releaseGrab?.(true);
    player.setGrabbed?.(null);

    const damage = boss ? GRAB.successDamageBoss : GRAB.successDamage;
    enemy.object3d?.updateWorldMatrix?.(true, false);
    const res = enemy.takeHit?.({ damage, part: 'eye', point: eye.clone(), direction: away.clone().negate(), attackType: 'grabStab' });
    const dealt = res?.damage ?? damage;
    const killed = !!res?.killed || !enemy.alive;
    game.events.emit('enemy:hit', { enemy, damage: dealt, part: 'eye', position: eye.clone(), critical: true, killed, attackType: 'grabStab' });
    game.events.emit('grab:end', { success: true, enemy });

    // shove 老公 free of the jaws
    player.velocity?.addScaledVector?.(away, 7);

    // one burst (combat owns hit blood; the wound keeps bleeding afterwards)
    const vfx = game.vfx;
    vfx?.spawnBlood?.(eye, away, 2.2);
    vfx?.spawnImpact?.(eye, away, { strength: 1.6 });
    vfx?.spawnBubbles?.(eye, 40, { speed: 2.5, size: 1.4, spread: 0.5 });
    vfx?.addWound?.(enemy, eye, { duration: 16, rate: 14, size: 1.4 });

    game.hitstop(0.14);
    game.slowmo(killed ? 1.3 : 0.9, 0.28);
    game.cameraRig?.addTrauma?.(0.75);
    game.cameraRig?.kickFov?.(5, 0.6);
    // PostFX pulses 'crit' / 'kill' itself from enemy:hit / enemy:death
  }

  /** Timeout. `extra` = a grinding tick that fell on this frame (folded in). */
  _fail(enemy, boss, extra = 0) {
    const game = this.game;
    const player = game.player;
    this._mouthPos(enemy, _mouth);
    const src = _mouth.clone();
    // The fail bite lands while 老公 is still held: setGrabbed(null) grants a
    // post-release grace (i-frames) that would swallow it. In state 'grabbed'
    // takeHit applies no knockback / hurt state — the spit below throws him.
    const damage = (enemy.grabDamage ?? (boss ? GRAB.failDamageBoss : GRAB.failDamage)) + extra;
    player.takeHit?.({ damage, sourcePosition: src, knockback: 0, heavy: true });
    this.combat.grab = null;
    enemy.releaseGrab?.(false); // spits him out (and normally clears grabbedBy)
    if (player.grabbedBy) player.setGrabbed?.(null);
    if (!player.alive && player.state !== 'dead') player.state = 'dead';
    game.post?.flash?.(0x7a0505, 0.75, 0.6);
    game.vfx?.spawnBlood?.(player.hurtbox?.center ?? player.position, _dir.subVectors(player.position, src), 2.2);
    game.cameraRig?.addTrauma?.(0.6);
    game.hitstop(0.12);
    game.events.emit('grab:end', { success: false, enemy });
  }

  /**
   * End without the success/fail outcome (restart, state change, death, enemy
   * gone). grab:end carries interrupted:true so listeners can skip the
   * failure feedback.
   */
  end(success = false, reason = '') {
    const grab = this.combat.grab;
    if (!grab) return;
    const game = this.game;
    const player = game.player;
    const enemy = grab.enemy;
    this.combat.grab = null;
    try {
      enemy?.releaseGrab?.(success);
    } finally {
      // releaseGrab normally frees 老公 itself; a second setGrabbed(null) would
      // puff again and re-arm the post-grab grace
      if (player?.grabbedBy) player.setGrabbed?.(null);
      if (player && !player.alive) player.state = 'dead';
      game.events.emit('grab:end', { success, enemy, interrupted: true, reason });
    }
  }

  _mouthPos(enemy, out) {
    const m = enemy.getMouthPosition?.();
    if (m) return out.copy(m);
    out.copy(enemy.position);
    if (enemy.forward) out.addScaledVector(enemy.forward, (enemy.length ?? 5) * 0.45);
    return out;
  }

  /** The eye nearest the player (sharks have two), else just above the mouth. */
  _eyePos(enemy, player, out) {
    let best = null;
    let bestD = Infinity;
    const hbs = enemy.hurtboxes;
    if (hbs) {
      for (let i = 0; i < hbs.length; i++) {
        const hb = hbs[i];
        if (hb.part !== 'eye') continue;
        const d = hb.center.distanceToSquared(player.position);
        if (d < bestD) {
          bestD = d;
          best = hb.center;
        }
      }
    }
    if (best) return out.copy(best);
    this._mouthPos(enemy, out);
    out.y += (enemy.length ?? 5) * 0.06;
    if (enemy.forward) out.addScaledVector(enemy.forward, -(enemy.length ?? 5) * 0.06);
    return out;
  }
}
