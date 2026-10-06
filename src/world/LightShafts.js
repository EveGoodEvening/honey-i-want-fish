// God rays piercing down from the surface.
//
// One instanced draw: long quads laid along the refracted sun direction,
// billboarded around their own axis to face the camera, wrapped toroidally
// around the camera so they are always present yet stay put in the world
// (real parallax). The fragment shader builds a soft gaussian profile with
// drifting internal streaks, fades with depth, camera distance (matching the
// fog), proximity, the wrap boundary, and softly where the shaft meets the
// seabed (sampled from a heightmap) so no hard edges ever show.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { FOG_TAU_GLSL } from './waterShading.js';

export function createLightShafts(env) {
  const q = env.quality;
  const count = q === 'low' ? 26 : q === 'medium' ? 40 : 56;
  const wrap = 120;
  const rand = mulberry32(555);

  const base = new THREE.PlaneGeometry(1, 1, 1, 12);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.attributes.position);
  geo.setAttribute('uv', base.attributes.uv);
  const offsets = new Float32Array(count * 2);
  const params = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    offsets[i * 2] = rand() * wrap;
    offsets[i * 2 + 1] = rand() * wrap;
    const wide = rand();
    params[i * 4] = 2.5 + wide * wide * 11; // width (m)
    params[i * 4 + 1] = 55 + rand() * 30; // length (m)
    params[i * 4 + 2] = rand() * 100; // phase
    params[i * 4 + 3] = (0.4 + rand() * 0.6) * (1.2 - wide * 0.5); // intensity: wide ones dimmer
  }
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 2));
  geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
  geo.instanceCount = count;

  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: env.sunDirection },
    uWrap: { value: wrap },
    uColor: { value: new THREE.Color().setRGB(0.5, 0.8, 0.85) },
    uIntensity: { value: 1 },
    uFogDensity: { value: 0.03 },
    uHeightTex: { value: env.heightTexture },
    uHeightXf: { value: new THREE.Vector4(env.heightfield.size, env.heightfield.half, env.heightRange[0], env.heightRange[1] - env.heightRange[0]) },
  };

  const mat = new THREE.ShaderMaterial({
    name: 'LightShafts',
    uniforms,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform float uWrap;
      attribute vec2 aOffset;
      attribute vec4 aParams;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying float vT;
      varying float vFade;
      varying float vPhase;
      varying float vIntensity;
      void main() {
        float width = aParams.x;
        float len = aParams.y;
        float phase = aParams.z;
        vec3 down = -uSunDir;
        // Where this shaft crosses the camera's depth, wrapped around the camera.
        vec2 rel = mod( aOffset - cameraPosition.xz + 0.5 * uWrap, uWrap ) - 0.5 * uWrap;
        vec2 atCam = cameraPosition.xz + rel;
        float up = max( -cameraPosition.y, 0.0 ) / uSunDir.y;
        vec3 top = vec3( atCam.x + uSunDir.x * up, 0.0, atCam.y + uSunDir.z * up );
        top.xz += vec2( sin( uTime * 0.05 + phase ), cos( uTime * 0.04 + phase * 1.3 ) ) * 3.0;
        float t = 1.0 - uv.y; // 0 at the surface
        vec3 center = top + down * ( t * len );
        vec3 toCam = cameraPosition - center;
        vec3 side = cross( down, toCam );
        float sl = length( side );
        side = sl > 1e-3 ? side / sl : vec3( 1.0, 0.0, 0.0 );
        float w = width * ( 0.75 + 0.5 * t );
        vec3 wp = center + side * ( uv.x - 0.5 ) * w;
        vWorld = wp;
        vUv = uv;
        vT = t;
        vPhase = phase;
        vIntensity = aParams.w;
        // Fade near the wrap seam and when seen end-on (degenerate billboard).
        float rl = length( rel ) / ( 0.5 * uWrap );
        float endOn = abs( dot( normalize( toCam ), down ) );
        vFade = ( 1.0 - smoothstep( 0.6, 0.95, rl ) ) * ( 1.0 - smoothstep( 0.86, 0.98, endOn ) );
        gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uFogDensity;
      uniform sampler2D uHeightTex;
      uniform vec4 uHeightXf; // size, half, minY, rangeY
      varying vec2 vUv;
      varying vec3 vWorld;
      varying float vT;
      varying float vFade;
      varying float vPhase;
      varying float vIntensity;
      #include <common>
      ${FOG_TAU_GLSL}
      void main() {
        float x = vUv.x * 2.0 - 1.0;
        float prof = exp( -x * x * 2.6 ) * ( 1.0 - smoothstep( 0.75, 1.0, abs( x ) ) );
        // Broad internal variation that slides sideways as the waves move overhead.
        float st = 0.62
          + 0.24 * sin( vUv.x * 4.1 + vPhase * 3.0 + uTime * 0.13 )
          + 0.14 * sin( vUv.x * 7.3 - vPhase + uTime * 0.21 + vT * 2.0 );
        float a = prof * st;
        // Along the shaft: fade in below the surface, decay with depth.
        float depth = max( -vWorld.y, 0.0 );
        a *= smoothstep( 0.0, 0.04, vT ) * ( 1.0 - smoothstep( 0.8, 1.0, vT ) );
        a *= exp( -depth * 0.032 );
        // Soft contact with the seabed.
        vec2 huv = ( vWorld.xz + uHeightXf.y ) / uHeightXf.x;
        float ground = texture2D( uHeightTex, huv ).r * uHeightXf.w + uHeightXf.z;
        a *= smoothstep( 0.0, 7.0, vWorld.y - ground );
        // Distance: fade like the fog, and never clip through the camera.
        float d = length( vWorld - cameraPosition );
        a *= smoothstep( 1.5, 9.0, d ) * exp( -envFogTau( d, uFogDensity * 0.85 ) );
        // Strong forward scattering: brightest looking toward the light.
        vec3 V = ( vWorld - cameraPosition ) / max( d, 1e-3 );
        float fs = 0.45 + 0.75 * pow( max( dot( V, uSunDir ), 0.0 ), 3.0 );
        // Slow shimmer as surface waves focus and defocus the light.
        float fl = 0.7 + 0.3 * sin( uTime * 0.8 + vPhase * 5.0 ) * sin( uTime * 0.31 + vPhase );
        a *= fs * fl * vFade * vIntensity * uIntensity;
        gl_FragColor = vec4( uColor * a, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'light-shafts';
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  return { mesh, uniforms };
}
