// Cinematic camera poses driven by game.state. Each function writes a camera
// position and a look-at target and returns the field of view (degrees).
// `t` is seconds since the mode started; `ctx` holds per-mode values captured
// when the mode was entered (see CameraRig._enterMode).
import * as THREE from 'three';
import { WORLD } from '../core/config.js';
import { INTRO_DIVE_AT } from '../game/Director.js';
import { LAYOUT, cliffRadius, cliffTop, wreckBaseY } from '../world/terrain.js';

const _v = new THREE.Vector3();

// Seconds into the intro when the Director cues the dive. The rig re-syncs
// ctx.diveAt from the {name:'dive'} cinematic event; this is only the default.
export { INTRO_DIVE_AT };
const INTRO_DIVE_LEN = 3.0; // dive → follow framing (the intro ends at 11.6 s)

function seabed(env, x, z) {
  return env?.getSeabedHeight ? env.getSeabedHeight(x, z) : WORLD.floorY;
}

function smoother(x) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** The dead megalodon (the payoff of the run), if any. */
export function findDeadBoss(game) {
  const list = game.enemies?.enemies;
  if (!list) return null;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e?.isBoss && !e.alive && e.position) return e;
  }
  return null;
}

/** Optional point of interest from the Environment (the sunken wreck). */
export function findTitleFocus(env, out) {
  const cand = env?.titleFocus ?? env?.wreckPosition ?? env?.poi?.wreck ?? env?.wreck?.position ?? null;
  if (cand?.isVector3) {
    out.copy(cand);
    return true;
  }
  out.set(0, seabed(env, 0, 0), 0);
  return false;
}

/**
 * Title: a slow drifting orbit just above the seabed, looking up through the
 * water column toward the light (and the wreck if the Environment exposes it).
 */
export function titlePose(game, t, ctx, outPos, outLook) {
  const env = game.env;
  const c = ctx.focus;
  const a = 0.65 + t * 0.03;
  const R = ctx.hasFocus ? 17 : 22;
  const x = c.x + Math.cos(a) * R;
  const z = c.z + Math.sin(a) * R;
  const floor = seabed(env, x, z);
  outPos.set(x, floor + 2.2 + Math.sin(t * 0.23) * 0.4, z);
  if (ctx.hasFocus) {
    outLook.set(c.x, c.y + 4.5, c.z);
  } else {
    // look across and up toward the bright surface, slowly panning
    outLook.set(c.x + Math.cos(a + 2.4) * 6, floor + 7.5 + Math.sin(t * 0.11) * 1.5, c.z + Math.sin(a + 2.4) * 6);
  }
  outPos.y = Math.min(outPos.y, WORLD.surfaceY - 0.5);
  return 54;
}

/**
 * Intro: during the phone call the camera hangs just under the surface,
 * looking straight down at the tiny diver far below; on the Director's dive
 * cue it spirals down over 3 s to end exactly at the follow position.
 */
export function introPose(game, t, ctx, followPos, followLook, outPos, outLook) {
  const p = game.player.position;
  const u = (t - (ctx.diveAt ?? INTRO_DIVE_AT)) / INTRO_DIVE_LEN;
  const e = smoother(u); // 0 (start pose) before the dive
  // start: just under the surface, a little behind/right of the diver
  _v.set(p.x + ctx.side.x * 3.5 + ctx.back.x * 5, WORLD.surfaceY - 0.6, p.z + ctx.side.z * 3.5 + ctx.back.z * 5);
  outPos.lerpVectors(_v, followPos, e);
  // a lazy spiral while descending
  const swirl = Math.sin(e * Math.PI) * 2.2;
  outPos.x += ctx.side.x * swirl * Math.cos(e * 4);
  outPos.z += ctx.side.z * swirl * Math.cos(e * 4);
  outPos.y += Math.sin(e * Math.PI) * 0.8;
  // look: from straight down at the diver toward the follow framing
  _v.set(p.x, p.y - 1.5, p.z);
  outLook.lerpVectors(_v, followLook, smoother((u - 0.1) / 0.9));
  return 58 + 6 * (1 - e);
}

// death composition
export const DEAD_KILLER_RANGE = 18; // a killer farther than this is not framed (body alone)
const DEAD_KILLER_NEAR = 15; // killer framing weight 1 inside, fading to 0 at …
const DEAD_KILLER_FAR = 21; // … this distance from the body (0.5 at DEAD_KILLER_RANGE)
const DEAD_SWING = 0.75; // rad aside of "straight opposite the killer"
const DEAD_R_ALONE = 13; // pull-away radius, body alone …
const DEAD_R_KILLER = 7.5; // … and framed with the killer (close enough that it reads big)
const DEAD_ELEV_ALONE = 1.0; // camera elevation above the body (rad)
// with the killer: opposite it in height too (low when it is above the body,
// high when below) so the pair fits the frame; this much from above at par
const DEAD_ELEV_KILLER = 0.35;

/** 0..1: how much the death camera frames a killer `dist` metres from the body. */
function deadKillerWeight(dist) {
  return 1 - smoother((dist - DEAD_KILLER_NEAR) / (DEAD_KILLER_FAR - DEAD_KILLER_NEAR));
}

/**
 * Called when the death camera starts (after ctx.radius / elev / azimuth were
 * captured from the current camera and ctx.killer / killerLook were set):
 * picks the side of the body the camera swings to — the one nearer to where
 * it already is — once, so a killer circling the body never flips it.
 */
export function initDeadPose(game, ctx) {
  const p = game.player.position;
  ctx.az = ctx.azimuth;
  ctx.deadSide = 1;
  ctx.killerW = 0;
  const killer = ctx.killer?.position ? ctx.killerLook : null;
  if (!killer) return;
  ctx.killerW = deadKillerWeight(killer.distanceTo(p));
  const kaz = Math.atan2(killer.x - p.x, killer.z - p.z);
  const d1 = wrapAngle(kaz + Math.PI - DEAD_SWING - ctx.azimuth);
  const d2 = wrapAngle(kaz + Math.PI + DEAD_SWING - ctx.azimuth);
  ctx.deadSide = Math.abs(d1) < Math.abs(d2) ? -1 : 1;
}

/**
 * Death: slow pull-away upward from the sinking body, looking down at it. With
 * a killer within ~18 m (ctx.killer, ctx.killerLook = its smoothed position)
 * the camera instead swings to the far side of the body from the shark (and
 * opposite it in height: low under a shark above), closer, and frames both:
 * 老公 sinking in front, the shark that did it beyond him. The killer weight
 * fades with its distance, so one that swims off hands the shot back to the
 * body alone. The look direction is solved in angles from the camera so the
 * body always stays in the lower-middle of the frame (y ≈ 0.4–0.66) and the
 * shark is centred with it as far as that allows. `dt` (real seconds) drives
 * the smoothing kept in ctx.
 */
export function deadPose(game, t, ctx, outPos, outLook, dt = 1 / 60) {
  const env = game.env;
  const p = game.player.position;
  const k = 1 - Math.exp(-t * 0.35);
  const killer = ctx.killer?.position ? ctx.killerLook : null;
  const want = killer ? deadKillerWeight(killer.distanceTo(p)) : 0;
  ctx.killerW += (want - ctx.killerW) * (1 - Math.exp(-1.5 * dt));
  const kw = ctx.killerW;

  // camera azimuth around the body: a slow drift when alone; with the killer,
  // eased round to the far side of the body, DEAD_SWING aside so he does not
  // hide it
  let daz = 0.045 * dt * (1 - kw);
  let elevK = DEAD_ELEV_KILLER;
  if (killer) {
    const kaz = Math.atan2(killer.x - p.x, killer.z - p.z);
    const goal = kaz + Math.PI + DEAD_SWING * ctx.deadSide;
    daz += wrapAngle(goal - ctx.az) * (1 - Math.exp(-1.4 * dt)) * kw;
    const kEl = Math.atan2(killer.y - p.y, Math.hypot(killer.x - p.x, killer.z - p.z));
    elevK = Math.max(-0.1, Math.min(0.8, DEAD_ELEV_KILLER - 0.8 * kEl));
  }
  ctx.az += daz;
  const R = ctx.radius + (DEAD_R_ALONE + (DEAD_R_KILLER - DEAD_R_ALONE) * kw - ctx.radius) * k;
  const elev = ctx.elev + (DEAD_ELEV_ALONE + (elevK - DEAD_ELEV_ALONE) * kw - ctx.elev) * k;
  const ce = Math.cos(elev);
  outPos.set(p.x + Math.sin(ctx.az) * ce * R, p.y + Math.sin(elev) * R, p.z + Math.cos(ctx.az) * ce * R);
  // stay in the water before aiming (the rig's own clamp would tilt the shot)
  outPos.y = Math.max(seabed(env, outPos.x, outPos.z) + 0.6, Math.min(outPos.y, WORLD.surfaceY - 0.6));

  const fov = 56 - 6 * k;
  const cam = game.camera;
  const tanV = Math.tan((fov * Math.PI) / 360);
  const tanH = tanV * (cam?.aspect || 16 / 9);
  // body centre: bearing / elevation from the camera
  const bx = p.x - outPos.x;
  const by = p.y + 0.05 - outPos.y;
  const bz = p.z - outPos.z;
  const yawB = Math.atan2(bx, bz);
  const elB = Math.atan2(by, Math.hypot(bx, bz));
  // alone: the body a little below the centre (y ≈ 0.55)
  let yaw = yawB;
  let dPitch = Math.atan(0.1 * tanV);
  if (killer && kw > 1e-3) {
    const kx = killer.x - outPos.x;
    const ky = killer.y - outPos.y;
    const kz = killer.z - outPos.z;
    const yawK = Math.atan2(kx, kz);
    const elK = Math.atan2(ky, Math.hypot(kx, kz));
    // centre the pair, the body kept inside x ≈ 0.22–0.78 …
    const maxOff = Math.atan(0.56 * tanH);
    yaw = yawB + Math.max(-maxOff, Math.min(maxOff, wrapAngle(yawK - yawB) * 0.5)) * kw;
    dPitch += ((elK - elB) * 0.5 - dPitch) * kw;
  }
  // … and inside y ≈ 0.4–0.66 (+ = body below the centre)
  dPitch = Math.max(-Math.atan(0.2 * tanV), Math.min(Math.atan(0.32 * tanV), dPitch));
  const pitch = elB + dPitch;
  const cp = Math.cos(pitch);
  outLook.set(outPos.x + Math.sin(yaw) * cp * 10, outPos.y + Math.sin(pitch) * 10, outPos.z + Math.cos(yaw) * cp * 10);
  return fov;
}

// Victory composition, the megalodon dead (the payoff). The corpse is seen
// broadside to 3/4 — |cos| between the view and its body axis in VIC_SIDE,
// never nose-on — and never from below (VIC_LOOKUP), in the left /
// centre-left of the frame, clear of the stats panel that later fills the
// middle-right (x ≈ 0.42–0.75); 老公 stands in front of it, high in the left
// third, at least VIC_HERO_MIN of the frame height. The camera stands far
// enough from the corpse that its whole length fits (≥ VIC_FILL_K · length /
// tan(0.45 · hFov) from its centroid), with open water to both — no seabed,
// reef wall, wreck or outcrop in the way — and never with the corpse between
// the lens and him. Its bearing and elevation are scored over VIC_BEARINGS ×
// VIC_ELEV candidates by the shot they would give, picked again when the
// corpse has risen / rolled VIC_RECHOOSE m from where it was picked (or would
// be seen from below), and eased over to (VIC_EASE).
const VIC_FOV = 48;
const VIC_HERO = [-0.5, 0.25]; // NDC 老公's chest aims at …
const VIC_CORPSE = [-0.25, -0.28]; // … and the corpse's centroid (a weighted compromise:)
const VIC_HERO_W = 0.6; // … 老公's share
const VIC_HERO_X = [-0.85, -0.12]; // NDC 老公 is always kept inside …
const VIC_HERO_Y = [-0.02, 0.6]; // … (upper half, inside the letterbox bars)
const VIC_SAFE_Y = 0.74; // NDC half-height inside the letterbox bars: the pair stays within it
const VIC_FILL_K = 0.68; // corpse framing distance (see header): its bbox ≈ 15–40 % of the frame
const VIC_D_MIN = 9; // camera ↔ corpse centroid at least (m)
const VIC_R_MIN = 5.5; // camera ↔ 老公 (m): at least …
const VIC_R_MAX = 22; // … at most (before the slow pull-back)
const VIC_BEARINGS = 24; // candidate camera bearings around 老公 …
const VIC_ELEV = [0.06, 0.2, 0.36, 0.55]; // … and elevations (rad, above 老公 / corpse mid-height)
const VIC_SIDE = [0.2, 0.45]; // wanted |cos(view, corpse axis)|: broadside to 3/4
const VIC_LOOKUP = 0.14; // rad (8°, a margin under 10°): the corpse centroid is never seen from further below …
const VIC_LOOKDOWN = 0.6; // … and preferably not from further above (a map view)
const VIC_HERO_MIN = 0.06; // 老公 (1.75 m) fills at least this share of the frame height
const VIC_PANEL_X = -0.16; // NDC x where the stats panel begins: the corpse centroid stays left of it
const VIC_RECHOOSE = 2; // m the corpse may rise / drift from where the shot was picked before it is picked again
const VIC_EASE = 1.2; // 1/s: the camera eases over to a re-picked bearing / elevation
const VIC_DRIFT = 1.5; // s: the corpse must not cover 老公 where its drift takes it in this long either
const VIC_PULL = 0.2; // slow pull-back: R grows by this fraction …
const VIC_PULL_AT = 2; // … from this many seconds …
const VIC_PULL_LEN = 6; // … over this long

const _vh = new THREE.Vector3(); // 老公's chest
const _vb = new THREE.Vector3(); // corpse centroid
const _vd = new THREE.Vector3(); // horizontal camera bearing (unit, from 老公)
const _vc = new THREE.Vector3(); // candidate camera position …
const _vp = new THREE.Vector3(); // … and where its pull-back ends
const _vq = new THREE.Vector3(); // the corpse's drift over VIC_DRIFT
const _vs = { low: 0, high: 0 }; // corpse extent: its lowest / highest point (y)

/** Corpse centroid (hurtbox spheres, radius-weighted) → out; its lowest / highest point → _vs. */
function corpseShape(corpse, out) {
  const hbs = corpse.hurtboxes;
  if (!hbs?.length) {
    out.copy(corpse.position);
    _vs.low = out.y - (corpse.length ?? 16) * 0.15;
    _vs.high = out.y + (corpse.length ?? 16) * 0.15;
    return out;
  }
  out.set(0, 0, 0);
  let w = 0;
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < hbs.length; i++) {
    const hb = hbs[i];
    out.addScaledVector(hb.center, hb.radius);
    w += hb.radius;
    low = Math.min(low, hb.center.y - hb.radius);
    high = Math.max(high, hb.center.y + hb.radius);
  }
  out.multiplyScalar(1 / Math.max(1e-6, w));
  _vs.low = low;
  _vs.high = high;
  return out;
}

const _span = { top: 0, low: 0 };

/**
 * Elevation (rad, seen from `cam`) of the top / bottom of the pair — 老公's
 * head and feet and the corpse's highest and lowest point — into _span;
 * returns the angle they span.
 */
function victorySpan(cam, H, B) {
  const hH = Math.hypot(H.x - cam.x, H.z - cam.z);
  const hB = Math.hypot(B.x - cam.x, B.z - cam.z);
  _span.top = Math.max(Math.atan2(H.y + 0.75 - cam.y, hH), Math.atan2(_vs.high - cam.y, hB));
  _span.low = Math.min(Math.atan2(H.y - 1.1 - cam.y, hH), Math.atan2(_vs.low - cam.y, hB));
  return _span.top - _span.low;
}

/** Does the segment a→b pass through any of `hbs` (radius × scale, moved by `off` if given)? */
function segmentBlocked(a, b, hbs, scale, off = null) {
  if (!hbs) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const L2 = dx * dx + dy * dy + dz * dz;
  if (L2 < 1e-8) return false;
  const ox = off ? off.x : 0;
  const oy = off ? off.y : 0;
  const oz = off ? off.z : 0;
  for (let i = 0; i < hbs.length; i++) {
    const c = hbs[i].center;
    const cx = c.x + ox;
    const cy = c.y + oy;
    const cz = c.z + oz;
    const r = hbs[i].radius * scale;
    let k = ((cx - a.x) * dx + (cy - a.y) * dy + (cz - a.z) * dz) / L2;
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    const ex = a.x + dx * k - cx;
    const ey = a.y + dy * k - cy;
    const ez = a.z + dz * k - cz;
    if (ex * ex + ey * ey + ez * ez < r * r) return true;
  }
  return false;
}

/** Camera R from 老公 along bearing `dir` at elevation `elev`, kept in the water → out. */
function victoryCam(env, H, B, dir, elev, R, out) {
  const midY = H.y * 0.65 + B.y * 0.35;
  out.set(H.x + dir.x * R * Math.cos(elev), midY + R * Math.sin(elev), H.z + dir.z * R * Math.cos(elev));
  out.y = Math.max(seabed(env, out.x, out.z) + 1.5, Math.min(out.y, WORLD.surfaceY - 0.8));
  return out;
}

/**
 * Smallest R (VIC_R_MIN..VIC_R_MAX) that puts the camera at least `dMin` from
 * the corpse centroid and fits 老公 and the corpse's height into `fitV` of the
 * frame (bisection; both grow monotonically with R).
 */
function victoryFit(env, H, B, dir, elev, dMin, fitV) {
  const ok = (R) => {
    victoryCam(env, H, B, dir, elev, R, _vc);
    if (_vc.distanceTo(B) < dMin) return false;
    return victorySpan(_vc, H, B) <= fitV;
  };
  if (ok(VIC_R_MIN)) return VIC_R_MIN;
  if (!ok(VIC_R_MAX)) return VIC_R_MAX;
  let lo = VIC_R_MIN;
  let hi = VIC_R_MAX;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) * 0.5;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

// --------------------------------------------------------- victory: occlusion

const WALL_MARGIN = 3; // m the reef wall's crags stand in front of the heightfield ramp getSeabedHeight follows

/**
 * Is (x, y, z) in rock — under the seabed, in the reef wall's face, the
 * wreck's hull or an outcrop? (Coarse shapes from the world LAYOUT: enough
 * to keep the victory camera from shooting through them.)
 */
function solidAt(env, x, y, z) {
  if (y < seabed(env, x, z) + 0.3) return true;
  const c = LAYOUT.cliff;
  const r = Math.hypot(x, z);
  if (r > c.radius - 14) {
    const th = Math.atan2(x, -z);
    if (Math.abs(wrapAngle(th - c.center)) < c.half - c.taper * 0.5 && r > cliffRadius(th) - WALL_MARGIN
      && y < cliffTop(th, x, z) + 0.5) return true;
  }
  const w = LAYOUT.wreck;
  const wx = x - w.x;
  const wz = z - w.z;
  if (wx * wx + wz * wz < w.length * w.length) {
    // bow direction = (sin h, 0, cos h)
    const sh = Math.sin(w.heading);
    const ch = Math.cos(w.heading);
    if (Math.abs(wx * sh + wz * ch) < w.length * 0.55 && Math.abs(wx * ch - wz * sh) < w.beam * 0.75
      && y < wreckBaseY() + 6) return true;
  }
  const oc = LAYOUT.outcrops;
  for (let i = 0; i < oc.length; i++) {
    const o = oc[i];
    const ox = x - o.x;
    const oz = z - o.z;
    const rr = o.size * 0.6;
    if (ox * ox + oz * oz < rr * rr && y < seabed(env, o.x, o.z) + o.size * (o.tall > 1.3 ? 1.7 : 0.9)) return true;
  }
  return false;
}

/**
 * Share (0..1) of the sight line a → b that runs through rock, its last
 * `spare` m left out (the target's own body: a corpse lying against the reef
 * wall still counts as seen).
 */
export function occluded(env, a, b, spare = 1) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const L = Math.hypot(dx, dy, dz);
  if (L < spare + 0.5) return 0;
  const n = Math.min(24, Math.max(6, Math.ceil(L / 1.5)));
  const span = (L - spare) / L;
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const k = (i / n) * span;
    if (solidAt(env, a.x + dx * k, a.y + dy * k, a.z + dz * k)) hit++;
  }
  return hit / n;
}

const PROBES = 5; // corpse spheres a sight line is tested to: snout to tail, evenly
const _probe = [0, 0, 0, 0, 0];

/**
 * Share (0..1) of the corpse hidden from `cam` by rock: of up to PROBES of its
 * big hurtbox spheres (no eyes / fins), evenly from snout to tail, those whose
 * sight line (spared the sphere itself) runs through rock. A corpse lying on
 * a ledge or behind a ridge is hidden even when its centroid is not.
 */
export function corpseOccluded(env, cam, corpse) {
  const hbs = corpse.hurtboxes;
  if (!hbs?.length) return occluded(env, cam, corpse.position, 2) > 0 ? 1 : 0;
  let m = 0;
  for (let i = 0; i < hbs.length; i++) if (hbs[i].radius >= 0.7 && hbs[i].part !== 'eye' && hbs[i].part !== 'fin') m++;
  if (!m) return 0;
  let n = 0;
  let k = 0;
  for (let i = 0; i < hbs.length && n < PROBES; i++) {
    const hb = hbs[i];
    if (hb.radius < 0.7 || hb.part === 'eye' || hb.part === 'fin') continue;
    // the k-th of m big spheres; take PROBES of them spread over the list
    if (Math.round((n * (m - 1)) / Math.max(1, Math.min(PROBES, m) - 1)) === k) _probe[n++] = i;
    k++;
  }
  let hidden = 0;
  for (let j = 0; j < n; j++) {
    const hb = hbs[_probe[j]];
    if (occluded(env, cam, hb.center, hb.radius + 0.3) > 0) hidden++;
  }
  return n ? hidden / n : 0;
}

// ------------------------------------------------------------ victory: shot

const _aim = { yaw: 0, pitch: 0, xH: 0, xB: 0, eB: 0 };

/** NDC x of a point `db` rad of bearing left of the look (off to ±9 when behind it). */
function ndcX(db, tanH) {
  const a = wrapAngle(db);
  return Math.abs(a) >= 1.5 ? (a > 0 ? -9 : 9) : -Math.tan(a) / tanH;
}

/**
 * The victory look from `cam` → _aim: yaw / pitch (rad), where 老公 and the
 * corpse centroid land (NDC x) and the corpse's elevation seen from the lens
 * (eB). The weighted compromise between their NDC spots (VIC_HERO /
 * VIC_CORPSE), then 老公 kept inside his safe area and the pair inside the
 * letterbox. A point at bearing b shows at NDC x = −tan(b − yaw) / tanH
 * (bearing grows to the left), at elevation e at NDC y = tan(e − pitch) / tanV.
 */
function victoryAim(cam, H, B, tanH, tanV) {
  const bH = Math.atan2(H.x - cam.x, H.z - cam.z);
  const bB = Math.atan2(B.x - cam.x, B.z - cam.z);
  const eH = Math.atan2(H.y - cam.y, Math.hypot(H.x - cam.x, H.z - cam.z));
  const eB = Math.atan2(B.y - cam.y, Math.hypot(B.x - cam.x, B.z - cam.z));
  const yawH = bH + Math.atan(VIC_HERO[0] * tanH);
  const yawB = bB + Math.atan(VIC_CORPSE[0] * tanH);
  let yaw = yawH + wrapAngle(yawB - yawH) * (1 - VIC_HERO_W);
  yaw = bH + clamp(wrapAngle(yaw - bH), Math.atan(VIC_HERO_X[0] * tanH), Math.atan(VIC_HERO_X[1] * tanH));
  const pitchH = eH - Math.atan(VIC_HERO[1] * tanV);
  const pitchB = eB - Math.atan(VIC_CORPSE[1] * tanV);
  let pitch = pitchH + (pitchB - pitchH) * (1 - VIC_HERO_W);
  pitch = eH - clamp(eH - pitch, Math.atan(VIC_HERO_Y[0] * tanV), Math.atan(VIC_HERO_Y[1] * tanV));
  // … and the pair as a whole inside the letterbox (a corpse above him too)
  // (centred when it cannot fit: continuous either way, so the shot never jumps)
  const half = Math.atan(VIC_SAFE_Y * tanV);
  victorySpan(cam, H, B);
  const pLo = _span.top - half;
  const pHi = _span.low + half;
  pitch = pLo <= pHi ? clamp(pitch, pLo, pHi) : (_span.top + _span.low) * 0.5;
  _aim.yaw = yaw;
  _aim.pitch = pitch;
  _aim.xH = ndcX(bH - yaw, tanH);
  _aim.xB = ndcX(bB - yaw, tanH);
  _aim.eB = eB;
  return _aim;
}

/**
 * Score the shot from every candidate camera (VIC_BEARINGS bearings around
 * 老公 × VIC_ELEV elevations, each at its size-aware boom) and keep the best
 * bearing / elevation in ctx.vicAz / ctx.vicElev; ctx.vicB0 remembers where
 * the corpse was. `from` is the camera now: swinging away from it costs
 * `swing` (more for a re-pick mid-shot than for the cut-in).
 */
function victoryChoose(game, ctx, H, B, dMin, fitV, tanH, tanV, from, swing) {
  const env = game.env;
  const corpse = ctx.corpse;
  const f = corpse.forward;
  let fx = f?.x ?? 0;
  let fy = f?.y ?? 0;
  let fz = f?.z ?? 1;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // 老公 (1.75 m) keeps VIC_HERO_MIN of the frame height after the pull-back
  const heroMax = 1.75 / (2 * tanV * VIC_HERO_MIN * (1 + VIC_PULL));
  // where the corpse will have drifted (rising, coasting) in VIC_DRIFT s
  const drift = corpse.velocity ? _vq.copy(corpse.velocity).multiplyScalar(VIC_DRIFT) : null;
  let best = Infinity;
  for (let i = 0; i < VIC_BEARINGS; i++) {
    const az = (i / VIC_BEARINGS) * Math.PI * 2;
    _vd.set(Math.sin(az), 0, Math.cos(az));
    for (let j = 0; j < VIC_ELEV.length; j++) {
      const elev = VIC_ELEV[j];
      const R = victoryFit(env, H, B, _vd, elev, dMin, fitV);
      victoryCam(env, H, B, _vd, elev, R, _vc);
      let score = 0.04 * (R - VIC_R_MIN);
      // the corpse between the lens and 老公; rock in either sight line, from
      // here or from where the slow pull-back ends
      // (hard now; softer when it only grazes him or will once it has drifted)
      if (segmentBlocked(_vc, H, corpse.hurtboxes, 0.95)) score += 20;
      if (segmentBlocked(_vc, H, corpse.hurtboxes, 1.15)) score += 6;
      if (drift && segmentBlocked(_vc, H, corpse.hurtboxes, 1.15, drift)) score += 6;
      let occ = corpseOccluded(env, _vc, corpse) + (occluded(env, _vc, H) > 0 ? 1 : 0);
      victoryCam(env, H, B, _vd, elev, R * (1 + VIC_PULL), _vp);
      occ += corpseOccluded(env, _vp, corpse) + (occluded(env, _vp, H) > 0 ? 1 : 0);
      if (occ > 0) score += 4 + 10 * occ;
      // pushed off the seabed / down from the surface: a skewed shot
      const want = H.y * 0.65 + B.y * 0.35 + R * Math.sin(elev);
      score += Math.min(4, Math.abs(_vc.y - want) * 0.8);
      // broadside to 3/4: never nose- or tail-on (a ball with a mouth)
      const vx = B.x - _vc.x;
      const vy = B.y - _vc.y;
      const vz = B.z - _vc.z;
      const side = Math.abs(vx * fx + vy * fy + vz * fz) / (Math.hypot(vx, vy, vz) || 1);
      score += 6 * (Math.max(0, side - VIC_SIDE[1]) + Math.max(0, VIC_SIDE[0] - side));
      // the shot it gives: never from below, the corpse left of the panel
      const aim = victoryAim(_vc, H, B, tanH, tanV);
      score += 40 * Math.max(0, aim.eB - VIC_LOOKUP) + 8 * Math.max(0, -aim.eB - VIC_LOOKDOWN);
      score += Math.min(4, 2 * Math.abs(aim.xB - VIC_CORPSE[0])) + 6 * Math.max(0, aim.xB - VIC_PANEL_X);
      // 老公 big enough
      const dH = _vc.distanceTo(H);
      if (dH > heroMax) score += 0.5 * (dH - heroMax);
      // the least swing from the camera now
      if (from) {
        const ax = from.x - H.x;
        const az2 = from.z - H.z;
        const al = Math.hypot(ax, az2);
        if (al > 0.5) score += swing * (1 - (ax * _vd.x + az2 * _vd.z) / al);
      }
      if (score < best) {
        best = score;
        ctx.vicAz = az;
        ctx.vicElev = elev;
      }
    }
  }
  ctx.vicB0.copy(B);
  ctx.vicReady = true;
}

/**
 * Victory: with the megalodon dead (ctx.corpse), the payoff shot described
 * at VIC_* above, clear of the stats panel that later fills the middle-right.
 * Otherwise a slow, low orbit around 老公.
 */
export function victoryPose(game, t, ctx, outPos, outLook) {
  const p = game.player.position;
  const corpse = ctx.corpse;
  if (corpse?.position) {
    const env = game.env;
    const cam = game.camera;
    const aspect = cam?.aspect || 16 / 9;
    const tanV = Math.tan((VIC_FOV * Math.PI) / 360);
    const tanH = tanV * aspect;
    // vertical room inside the cinematic letterbox bars (~10 % top and bottom)
    const fitV = ((VIC_FOV * Math.PI) / 180) * 0.7;
    const dMin = Math.max(VIC_D_MIN, (VIC_FILL_K * (corpse.length ?? 16)) / Math.tan(0.9 * Math.atan(tanH)));
    const H = _vh.copy(game.player.hurtbox?.center ?? p);
    if (!game.player.hurtbox?.center) H.y += 0.3;
    const B = corpseShape(corpse, _vb);
    const dt = ctx.vicReady ? clamp(t - ctx.vicT, 0, 0.1) : 0;
    ctx.vicT = t;
    if (!ctx.vicReady) {
      victoryChoose(game, ctx, H, B, dMin, fitV, tanH, tanV, ctx.entryPos, 0.6);
      ctx.vicAzS = ctx.vicAz;
      ctx.vicElevS = ctx.vicElev;
      ctx.vicNext = t + 1.5; // (after the cut-in blend)
    } else if (t >= ctx.vicNext) {
      // Twice a second (outPos still holds the last pose): the corpse rose /
      // drifted 2 m (or sank 4 m) from where the shot was picked, is seen from
      // below, slid out of the frame or behind rock, or rock hides 老公 → pick
      // again, then ease over.
      const B0 = ctx.vicB0;
      const aim = victoryAim(outPos, H, B, tanH, tanV);
      const moved = B.y - B0.y > VIC_RECHOOSE || B0.y - B.y > 2 * VIC_RECHOOSE || Math.hypot(B.x - B0.x, B.z - B0.z) > VIC_RECHOOSE;
      const lost = aim.eB > VIC_LOOKUP || aim.xB < -1 || aim.xB > 0.6
        || corpseOccluded(env, outPos, corpse) >= 0.4 || occluded(env, outPos, H) > 0;
      if (moved || lost) {
        victoryChoose(game, ctx, H, B, dMin, fitV, tanH, tanV, outPos, 2.5);
        ctx.vicNext = t + 1.5;
      } else ctx.vicNext = t + 0.5;
    }
    const k = 1 - Math.exp(-VIC_EASE * dt);
    ctx.vicAzS += wrapAngle(ctx.vicAz - ctx.vicAzS) * k;
    ctx.vicElevS += (ctx.vicElev - ctx.vicElevS) * k;
    _vd.set(Math.sin(ctx.vicAzS), 0, Math.cos(ctx.vicAzS));
    // the size-aware boom, then a slow pull-back as the corpse sinks away
    const R = victoryFit(env, H, B, _vd, ctx.vicElevS, dMin, fitV) * (1 + VIC_PULL * smoother((t - VIC_PULL_AT) / VIC_PULL_LEN));
    victoryCam(env, H, B, _vd, ctx.vicElevS, R, outPos);
    outPos.y += Math.sin(t * 0.3) * 0.15;
    const aim = victoryAim(outPos, H, B, tanH, tanV);
    const cp = Math.cos(aim.pitch);
    outLook.set(outPos.x + Math.sin(aim.yaw) * cp * 10, outPos.y + Math.sin(aim.pitch) * 10, outPos.z + Math.cos(aim.yaw) * cp * 10);
    return VIC_FOV;
  }
  const k = smoother(t / 3);
  const R = ctx.radius + (5.5 - ctx.radius) * k;
  const az = ctx.azimuth + t * 0.16;
  outPos.set(p.x + Math.sin(az) * R, p.y + 0.3 + (ctx.height - 0.3) * (1 - k), p.z + Math.cos(az) * R);
  outPos.y = Math.min(outPos.y, WORLD.surfaceY - 0.4);
  outLook.set(p.x, p.y + 0.55, p.z);
  return 52;
}
