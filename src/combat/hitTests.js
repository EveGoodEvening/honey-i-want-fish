// Small allocation-free geometry helpers and bookkeeping for CombatSystem.

/**
 * Closest point on segment [a, b] to p, written into `out`.
 * Returns the squared distance from p to that point.
 */
export function closestOnSegment(out, a, b, p) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (len2 > 1e-12) {
    t = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
  const dx = p.x - out.x;
  const dy = p.y - out.y;
  const dz = p.z - out.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Ray (origin, unit dir) vs sphere. Returns the entry distance t >= 0, or -1
 * when the ray misses or starts inside the sphere.
 */
export function raySphereEntry(origin, dir, center, radius) {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c < 0) return -1; // inside
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -1;
}

const FREE = Symbol('free'); // empty ledger slot (never equal to a real id)

/**
 * Remembers which attack-volume ids of each enemy have already been
 * resolved ("once per volume id"). Ids are only unique per enemy, so the
 * ledger is keyed by enemy; each keeps a small ring of recent ids.
 */
export class VolumeLedger {
  constructor(size = 16) {
    this.size = size;
    this.map = new WeakMap();
  }

  has(enemy, id) {
    const l = this.map.get(enemy);
    if (!l) return false;
    const ids = l.ids;
    for (let i = 0; i < ids.length; i++) if (ids[i] === id) return true;
    return false;
  }

  add(enemy, id) {
    let l = this.map.get(enemy);
    if (!l) {
      l = { ids: new Array(this.size).fill(FREE), n: 0 };
      this.map.set(enemy, l);
    }
    l.ids[l.n % this.size] = id;
    l.n++;
  }
}
