// Threats — everything small fish (and drifting jellies) react to, rebuilt
// each frame into a flat, pre-allocated list:
//   - live enemies (radius grows with body length and speed)
//   - dead enemies (bleeding carcasses)
//   - the player (only when close; more when dashing)
//   - blood clouds from 'enemy:hit' / 'enemy:death' positions (decay over time)
const MAX_THREATS = 24;
const MAX_BLOOD = 10;

export class Threats {
  constructor(game) {
    this.game = game;
    this.count = 0;
    this.list = [];
    for (let i = 0; i < MAX_THREATS; i++) {
      this.list.push({ x: 0, y: 0, z: 0, radius: 0, strength: 0, vx: 0, vy: 0, vz: 0, kind: 0 });
    }
    this.blood = [];
    for (let i = 0; i < MAX_BLOOD; i++) this.blood.push({ x: 0, y: 0, z: 0, life: 0, maxLife: 1, amount: 0 });
    this._bloodCursor = 0;
  }

  /** Register a blood cloud (from combat hits). */
  addBlood(position, amount = 1) {
    if (!position || typeof position.x !== 'number') return;
    const b = this.blood[this._bloodCursor];
    this._bloodCursor = (this._bloodCursor + 1) % MAX_BLOOD;
    b.x = position.x;
    b.y = position.y;
    b.z = position.z;
    b.amount = Math.min(3, Math.max(0.3, amount));
    b.maxLife = 5 + 2 * b.amount;
    b.life = b.maxLife;
  }

  _push(x, y, z, radius, strength, vx = 0, vy = 0, vz = 0, kind = 0) {
    if (this.count >= MAX_THREATS) return;
    const t = this.list[this.count++];
    t.x = x;
    t.y = y;
    t.z = z;
    t.radius = radius;
    t.strength = strength;
    t.vx = vx;
    t.vy = vy;
    t.vz = vz;
    t.kind = kind;
  }

  update(dt) {
    this.count = 0;
    const game = this.game;

    const enemies = game.enemies?.enemies;
    if (enemies) {
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        const p = e?.position;
        if (!p) continue;
        const len = e.length || (e.isBoss ? 16 : 5);
        if (e.alive !== false) {
          const v = e.velocity;
          const speed = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : 0;
          this._push(p.x, p.y, p.z, 7 + len * 1.4 + speed * 0.5, 1 + speed / 8, v?.x ?? 0, v?.y ?? 0, v?.z ?? 0, 1);
        } else {
          this._push(p.x, p.y, p.z, 5 + len * 0.6, 0.5, 0, 0, 0, 2);
        }
      }
    }

    const player = game.player;
    if (player?.position) {
      const v = player.velocity;
      const speed = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : 0;
      const p = player.position;
      this._push(p.x, p.y, p.z, 3 + speed * 0.5, 0.7 + speed / 10, v?.x ?? 0, v?.y ?? 0, v?.z ?? 0, 3);
    }

    for (let i = 0; i < MAX_BLOOD; i++) {
      const b = this.blood[i];
      if (b.life <= 0) continue;
      b.life -= dt;
      const k = Math.max(0, b.life / b.maxLife);
      // the cloud spreads while it fades
      this._push(b.x, b.y, b.z, (5 + 3 * b.amount) * (1.4 - 0.4 * k), 0.9 * k, 0, 0, 0, 4);
    }
  }
}

export { MAX_THREATS };
