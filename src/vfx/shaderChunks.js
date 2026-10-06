// GLSL snippets shared by every VFX material.
//
// Underwater lighting model used by all particles — the same one the meshes
// get (Environment): the sun colour and the diffuse fill are tuned for the
// CAMERA depth (env's sun colour already carries exp(-K · cameraDepth)), and
// each particle applies only the relative absorption between its own depth
// and the camera's, clamped like the meshes' envTransmit. Red dies first, so
// blood reads dark green-black at depth, as it really does.

export const WATER_LIGHT_PARS = /* glsl */ `
uniform vec3 uSunColor;   // linear sun radiance at the camera depth
uniform vec3 uAmbient;    // linear diffuse in-scatter at the camera depth
uniform vec3 uAbsorb;     // per-metre absorption (r, g, b) — the Environment's
uniform float uCamDepth;  // camera depth below the surface (m)
uniform float uSurfaceY;

vec3 waterTransmit(float worldY) {
  float depth = max(0.0, uSurfaceY - worldY);
  return min(exp(-uAbsorb * (depth - uCamDepth)), vec3(3.0));
}

vec3 waterLight(float worldY, float sunTerm) {
  return (uSunColor * sunTerm + uAmbient) * waterTransmit(worldY);
}

// Light seen in specular highlights / bright scattering (bubble rims, pressure
// fronts, the knife wake): it mostly comes from the bright surface window
// overhead, so it is much less tinted than the diffuse light at depth.
// Scaled so highlights keep the brightness they were tuned at.
vec3 highlightLight(float worldY) {
  vec3 l = waterLight(worldY, 1.0);
  float y = dot(l, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(y), l, 0.42) * 0.45;
}
`;

// Fog factor on the same curve as the scene fog (Environment's global fog
// chunk): optical depth tau = 0.72 x + 0.74 x², x = fogDensity · distance
// (green channel), so particles fade into the murk exactly like meshes do.
// Requires <fog_pars_fragment> (and the Environment's vFogWorldPos varying).
export const FOG_FACTOR = /* glsl */ `
float vfxFogFactor() {
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float x = fogDensity * length(vFogWorldPos - cameraPosition);
      return 1.0 - exp(-(0.72 * x + 0.74 * x * x));
    #else
      return smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #else
    return 0.0;
  #endif
}

vec3 vfxFogColor() {
  #ifdef USE_FOG
    return fogColor;
  #else
    return vec3(0.0);
  #endif
}
`;

// Camera-facing instanced quad. Per-instance attributes:
//   iPosSize: world xyz + radius (m)
//   iColor:   rgb tint + alpha
//   iParams:  x = rotation (rad), y/z/w = system specific
// Sprites never shrink below ~1.3 px (they fade instead) so tiny bubbles and
// specks do not shimmer, and sprites that come very close to the camera fade
// out instead of filling the screen with a clipped quad.
export const BILLBOARD_VERTEX = /* glsl */ `
attribute vec4 iPosSize;
attribute vec4 iColor;
attribute vec4 iParams;

uniform float uViewportH;
uniform vec3 uSunView;     // sun direction in view space (unit)
uniform float uNearFade;   // metres in front of the camera where sprites vanish
uniform float uDepthBias;  // fraction of the radius the sprite is pulled toward the camera (depth only)

varying vec2 vUv;
varying vec4 vColor;
varying vec4 vParams;
varying float vWorldY;
varying vec2 vSunUv;       // sun direction in sprite-local 2D space
varying float vPx;         // projected radius in pixels

#include <fog_pars_vertex>

void main() {
  vec4 mvCenter = viewMatrix * vec4(iPosSize.xyz, 1.0);
  float radius = iPosSize.w;
  float dist = max(0.05, -mvCenter.z);

  float px = radius * projectionMatrix[1][1] * 0.5 * uViewportH / dist;
  float grow = max(1.0, 1.3 / max(px, 1e-4));
  float alphaComp = 1.0 / (grow * grow);
  radius *= grow;
  vPx = px * grow;

  float c = cos(iParams.x);
  float s = sin(iParams.x);
  vec2 q = position.xy * 2.0;
  vec2 rq = vec2(c * q.x - s * q.y, s * q.x + c * q.y);

  vec4 mvPosition = mvCenter;
  mvPosition.xy += rq * radius;

  float nearFade = smoothstep(uNearFade + radius * 0.35, uNearFade + radius * 1.25 + 0.35, dist);
  // behind the camera -> invisible
  nearFade *= step(0.0, -mvCenter.z);

  vUv = position.xy + 0.5;
  vColor = vec4(iColor.rgb, iColor.a * alphaComp * nearFade);
  vParams = iParams;
  vWorldY = iPosSize.y;

  vec2 sv = uSunView.xy;
  float sl = length(sv);
  sv = sl > 1e-4 ? sv / sl : vec2(0.0, 1.0);
  vSunUv = vec2(c * sv.x + s * sv.y, -s * sv.x + c * sv.y);

  gl_Position = projectionMatrix * mvPosition;

  // Pseudo soft-particles: without a scene depth texture, big sprites cut hard
  // straight lines where they intersect opaque bodies. Only the depth is pulled
  // toward the camera (x, y and w stay untouched, so rasterisation and
  // clipping are exactly those of the unbiased quad).
  if (uDepthBias > 0.0) {
    float bias = clamp(radius * uDepthBias, 0.0, max(0.0, dist - uNearFade - 0.1));
    vec4 clipB = projectionMatrix * vec4(mvPosition.xy, mvPosition.z + bias, 1.0);
    gl_Position.z = clipB.z / clipB.w * gl_Position.w;
  }
  #include <fog_vertex>
}
`;
