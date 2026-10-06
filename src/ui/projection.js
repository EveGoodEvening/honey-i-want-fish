// World → screen helpers for the HUD (lock reticle, threat arrows, hit
// direction, floating combat text). All allocation-free.
import * as THREE from 'three';

const _v = new THREE.Vector3();

/** Current CSS-pixel size of the UI layer; UI keeps it in sync on resize. */
export const viewport = { w: 1280, h: 720 };

/**
 * Projects `world` with `camera` (whose matrixWorldInverse must be current).
 * Writes { x, y } in CSS pixels, ndcX/ndcY, `behind` (behind the near plane)
 * and `onScreen` (in front and inside the given NDC margin) into `out`.
 */
export function projectPoint(camera, world, out, margin = 1) {
  _v.copy(world).applyMatrix4(camera.matrixWorldInverse);
  out.camX = _v.x;
  out.camY = _v.y;
  out.camZ = _v.z;
  out.behind = _v.z > -camera.near;
  _v.applyMatrix4(camera.projectionMatrix);
  out.ndcX = _v.x;
  out.ndcY = _v.y;
  out.x = (_v.x * 0.5 + 0.5) * viewport.w;
  out.y = (0.5 - _v.y * 0.5) * viewport.h;
  out.onScreen = !out.behind && Math.abs(_v.x) <= margin && Math.abs(_v.y) <= margin;
  return out;
}

export function makeProjection() {
  return { x: 0, y: 0, ndcX: 0, ndcY: 0, camX: 0, camY: 0, camZ: 0, behind: false, onScreen: false };
}

/**
 * Screen-plane angle (radians, 0 = up/ahead, clockwise positive) of a world
 * point around the view centre, treating the scene like a compass: things in
 * front are "up", behind are "down". Used for the damage-direction arcs.
 */
export function compassAngle(camera, world) {
  _v.copy(world).applyMatrix4(camera.matrixWorldInverse);
  const horiz = Math.hypot(_v.x, _v.z);
  if (horiz < Math.abs(_v.y) * 0.35) {
    // Almost straight above / below the camera: above → ahead, below → behind.
    return _v.y > 0 ? 0 : Math.PI;
  }
  return Math.atan2(_v.x, -_v.z);
}

/** Point an enemy's representative "aim point": head hurtbox if any, else its position. */
export function enemyAimPoint(enemy) {
  const hb = enemy?.hurtboxes;
  if (hb) {
    for (let i = 0; i < hb.length; i++) if (hb[i].part === 'head') return hb[i].center;
  }
  return enemy.position;
}
