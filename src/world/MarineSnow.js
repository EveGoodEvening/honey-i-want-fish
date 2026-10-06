// Marine snow / suspended particulate. Thousands of soft points in a box that
// wraps toroidally around the camera (infinite, but world-anchored so motion
// reads correctly). Slow sinking + meander + current drift. A few motes catch
// the sun as glints when you look toward the light. Close motes grow into
// soft out-of-focus discs and fade so nothing pops at the lens.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { FOG_TAU_GLSL } from './waterShading.js';

export function createMarineSnow(env) {
  const q = env.quality;
  const count = q === 'low' ? 3000 : q === 'medium' ? 7000 : 12000;
  const box = 36;
  const rand = mulberry32(1234);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = rand();
    seeds[i * 4 + 1] = rand();
    seeds[i * 4 + 2] = rand();
    seeds[i * 4 + 3] = rand();
  }
  const geo = new THREE.BufferGeometry();
  // `position` is required by three; the shader only uses aSeed.
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));

  const uniforms = {
    uTime: { value: 0 },
    uBox: { value: box },
    uPixelScale: { value: 600 },
    uFogDensity: { value: 0.03 },
    uColor: { value: new THREE.Color().setRGB(0.3, 0.45, 0.45) },
    uSunDir: { value: env.sunDirection },
    uCurrent: { value: new THREE.Vector3(0.05, 0, 0.03) },
    uOpacity: { value: 1 },
  };

  const mat = new THREE.ShaderMaterial({
    name: 'MarineSnow',
    uniforms,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uBox;
      uniform float uPixelScale;
      uniform float uFogDensity;
      uniform vec3 uSunDir;
      uniform vec3 uCurrent;
      attribute vec4 aSeed;
      varying float vAlpha;
      varying float vGlint;
      varying float vSoft;
      ${FOG_TAU_GLSL}
      void main() {
        float r = aSeed.w;
        vec3 p = aSeed.xyz * uBox;
        p += uCurrent * uTime;
        p.y -= uTime * ( 0.03 + r * 0.05 );
        p.x += sin( uTime * 0.13 + r * 41.0 ) * 0.5;
        p.z += cos( uTime * 0.11 + r * 23.0 ) * 0.5;
        p.y += sin( uTime * 0.17 + r * 13.0 ) * 0.25;
        vec3 rel = mod( p - cameraPosition + 0.5 * uBox, uBox ) - 0.5 * uBox;
        vec3 wp = cameraPosition + rel;
        vec4 mv = viewMatrix * vec4( wp, 1.0 );
        gl_Position = projectionMatrix * mv;
        float dist = max( -mv.z, 0.01 );
        float size = mix( 0.01, 0.05, r * r * r );
        float px = size * uPixelScale / dist;
        // Out-of-focus growth for the closest motes.
        float bokeh = 1.0 - smoothstep( 0.4, 2.5, dist );
        px += bokeh * 10.0 * ( 0.4 + r );
        gl_PointSize = clamp( px, 1.0, 48.0 );
        vSoft = bokeh;
        float a = smoothstep( 0.2, 1.4, dist ) * ( 1.0 - smoothstep( 0.32, 0.5, length( rel ) / uBox ) );
        a *= exp( -envFogTau( dist, uFogDensity ) ) * exp( -dist * 0.05 );
        a *= clamp( px, 0.2, 1.0 ); // sub-pixel motes fade instead of flickering
        a *= 1.0 - smoothstep( -0.6, -0.1, wp.y ); // none above the surface
        a *= 1.0 - bokeh * 0.6;
        vec3 V = normalize( wp - cameraPosition );
        float fs = pow( max( dot( V, uSunDir ), 0.0 ), 5.0 );
        float glinter = step( 0.95, fract( r * 17.31 ) );
        vGlint = fs * ( 0.25 + glinter * 1.8 ) * ( 0.6 + 0.4 * sin( uTime * 3.0 + r * 60.0 ) );
        vAlpha = a * ( 0.3 + 0.4 * fract( r * 7.13 ) );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlpha;
      varying float vGlint;
      varying float vSoft;
      #include <common>
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length( c ) * 2.0;
        float m = 1.0 - smoothstep( mix( 0.25, 0.0, vSoft ), 1.0, d );
        m *= m;
        if ( m * vAlpha < 0.002 ) discard;
        vec3 col = uColor * ( 1.0 + vGlint );
        gl_FragColor = vec4( col * m * vAlpha * uOpacity, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const points = new THREE.Points(geo, mat);
  points.name = 'marine-snow';
  points.frustumCulled = false;
  points.renderOrder = 6;
  return { points, uniforms };
}
