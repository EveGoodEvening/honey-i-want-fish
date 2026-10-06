// GodRaysPass — screen-space light shafts streaming from the projected sun.
//
// Runs on the linear HDR scene buffer at quarter resolution:
//   1. mask   : bright pixels (Snell's window, lit water, shafts) weighted by
//               proximity to the sun's screen position. Dark silhouettes
//               (a shark passing overhead) stay black and therefore *occlude*
//               the rays — exactly what we want for the megalodon.
//   2. blur A : radial blur toward the sun with long steps
//   3. blur B : radial blur with short steps (fills the gaps; N*N effective taps)
// The result texture is composited by UnderwaterShader. This pass does not
// touch the composer buffers (needsSwap = false).
import {
  BufferGeometry,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FULLSCREEN_VERTEX } from '../shaders/common.glsl.js';

const MASK_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uSun;
  uniform float uAspect;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;
  void main() {
    // 4-tap box downsample keeps the quarter-res mask from shimmering.
    vec2 o = vec2(0.0015, 0.0025);
    vec3 c = texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb
           + texture2D(tDiffuse, vUv + vec2( o.x, -o.y)).rgb
           + texture2D(tDiffuse, vUv + vec2(-o.x,  o.y)).rgb
           + texture2D(tDiffuse, vUv + vec2( o.x,  o.y)).rgb;
    c *= 0.25;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // keep only the energy above the threshold (a soft knee avoids popping)
    float excess = max(l - uThreshold, 0.0);
    excess = excess * excess / (excess + uKnee);
    vec3 m = c * (excess / max(l, 1e-4));
    // soft-clip so one hot specular can't dominate the streaks
    m /= 1.0 + dot(m, vec3(0.2126, 0.7152, 0.0722)) * 0.6;
    vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
    float fall = exp(-dot(d, d) * 2.2);
    gl_FragColor = vec4(m * fall, 1.0);
  }
`;

const BLUR_FRAG = /* glsl */ `
  uniform sampler2D tInput;
  uniform vec2 uSun;
  uniform float uStep;
  uniform float uDecay;
  uniform float uWeight;
  varying vec2 vUv;
  void main() {
    vec2 uv = vUv;
    vec2 delta = (vUv - uSun) * uStep;
    // Limit very long steps when the sun is far off-screen.
    float len = length(delta);
    delta *= min(1.0, 0.04 / max(len, 1e-5));
    float decay = 1.0;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < SAMPLES; i++) {
      vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
      acc += texture2D(tInput, uv).rgb * decay * inside.x * inside.y;
      decay *= uDecay;
      uv -= delta;
    }
    gl_FragColor = vec4(acc * uWeight, 1.0);
  }
`;

function blurMaterial(samples) {
  return new ShaderMaterial({
    defines: { SAMPLES: samples },
    uniforms: {
      tInput: { value: null },
      uSun: { value: new Vector2(0.5, 1.2) },
      uStep: { value: 1 / samples },
      uDecay: { value: 0.97 },
      uWeight: { value: 1 / samples },
    },
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: BLUR_FRAG,
    depthTest: false,
    depthWrite: false,
  });
}

export class GodRaysPass extends Pass {
  constructor({ samples = 28, type = HalfFloatType, divisor = 4 } = {}) {
    super();
    this.needsSwap = false;
    this.samples = samples;
    this.divisor = divisor;
    this.sunUv = new Vector2(0.5, 1.2);
    this.aspect = 16 / 9;

    const opts = { type, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter };
    this.rtA = new WebGLRenderTarget(4, 4, opts);
    this.rtB = new WebGLRenderTarget(4, 4, opts);
    this.rtA.texture.name = 'GodRays.A';
    this.rtB.texture.name = 'GodRays.B';

    this.maskMaterial = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uSun: { value: this.sunUv },
        uAspect: { value: this.aspect },
        uThreshold: { value: 0.55 },
        uKnee: { value: 0.35 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: MASK_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.blurA = blurMaterial(samples);
    this.blurB = blurMaterial(samples);
    this.quad = new FullScreenQuad(this.maskMaterial);

    this._setupWeights();
  }

  _setupWeights() {
    const n = this.samples;
    const setup = (mat, step, decay) => {
      mat.uniforms.uStep.value = step;
      mat.uniforms.uDecay.value = decay;
      // normalise the geometric decay series so the pass preserves energy
      const sum = (1 - Math.pow(decay, n)) / (1 - decay);
      mat.uniforms.uWeight.value = 1 / sum;
    };
    setup(this.blurA, 0.95 / n, 0.968);
    setup(this.blurB, 0.95 / (n * n), 0.995);
  }

  /** Texture the composite shader samples. */
  get texture() {
    return this.rtA.texture;
  }

  /**
   * Builds this pass's programs without drawing (PostFX.warmup): a draw would
   * make three query the link status at once, blocking on every shader still
   * compiling. Compiled exactly as render() draws them — a full-screen
   * triangle, no lights or fog, into a linear render target. Returns the
   * materials.
   */
  compile(renderer) {
    if (!this._compileMesh) {
      // FullScreenQuad's geometry is private; this one has the same attributes
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
      geo.setAttribute('uv', new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
      this._compileMesh = new Mesh(geo, this.maskMaterial);
      this._compileCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }
    const mats = [this.maskMaterial, this.blurA, this.blurB];
    const prev = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.rtA);
      for (const m of mats) {
        this._compileMesh.material = m;
        renderer.compile(this._compileMesh, this._compileCamera);
      }
    } finally {
      renderer.setRenderTarget(prev);
    }
    return mats;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.round(width / this.divisor));
    const h = Math.max(1, Math.round(height / this.divisor));
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.aspect = width / Math.max(1, height);
    this.maskMaterial.uniforms.uAspect.value = this.aspect;
  }

  render(renderer, writeBuffer, readBuffer) {
    const sun = this.sunUv;
    this.maskMaterial.uniforms.uSun.value.copy(sun);
    this.blurA.uniforms.uSun.value.copy(sun);
    this.blurB.uniforms.uSun.value.copy(sun);

    this.maskMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.maskMaterial;
    renderer.setRenderTarget(this.rtA);
    this.quad.render(renderer);

    this.blurA.uniforms.tInput.value = this.rtA.texture;
    this.quad.material = this.blurA;
    renderer.setRenderTarget(this.rtB);
    this.quad.render(renderer);

    this.blurB.uniforms.tInput.value = this.rtB.texture;
    this.quad.material = this.blurB;
    renderer.setRenderTarget(this.rtA);
    this.quad.render(renderer);
  }

  dispose() {
    this.rtA.dispose();
    this.rtB.dispose();
    this.maskMaterial.dispose();
    this.blurA.dispose();
    this.blurB.dispose();
    this.quad.dispose();
    this._compileMesh?.geometry.dispose();
  }
}
