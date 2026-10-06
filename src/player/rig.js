// Skeleton layout for 老公. All positions are bind-pose MODEL space in metres:
// feet on y = 0, character faces +Z, +X is the character's LEFT, +Y up.
// Every bone has an identity rest rotation, so a bone's model-space rotation
// is exactly "bind → current" for the vertices it carries. That keeps the IK
// and pose maths simple (see PlayerAnimator).
import * as THREE from 'three';

// Arms hang in a relaxed A-pose, 40° out from vertical.
const ARM_ANGLE = THREE.MathUtils.degToRad(40);
export const ARM_DIR_R = new THREE.Vector3(-Math.sin(ARM_ANGLE), -Math.cos(ARM_ANGLE), 0);
export const ARM_DIR_L = new THREE.Vector3(Math.sin(ARM_ANGLE), -Math.cos(ARM_ANGLE), 0);

export const UPPER_ARM_LEN = 0.29;
export const FOREARM_LEN = 0.255;
export const THIGH_LEN = 0.42;
export const SHIN_LEN = 0.415;

const SHOULDER_R = new THREE.Vector3(-0.182, 1.425, -0.012);
const SHOULDER_L = new THREE.Vector3(0.182, 1.425, -0.012);

function along(base, dir, len) {
  return base.clone().addScaledVector(dir, len);
}

const ELBOW_R = along(SHOULDER_R, ARM_DIR_R, UPPER_ARM_LEN);
const ELBOW_L = along(SHOULDER_L, ARM_DIR_L, UPPER_ARM_LEN);
const WRIST_R = along(ELBOW_R, ARM_DIR_R, FOREARM_LEN);
const WRIST_L = along(ELBOW_L, ARM_DIR_L, FOREARM_LEN);

// Hand frames at bind (unit vectors in model space).
//   a = along the hand (wrist → fingertips)
//   w = across the knuckles toward the thumb side (thumbs point forward)
//   n = palm normal (out of the palm, toward the thigh)
export const HAND_R = {
  a: ARM_DIR_R.clone(),
  w: new THREE.Vector3(0, 0, 1),
  n: new THREE.Vector3(0, 0, 1).cross(ARM_DIR_R).normalize(), // w × a → points toward body
};
export const HAND_L = {
  a: ARM_DIR_L.clone(),
  w: new THREE.Vector3(0, 0, 1),
  n: ARM_DIR_L.clone().cross(new THREE.Vector3(0, 0, 1)).normalize(), // a × w → toward body
};

function handPoint(wrist, frame, a, n, w) {
  return wrist.clone().addScaledVector(frame.a, a).addScaledVector(frame.n, n).addScaledVector(frame.w, w);
}

// [name, parent, position]
export const BONE_DEFS = [
  ['pelvis', null, new THREE.Vector3(0, 0.98, 0)],
  ['spine', 'pelvis', new THREE.Vector3(0, 1.1, -0.012)],
  ['chest', 'spine', new THREE.Vector3(0, 1.28, -0.014)],
  ['neck', 'chest', new THREE.Vector3(0, 1.47, -0.03)],
  ['head', 'neck', new THREE.Vector3(0, 1.585, -0.012)],

  ['clavR', 'chest', new THREE.Vector3(-0.03, 1.43, 0.01)],
  ['upperArmR', 'clavR', SHOULDER_R],
  ['foreArmR', 'upperArmR', ELBOW_R],
  ['sleeveR', 'foreArmR', along(ELBOW_R, ARM_DIR_R, 0.14)],
  ['handR', 'foreArmR', WRIST_R],

  ['clavL', 'chest', new THREE.Vector3(0.03, 1.43, 0.01)],
  ['upperArmL', 'clavL', SHOULDER_L],
  ['foreArmL', 'upperArmL', ELBOW_L],
  ['sleeveL', 'foreArmL', along(ELBOW_L, ARM_DIR_L, 0.14)],
  ['handL', 'foreArmL', WRIST_L],
  ['fingersL1', 'handL', handPoint(WRIST_L, HAND_L, 0.092, 0, -0.004)],
  ['fingersL2', 'fingersL1', handPoint(WRIST_L, HAND_L, 0.138, 0, -0.004)],
  ['thumbL', 'handL', handPoint(WRIST_L, HAND_L, 0.025, 0.004, 0.026)],

  ['thighR', 'pelvis', new THREE.Vector3(-0.09, 0.92, 0)],
  ['shinR', 'thighR', new THREE.Vector3(-0.095, 0.5, 0.012)],
  ['footR', 'shinR', new THREE.Vector3(-0.1, 0.085, -0.012)],
  ['thighL', 'pelvis', new THREE.Vector3(0.09, 0.92, 0)],
  ['shinL', 'thighL', new THREE.Vector3(0.095, 0.5, 0.012)],
  ['footL', 'shinL', new THREE.Vector3(0.1, 0.085, -0.012)],

  // Secondary-motion bones for the open work jacket (driven by ClothSprings).
  // Positions are filled in by PlayerModel from the jacket profile.
  ['hemB', 'spine', new THREE.Vector3()],
  ['hemBL', 'spine', new THREE.Vector3()],
  ['hemBR', 'spine', new THREE.Vector3()],
  ['hemSL', 'spine', new THREE.Vector3()],
  ['hemSR', 'spine', new THREE.Vector3()],
  ['hemFL', 'spine', new THREE.Vector3()],
  ['hemFR', 'spine', new THREE.Vector3()],
  ['lapelL', 'chest', new THREE.Vector3()],
  ['lapelR', 'chest', new THREE.Vector3()],
];

// Hem bones sit around the jacket at this height, at these angles
// (φ = 0 front, +φ toward the character's left).
export const HEM_Y = 1.03;
export const HEM_BONES = [
  ['hemB', Math.PI],
  ['hemBL', 2.2],
  ['hemBR', -2.2],
  ['hemSL', 1.3],
  ['hemSR', -1.3],
  ['hemFL', 0.42],
  ['hemFR', -0.42],
];
export const LAPEL_Y = 1.36;

export const BONE_INDEX = Object.fromEntries(BONE_DEFS.map(([n], i) => [n, i]));

/** Model-space bind position of a bone (shared, do not mutate). */
export function bindPos(name) {
  return BONE_DEFS[BONE_INDEX[name]][2];
}

// The knife: a hammer grip with the handle running across the fist (along w)
// and the blade leaving the thumb side, tipped slightly toward the fingers.
export const GRIP_OFFSET_R = new THREE.Vector3()
  .addScaledVector(HAND_R.a, 0.072)
  .addScaledVector(HAND_R.n, 0.026); // handle centre relative to the right wrist
export const KNIFE_DIR_BIND = HAND_R.w.clone().addScaledVector(HAND_R.a, 0.22).normalize();
// Edge faces the fingers' side (down when the arm hangs and the blade points forward).
export const KNIFE_EDGE_BIND = HAND_R.a.clone().addScaledVector(KNIFE_DIR_BIND, -HAND_R.a.dot(KNIFE_DIR_BIND)).normalize();

// Knife geometry (knife-local, +Z toward the tip, origin at the grip centre).
export const KNIFE = {
  handleBack: -0.066,
  handleFront: 0.042,
  bladeStart: 0.05,
  bladeEnd: 0.3,
};

// Body centre (Player.position) in model space: physics pivot / hurtbox.
export const BODY_CENTER_Y = 1.05;
export const HURTBOX_MODEL = new THREE.Vector3(0, 1.17, 0.01);
// Mouth relative to the head bone, used for breath bubbles.
export const MOUTH_OFFSET = new THREE.Vector3(0, -0.01, 0.105);
