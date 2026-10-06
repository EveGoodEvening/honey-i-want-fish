// ScenePass — renders game.scene into linear HDR.
//
// With MSAA (samples > 0) the scene goes into a dedicated multisampled
// HalfFloat target that is resolved and copied into the composer's read
// buffer, so the rest of the chain ping-pongs between cheap single-sample
// targets. Without MSAA it renders straight into the read buffer (the
// composer targets then carry a depth buffer).
//
// Rendering into a render target means WebGLRenderer applies neither tone
// mapping nor the sRGB transfer: the buffer stays linear. OutputPass applies
// renderer.toneMapping (ACES) + sRGB exactly once at the end of the chain.
//
// `compact: true` stores the MSAA target as R11F_G11F_B10F (4 bytes/sample
// instead of RGBA16F's 8): the scene's alpha is never read, and the 6/5-bit
// mantissas are far below the grain/dither of the final image. Halves the
// multisample memory and the bandwidth of all the transparent overdraw
// (particles, clouds, shafts). PostFX only asks for it when the format is
// renderable with that many samples.
import { NoBlending, RGBFormat, ShaderMaterial, WebGLRenderTarget } from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FULLSCREEN_VERTEX } from '../shaders/common.glsl.js';

// Resolve copy with a firefly guard: NaN/Inf are zeroed and extreme HDR
// spikes (grazing-angle speculars on tiny fish, knife glints) are clamped
// and pushed toward white, so bloom turns them into clean sparkles instead
// of large coloured halos.
const RESOLVE_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uMax;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
    c = max(c, 0.0);
    float m = max(c.r, max(c.g, c.b));
    if (m > uMax * 0.25) {
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(c, vec3(max(l, m * 0.6)), smoothstep(uMax * 0.25, uMax * 2.0, m));
      m = max(c.r, max(c.g, c.b));
      c *= min(1.0, uMax / m);
    }
    gl_FragColor = vec4(c, 1.0);
  }
`;

export class ScenePass extends Pass {
  constructor(scene, camera, { samples = 0, type, compact = false } = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.samples = samples;
    this.target = null;
    this.compact = false;
    if (samples > 0) {
      this.target = new WebGLRenderTarget(4, 4, { type, samples, depthBuffer: true, stencilBuffer: false });
      this.target.texture.name = 'ScenePass.msaa';
      if (compact) {
        // three picks the GL internal format by name; RGB + (Half)Float is a
        // valid upload combination for R11F_G11F_B10F.
        this.target.texture.format = RGBFormat;
        this.target.texture.internalFormat = 'R11F_G11F_B10F';
        this.compact = true;
      }
      this.copyMaterial = new ShaderMaterial({
        uniforms: { tDiffuse: { value: null }, uMax: { value: 24 } },
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: RESOLVE_FRAG,
        blending: NoBlending,
        depthTest: false,
        depthWrite: false,
      });
      this.copyQuad = new FullScreenQuad(this.copyMaterial);
    }
  }

  setSize(width, height) {
    this.target?.setSize(width, height);
  }

  render(renderer, writeBuffer, readBuffer) {
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    if (this.target) {
      renderer.setRenderTarget(this.target);
      renderer.render(this.scene, this.camera);
      this.copyMaterial.uniforms.tDiffuse.value = this.target.texture;
      renderer.setRenderTarget(readBuffer);
      this.copyQuad.render(renderer);
    } else {
      renderer.setRenderTarget(readBuffer);
      renderer.render(this.scene, this.camera);
    }
    renderer.autoClear = oldAutoClear;
  }

  dispose() {
    this.target?.dispose();
    this.copyMaterial?.dispose();
    this.copyQuad?.dispose();
  }
}
