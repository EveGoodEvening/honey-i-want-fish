// GradeShader — display-space finishing stage (runs after OutputPass, so its
// input is already ACES tone mapped and sRGB encoded). Responsible for:
//   - radial chromatic aberration (lens fringe + punches). Done here, on
//     bounded display values, so HDR sparkles don't split into pure R/G/B dots
//   - colour grading: split toning (teal-green shadows, cool highlights),
//     saturation, gentle pivot contrast and a black lift so the murk never
//     crushes to pure black
//   - vignette that tightens with danger and turns dark red as health drops,
//     with a heartbeat throb and a "tunnel vision" mode for grabs
//   - red edge pulses when the player is hurt
//   - film grain + dithering (kills banding in the deep-blue gradients)
import { Vector2, Vector3, Vector4 } from 'three';
import { FULLSCREEN_VERTEX, NOISE_GLSL } from './common.glsl.js';

export function createGradeShader() {
  return {
    name: 'GradeShader',
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: new Vector2(1280, 720) },
      uAspect: { value: 16 / 9 },
      uTime: { value: 0 },
      uCA: { value: 0.0016 },
      uSaturation: { value: 0.86 },
      uContrast: { value: 1.08 },
      uPivot: { value: 0.32 },
      uLift: { value: new Vector3(0.006, 0.014, 0.016) },
      uShadowTint: { value: new Vector3(-0.012, 0.01, 0.006) },
      uHighlightTint: { value: new Vector3(-0.01, 0.006, 0.014) },
      uDesat: { value: 0 },
      uDarken: { value: 0 },
      // x = strength, y = inner radius, z = outer radius, w = unused
      uVignette: { value: new Vector4(0.45, 0.42, 1.25, 0) },
      uVignetteColor: { value: new Vector3(0.0, 0.012, 0.016) },
      uRedEdge: { value: 0 },
      uRedEdgeColor: { value: new Vector3(0.5, 0.025, 0.02) },
      uGrain: { value: 0.03 },
    },
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec2 uResolution;
      uniform float uAspect;
      uniform float uTime;
      uniform float uCA;
      uniform float uSaturation;
      uniform float uContrast;
      uniform float uPivot;
      uniform vec3 uLift;
      uniform vec3 uShadowTint;
      uniform vec3 uHighlightTint;
      uniform float uDesat;
      uniform float uDarken;
      uniform vec4 uVignette;
      uniform vec3 uVignetteColor;
      uniform float uRedEdge;
      uniform vec3 uRedEdgeColor;
      uniform float uGrain;
      varying vec2 vUv;

      ${NOISE_GLSL}

      void main() {
        vec2 cd = (vUv - 0.5) * vec2(uAspect, 1.0);
        float cr = length(cd) / length(vec2(uAspect, 1.0) * 0.5);
        vec2 off = (vUv - 0.5) * uCA * (0.15 + 1.1 * cr * cr);
        vec3 col;
        col.r = texture2D(tDiffuse, vUv + off).r;
        col.g = texture2D(tDiffuse, vUv).g;
        col.b = texture2D(tDiffuse, vUv - off * 1.15).b;

        // ---------------- grading ----------------
        float l = luma(col);
        // split toning
        col += uShadowTint * (1.0 - smoothstep(0.0, 0.42, l));
        col += uHighlightTint * smoothstep(0.45, 1.0, l);
        // saturation (+ kill / death desaturation)
        l = luma(col);
        col = mix(vec3(l), col, uSaturation * (1.0 - uDesat));
        // pivot contrast in a perceptual-ish (sqrt) domain so the darks are not crushed
        col = max(col, 0.0);
        vec3 s = sqrt(col);
        float sp = sqrt(uPivot);
        s = (s - sp) * uContrast + sp;
        col = max(s, 0.0);
        col *= col;
        // black lift (teal) keeps the deep murk readable
        col = col + uLift * (1.0 - col);
        col *= 1.0 - uDarken;

        // ---------------- vignette ----------------
        vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
        float r = length(d) / length(vec2(uAspect, 1.0) * 0.5);
        float v = smoothstep(uVignette.y, uVignette.z, r);
        v = v * v * (3.0 - 2.0 * v);
        col = mix(col, uVignetteColor * (0.6 + 0.4 * luma(col)), clamp(v * uVignette.x, 0.0, 1.0));

        // ---------------- red edge pulse ----------------
        if (uRedEdge > 0.0005) {
          float e = smoothstep(0.35, 1.05, r);
          float w = clamp(uRedEdge * (e * 1.2 + 0.08), 0.0, 1.0);
          col = mix(col, uRedEdgeColor * (0.5 + luma(col)), w);
        }

        // ---------------- grain + dither ----------------
        vec2 px = vUv * uResolution;
        float g = hash12(px + fract(uTime * 7.31) * vec2(97.13, 41.77)) - 0.5;
        g += hash12(px * 1.37 + fract(uTime * 3.17) * vec2(13.3, 71.1)) - 0.5;
        l = luma(col);
        col += g * uGrain * (0.45 + 0.55 * (1.0 - l)) * (0.35 + 0.65 * sqrt(max(l, 0.0) + 0.02));
        col += (hash12(px + 0.5 + fract(uTime) * 61.0) - 0.5) / 255.0;

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `,
  };
}
