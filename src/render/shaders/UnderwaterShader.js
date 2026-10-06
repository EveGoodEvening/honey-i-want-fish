// UnderwaterShader — the linear-HDR "lens" stage, runs after bloom and before
// OutputPass (tone mapping + sRGB). Responsible for everything that moves or
// adds light in the image:
//   - screen-space refraction wobble (animated value noise, stronger at the edges)
//   - expanding shock-ring distortions (parry / roar) and image shake
//   - radial (zoom) blur for dodges / heavy hits
//   - screen-space god rays composite (texture produced by GodRaysPass)
//   - out-of-focus particulate drifting in front of the lens, lit by the scene
//   - full-screen flashes (flash(color, intensity, duration))
//   - exposure nudges
// Chromatic aberration, grading, vignette and grain happen later in display
// space (GradeShader): splitting channels of HDR values here would turn every
// tiny specular sparkle into saturated red/green/blue pixels.
import { Vector2, Vector3, Vector4 } from 'three';
import { FULLSCREEN_VERTEX, NOISE_GLSL } from './common.glsl.js';

export function createUnderwaterShader({ radialSamples = 8 } = {}) {
  return {
    name: 'UnderwaterShader',
    defines: {
      RADIAL_SAMPLES: radialSamples,
    },
    uniforms: {
      tDiffuse: { value: null },
      tGodRays: { value: null },
      tDirt: { value: null },
      uAspect: { value: 16 / 9 },
      uTime: { value: 0 },
      uWobble: { value: 0.0016 },
      uWobbleScale: { value: 2.2 },
      uRadialBlur: { value: 0 },
      uBlurCenter: { value: new Vector2(0.5, 0.5) },
      uShake: { value: new Vector2() },
      // xy = centre (uv), z = radius (aspect-corrected uv units), w = amplitude
      uRing0: { value: new Vector4(0.5, 0.5, 0, 0) },
      uRing0Width: { value: 0.08 },
      uRing1: { value: new Vector4(0.5, 0.5, 0, 0) },
      uRing1Width: { value: 0.15 },
      uGodRays: { value: 0 },
      uGodRayTint: { value: new Vector3(0.75, 0.95, 1.0) },
      uDirt: { value: 0.5 },
      uDirtOffset: { value: new Vector4() },
      uFlashColor: { value: new Vector3(1, 1, 1) },
      uFlash: { value: 0 },
      uExposure: { value: 1 },
    },
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform sampler2D tGodRays;
      uniform sampler2D tDirt;
      uniform float uAspect;
      uniform float uTime;
      uniform float uWobble;
      uniform float uWobbleScale;
      uniform float uRadialBlur;
      uniform vec2 uBlurCenter;
      uniform vec2 uShake;
      uniform vec4 uRing0;
      uniform float uRing0Width;
      uniform vec4 uRing1;
      uniform float uRing1Width;
      uniform float uGodRays;
      uniform vec3 uGodRayTint;
      uniform float uDirt;
      uniform vec4 uDirtOffset;
      uniform vec3 uFlashColor;
      uniform float uFlash;
      uniform float uExposure;
      varying vec2 vUv;

      ${NOISE_GLSL}

      // Displacement of a refractive pressure ring centred at ring.xy.
      vec2 ringOffset(vec2 uv, vec4 ring, float width) {
        if (ring.w <= 0.0) return vec2(0.0);
        vec2 d = (uv - ring.xy) * vec2(uAspect, 1.0);
        float dist = length(d);
        float x = (dist - ring.z) / width;
        // Derivative-of-gaussian profile: pushes outward on the leading edge,
        // inward on the trailing edge, like a real refractive shock front.
        float prof = -x * exp(-x * x * 1.6);
        vec2 dir = d / max(dist, 1e-4);
        return dir * prof * ring.w * vec2(1.0 / uAspect, 1.0);
      }

      void main() {
        vec2 uv = vUv + uShake;
        vec2 centred = (uv - 0.5) * vec2(uAspect, 1.0);
        // 0 at the centre, 1 at the corners.
        float r = length(centred) / length(vec2(uAspect, 1.0) * 0.5);
        float edge = smoothstep(0.1, 1.0, r);

        // --- refraction wobble: two drifting octaves of value noise ---
        vec2 p = uv * vec2(uAspect, 1.0) * uWobbleScale;
        float t = uTime;
        vec2 n = vec2(
          vnoise(p + vec2(t * 0.13, t * 0.07)),
          vnoise(p * 1.37 + vec2(-t * 0.09, t * 0.11) + 17.3)
        ) - 0.5;
        n += 0.5 * (vec2(
          vnoise(p * 3.1 + vec2(t * 0.23, -t * 0.19) + 3.7),
          vnoise(p * 2.9 + vec2(-t * 0.17, -t * 0.21) + 9.1)
        ) - 0.5);
        uv += n * uWobble * (0.3 + 1.7 * edge * edge);

        // --- shock rings ---
        uv += ringOffset(uv, uRing0, uRing0Width);
        uv += ringOffset(uv, uRing1, uRing1Width);

        vec3 col;
        if (uRadialBlur > 0.001) {
          // Zoom blur toward uBlurCenter, weighted toward the unblurred tap.
          vec2 toC = uv - uBlurCenter;
          vec3 acc = vec3(0.0);
          float wsum = 0.0;
          for (int i = 0; i < RADIAL_SAMPLES; i++) {
            float f = float(i) / float(RADIAL_SAMPLES - 1);
            float s = 1.0 - uRadialBlur * 0.11 * f * (0.4 + r);
            float w = 1.0 - 0.6 * f;
            acc += texture2D(tDiffuse, uBlurCenter + toC * s).rgb * w;
            wsum += w;
          }
          col = acc / wsum;
        } else {
          col = texture2D(tDiffuse, uv).rgb;
        }

        // --- screen-space god rays (already blurred, low res) ---
        vec3 rays = vec3(0.0);
        if (uGodRays > 0.0005) {
          rays = texture2D(tGodRays, uv).rgb * uGodRays;
          col += rays * uGodRayTint;
        }

        // --- out-of-focus particulate in front of the lens ---
        if (uDirt > 0.0) {
          vec2 duv = vUv * vec2(uAspect, 1.0);
          float d1 = texture2D(tDirt, duv * 0.55 + uDirtOffset.xy).r;
          float d2 = texture2D(tDirt, duv * 0.9 + uDirtOffset.zw).g;
          // Motes only show when backlit. The large defocused discs (R) need
          // the sun itself (the god-ray term) — backscatter only glows when
          // looking into the light; lit by the scene they read as a dirty
          // lens. The small specks (G) catch a little scene light too.
          float sun = luma(rays);
          float motes = d1 * 0.7 * sun * 12.0 + d2 * 0.45 * (luma(col) * 0.25 + sun * 2.5 + 0.004);
          col += motes * uDirt * vec3(0.8, 0.95, 1.0);
        }

        // --- full-screen flash: colourise (keeps the image structure) plus a
        // little additive glow; heavier toward the edges ---
        if (uFlash > 0.0005) {
          float w = clamp(uFlash * mix(0.4, 1.0, edge), 0.0, 1.5);
          vec3 tinted = col * uFlashColor * 2.2 + uFlashColor * 0.025;
          col = mix(col, tinted, clamp(w * 0.65, 0.0, 1.0)) + uFlashColor * w * 0.1;
        }

        col *= uExposure;
        gl_FragColor = vec4(max(col, 0.0), 1.0);
      }
    `,
  };
}
