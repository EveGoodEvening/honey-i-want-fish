// The sea surface seen from below, and the water "sky" behind everything.
//
// Surface: a camera-following plane at y = 0 with animated wave normals.
// Each pixel refracts the view ray out of the water (n = 1.333): inside the
// ~48.6° Snell's window you see a compressed bright sky and the sun's glare;
// outside it the surface is a total-internal-reflection mirror of the dark
// depths. Fresnel blends the rim and is eased into full reflection near the
// critical angle, so the window's edge is a soft ring rather than a ragged
// per-ripple cut. The sky light is absorbed per channel along the water path
// (reds first), so from combat depth the window is a deep cyan disc instead
// of a white hole; a huge body overhead (Environment occlusion) dims it.
// Ripples average out with distance. Distance fog does the rest.
//
// Backdrop: a rotation-only dome drawn first, coloured with exactly the same
// water-radiance function the fog uses, so geometry dissolves into it.
import * as THREE from 'three';

export function createBackdrop() {
  const geo = new THREE.SphereGeometry(1, 48, 24);
  const mat = new THREE.ShaderMaterial({
    name: 'WaterBackdrop',
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      #include <fog_pars_vertex>
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * vec4( mat3( viewMatrix ) * position, 1.0 );
        gl_Position = vec4( p.xy, p.w * 0.9999, p.w );
        #ifdef USE_FOG
          vFogDepth = 0.0;
          vFogWorldPos = vec3( 0.0 );
        #endif
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      #include <common>
      #include <dithering_pars_fragment>
      #include <fog_pars_fragment>
      void main() {
        vec3 dir = normalize( vDir );
        #ifdef USE_FOG
          vec3 c = envWaterRadiance( envOutputToLinear( fogColor ), dir, 1e4 );
          gl_FragColor = vec4( envLinearToOutput( c ), 1.0 );
        #else
          gl_FragColor = vec4( 0.0, 0.04, 0.06, 1.0 );
        #endif
        #include <dithering_fragment>
      }
    `,
    fog: true,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    dithering: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water-backdrop';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

export function createSurface(env) {
  const geo = new THREE.PlaneGeometry(1600, 1600, 1, 1);
  geo.rotateX(Math.PI / 2); // face down into the water
  const s = env.sunDirection;
  // The sun in air: un-refract the underwater sun direction.
  const h = Math.hypot(s.x, s.z);
  const sinAir = Math.min(0.999, (h / Math.hypot(h, s.y)) * 1.333);
  const sunAir = new THREE.Vector3(s.x, 0, s.z).normalize().multiplyScalar(sinAir);
  sunAir.y = Math.sqrt(1 - sinAir * sinAir);

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uWaves: { value: null },
      uSunAir: { value: sunAir },
      uSkyZenith: { value: new THREE.Color().setRGB(0.32, 0.55, 0.85) },
      uSkyHorizon: { value: new THREE.Color().setRGB(0.55, 0.78, 0.92) },
      uSunColor: { value: new THREE.Color().setRGB(1.0, 0.95, 0.85) },
      // Tuned together with uSkyAbsorb / uWindowScatter: ≤ 5 % clipped looking
      // up from -20 m, still a visible disc from -41 m.
      uSkyIntensity: { value: 1.7 },
      uWaveStrength: { value: 0.11 },
      uMirrorTint: { value: new THREE.Color().setRGB(1.0, 1.0, 1.0) },
      // Per-metre absorption of the sky light on its way down to the eye.
      uSkyAbsorb: { value: new THREE.Vector3(0.11, 0.042, 0.032) },
      // Share of the fog's veil that the window's own forward-scattered light
      // makes up for (see the fragment shader).
      uWindowScatter: { value: 0.78 },
      uOcclusion: { value: 0 }, // 0..1, set by Environment (a huge body overhead)
    },
  ]);
  uniforms.uWaves.value = env.textures.waves;

  const mat = new THREE.ShaderMaterial({
    name: 'WaterSurfaceBelow',
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vec3 wp = vec3( position.x + cameraPosition.x, 0.0, position.z + cameraPosition.z );
        vWorld = wp;
        vec4 mvPosition = viewMatrix * vec4( wp, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform sampler2D uWaves;
      uniform vec3 uSunAir;
      uniform vec3 uSkyZenith;
      uniform vec3 uSkyHorizon;
      uniform vec3 uSunColor;
      uniform float uSkyIntensity;
      uniform float uWaveStrength;
      uniform vec3 uMirrorTint;
      uniform vec3 uSkyAbsorb;
      uniform float uWindowScatter;
      uniform float uOcclusion;
      varying vec3 vWorld;
      #include <common>
      #include <dithering_pars_fragment>
      #include <fog_pars_fragment>
      void main() {
        vec3 toFrag = vWorld - cameraPosition;
        float dist = length( toFrag );
        vec3 V = toFrag / dist;
        vec2 uv = vWorld.xz;
        vec2 s1 = texture2D( uWaves, uv / 13.0 + uTime * vec2( 0.019, 0.012 ) ).xy * 2.0 - 1.0;
        vec2 s2 = texture2D( uWaves, uv / 31.0 + uTime * vec2( -0.011, 0.016 ) ).xy * 2.0 - 1.0;
        vec2 s3 = texture2D( uWaves, uv / 4.7 + uTime * vec2( 0.035, -0.03 ) ).xy * 2.0 - 1.0;
        vec2 slope = ( s1 * 0.9 + s2 * 1.0 + s3 * 0.4 ) * uWaveStrength;
        slope /= 1.0 + dist * 0.045; // distant ripples average out
        vec3 N = normalize( vec3( slope.x, -1.0, slope.y ) ); // points down into the water
        float cosI = clamp( -dot( V, N ), 0.0, 1.0 );
        vec3 T = refract( V, N, 1.333 );
        vec3 R = reflect( V, N );
        float F = 1.0;
        vec3 sky = vec3( 0.0 );
        if ( dot( T, T ) > 1e-6 ) {
          float cosT = clamp( -dot( T, N ), 0.0, 1.0 );
          float rs = ( 1.333 * cosI - cosT ) / ( 1.333 * cosI + cosT );
          float rp = ( 1.333 * cosT - cosI ) / ( 1.333 * cosT + cosI );
          F = clamp( 0.5 * ( rs * rs + rp * rp ), 0.0, 1.0 );
          // Ease into total internal reflection near the critical angle: no
          // hard white flecks where single ripples tip over the edge.
          F = mix( 1.0, F, smoothstep( 0.0, 0.35, cosT ) );
          float h = clamp( T.y, 0.0, 1.0 );
          sky = mix( uSkyHorizon, uSkyZenith, pow( h, 0.5 ) ) * uSkyIntensity;
          float sd = max( dot( T, uSunAir ), 0.0 );
          sky += uSunColor * ( pow( sd, 1800.0 ) * 80.0 + pow( sd, 120.0 ) * 6.0 + pow( sd, 10.0 ) * 0.8 );
        }
        vec3 base = vec3( 0.0, 0.05, 0.07 );
        #ifdef USE_FOG
          base = envOutputToLinear( fogColor );
          vec3 mirror = envWaterRadiance( base, R, 1e4 ) * uMirrorTint;
        #else
          vec3 mirror = base;
        #endif
        // Sky light loses its reds on the way down; something huge between us
        // and the sun shades the whole window.
        vec3 skyOD = uSkyAbsorb * dist;
        #if defined( USE_FOG ) && defined( FOG_EXP2 )
          // The window is a wide, bright source: light scattered out of a view
          // ray is largely replaced by light scattered in from the rest of the
          // window, so the veil (fog_fragment) dims it far less than it dims
          // a solid object. Give back that share of the fog's optical depth.
          skyOD -= min( uWindowScatter * envFogTau( dist, fogDensity ) * ENV_FOG_RGB, vec3( 12.0 ) );
        #endif
        sky *= exp( -skyOD ) * ( 1.0 - 0.6 * uOcclusion );
        vec3 col = mix( sky, mirror, F );
        gl_FragColor = vec4( col, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
        #include <dithering_fragment>
      }
    `,
    fog: true,
    side: THREE.FrontSide,
    depthWrite: false,
    dithering: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water-surface';
  mesh.frustumCulled = false;
  mesh.renderOrder = -900;
  return { mesh, uniforms, sunAir };
}
