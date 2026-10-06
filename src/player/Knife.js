// 杀鱼刀 — a long, thin, single-edged fish-gutting knife: ~25 cm blade with an
// upswept point, a sabre grind (flat upper face + polished lower bevel, so the
// blade throws separate glints as it turns), a brass bolster and a dark wooden
// handle with three rivets.
//
// Seen edge-on from the follow camera the 3 mm blade is narrower than a pixel
// and MSAA breaks it into dots, so a screen-space glint strip runs along the
// cutting edge: ~2 px wide whatever the distance, additive, flashing when the
// blade turns edge-on (1 − |N·V|, the bevel catching the light) and dimly on
// whenever the whole blade projects to under ~3 px.
//
// Knife-local frame: origin = grip centre, +Z toward the tip, −Y = cutting
// edge, +Y = spine, ±X = blade faces.
import * as THREE from 'three';
import { buildLoft, mergeParts } from './loft.js';
import { KNIFE } from './rig.js';
import { smoothstep } from './math.js';
import { makeWood, makeBrushed } from './textures.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _res = new THREE.Vector2();
const _col = new THREE.Color();

// Spine thickness (m) along the blade, t = 0 heel → 1 tip.
const spineThickness = (t) => 0.0032 * (1 - 0.4 * t) * Math.pow(Math.max(0, 1 - t), 0.3);

/** A strip between two polylines A[i], B[i]; faces toward `hint(i)`. */
function strip(A, B, hint, uvAcross) {
  const n = A.length;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  for (let i = 0; i < n; i++) {
    pos.set([A[i].x, A[i].y, A[i].z, B[i].x, B[i].y, B[i].z], i * 6);
    const t = i / (n - 1);
    uv.set([t, uvAcross[0], t, uvAcross[1]], i * 4);
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 3;
    const d = a + 2;
    // orientation test on this quad
    _a.set(pos[d * 3] - pos[a * 3], pos[d * 3 + 1] - pos[a * 3 + 1], pos[d * 3 + 2] - pos[a * 3 + 2]);
    _b.set(pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]);
    _n.crossVectors(_b, _a); // triangle (a, b, d)
    if (_n.lengthSq() < 1e-14) {
      _a.set(pos[c * 3] - pos[b * 3], pos[c * 3 + 1] - pos[b * 3 + 1], pos[c * 3 + 2] - pos[b * 3 + 2]);
      _b.set(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
      _n.crossVectors(_a, _b);
    }
    const h = hint(i);
    if (_n.dot(h) >= 0) idx.push(a, b, d, b, c, d);
    else idx.push(a, d, b, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Spine and cutting-edge heights (knife-local y) at blade fraction t. */
function bladeProfile(t) {
  const ys = 0.0108 - 0.0022 * t - 0.0086 * Math.pow(smoothstep(0.6, 1.0, t), 1.35);
  // slight heel curve into the bolster + belly sweeping up to the point
  const ye = -0.0112 + 0.0012 * (1 - smoothstep(0, 0.06, t)) + 0.0024 * t + 0.0088 * Math.pow(smoothstep(0.48, 1.0, t), 1.3);
  return { ys, ye };
}

function buildBladeGeometry(stations) {
  const len = KNIFE.bladeEnd - KNIFE.bladeStart;
  const S = []; // spine +x
  const Sm = []; // spine −x
  const G = [];
  const Gm = [];
  const E = [];
  for (let i = 0; i <= stations; i++) {
    const t = i / stations;
    const z = KNIFE.bladeStart + len * t;
    const { ys, ye } = bladeProfile(t);
    const th = spineThickness(t);
    const yg = ye + (ys - ye) * 0.42;
    S.push(new THREE.Vector3(th / 2, ys, z));
    Sm.push(new THREE.Vector3(-th / 2, ys, z));
    G.push(new THREE.Vector3(th / 2 * 0.96, yg, z));
    Gm.push(new THREE.Vector3(-th / 2 * 0.96, yg, z));
    E.push(new THREE.Vector3(0, ye, z));
  }
  const px = () => new THREE.Vector3(1, 0, 0);
  const nx = () => new THREE.Vector3(-1, 0, 0);
  const steel = mergeParts([
    strip(Sm, S, () => new THREE.Vector3(0, 1, 0), [0.0, 0.05]), // spine
    strip(S, G, px, [0.05, 0.6]), // flat +x
    strip(Gm, Sm, nx, [0.6, 0.05]), // flat −x
  ]);
  const edge = mergeParts([
    strip(G, E, () => new THREE.Vector3(1, -0.35, 0), [0.6, 1.0]),
    strip(E, Gm, () => new THREE.Vector3(-1, -0.35, 0), [1.0, 0.6]),
  ]);
  // heel face (closes the blade where it meets the bolster)
  const heel = strip([Sm[0], Gm[0], E[0]], [S[0], G[0], E[0]], () => new THREE.Vector3(0, 0, -1), [0, 1]);
  const steelAll = mergeParts([steel, heel]);
  const g = mergeParts([steelAll, edge]);
  g.clearGroups();
  g.addGroup(0, steelAll.index.count, 0);
  g.addGroup(steelAll.index.count, edge.index.count, 1);
  return g;
}

// ---------------------------------------------------------------------------
// Edge glint: a camera-facing ribbon along the cutting edge, expanded to a
// fixed pixel width in the vertex shader (like a line renderer).
// ---------------------------------------------------------------------------
const GLINT_VERT = /* glsl */ `
attribute vec3 aTangent;
attribute float aSide;
attribute float aAlong;
uniform vec2 uResolution;
uniform float uWidth;
varying float vSide;
varying float vGlint;
varying float vAlong;
varying float vDist;
void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vDist = length( mv.xyz );
  // 1 − |N·V| of the blade faces (knife-local ±X): the bevel flashes as the
  // blade turns edge-on and its faces vanish
  vec3 faceN = normalize( normalMatrix * vec3( 1.0, 0.0, 0.0 ) );
  float edgeOn = pow( clamp( 1.0 - abs( dot( faceN, mv.xyz / max( vDist, 1e-4 ) ) ), 0.0, 1.0 ), 6.0 );
  vec4 mvT = modelViewMatrix * vec4( position + aTangent * 0.02, 1.0 );
  // a blade-height (2 cm) step toward the spine, the same all along the blade
  vec4 cS = projectionMatrix * ( modelViewMatrix * vec4( position + vec3( 0.0, 0.02, 0.0 ), 1.0 ) );
  // Pull the ribbon toward the eye by about a blade height so the blade's own
  // spine never hides it; anything really in front (hand, shark) still does.
  mv.xyz -= mv.xyz / max( vDist, 1e-4 ) * 0.025;
  vec4 c0 = projectionMatrix * mv;
  vec4 c1 = projectionMatrix * mvT;
  vec2 d = ( c1.xy / c1.w - c0.xy / c0.w ) * uResolution;
  float l = length( d );
  vec2 n = l > 1e-6 ? vec2( -d.y, d.x ) / l : vec2( 0.0, 1.0 );
  // Projected blade height in pixels: once the blade is only a pixel or two
  // tall (far away, or nearly edge-on) its faces and the mirror-polished bevel
  // break into MSAA dots and dashes, so the ribbon fades in as a continuous,
  // dimmer line.
  float hPx = abs( dot( ( cS.xy / cS.w - c0.xy / c0.w ) * uResolution * 0.5, n ) );
  float thin = 1.0 - smoothstep( 1.2, 3.5, hPx );
  vGlint = max( edgeOn, 0.45 * thin );
  c0.xy += n * aSide * uWidth / uResolution * c0.w;
  gl_Position = c0;
  vSide = aSide;
  vAlong = aAlong;
}`;

const GLINT_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uFogDensity;
varying float vSide;
varying float vGlint;
varying float vAlong;
varying float vDist;
void main() {
  float across = 1.0 - vSide * vSide;
  float along = smoothstep( 0.0, 0.1, vAlong ) * ( 1.0 - 0.6 * smoothstep( 0.7, 1.0, vAlong ) );
  // water attenuation between the blade and the eye (shared fog curve)
  float x = uFogDensity * vDist;
  vec3 atten = exp( -( 0.72 * x + 0.74 * x * x ) * vec3( 1.5, 1.0, 0.9 ) );
  gl_FragColor = vec4( uColor * atten * ( across * vGlint * along ), 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function buildGlintGeometry(stations) {
  const len = KNIFE.bladeEnd - KNIFE.bladeStart;
  const n = stations + 1;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / stations;
    pts.push(new THREE.Vector3(0, bladeProfile(t).ye, KNIFE.bladeStart + len * t));
  }
  const pos = new Float32Array(n * 2 * 3);
  const tan = new Float32Array(n * 2 * 3);
  const side = new Float32Array(n * 2);
  const along = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    _a.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
    for (let s = 0; s < 2; s++) {
      const k = i * 2 + s;
      pos.set([pts[i].x, pts[i].y, pts[i].z], k * 3);
      tan.set([_a.x, _a.y, _a.z], k * 3);
      side[k] = s === 0 ? -1 : 1;
      along[k] = i / stations;
    }
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aTangent', new THREE.BufferAttribute(tan, 3));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  g.setIndex(idx);
  // the ribbon is expanded on the GPU; keep a generous bound for culling
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, (KNIFE.bladeStart + KNIFE.bladeEnd) / 2), len);
  return g;
}

/**
 * The glint mesh. `lightProbe(color)` writes the linear radiance the edge
 * reflects (the caller ties it to the water light around the camera).
 */
function buildGlint(stations, lightProbe) {
  const uniforms = {
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uWidth: { value: 2 },
    uColor: { value: new THREE.Color(0.25, 0.7, 0.8) },
    uFogDensity: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    name: 'knife-glint',
    uniforms,
    vertexShader: GLINT_VERT,
    fragmentShader: GLINT_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true, // (the vertex shader pulls it in front of the blade itself)
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(buildGlintGeometry(stations), mat);
  mesh.name = 'knife-glint';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.onBeforeRender = (renderer, scene) => {
    const rt = renderer.getRenderTarget();
    if (rt) _res.set(rt.width, rt.height);
    else renderer.getDrawingBufferSize(_res);
    uniforms.uResolution.value.copy(_res);
    // ~2 CSS px, never under 1.6 device px
    uniforms.uWidth.value = Math.max(1.6, 2 * renderer.getPixelRatio() * (rt ? rt.width / Math.max(1, renderer.domElement.width) : 1));
    uniforms.uFogDensity.value = scene.fog?.density ?? 0;
    if (lightProbe) uniforms.uColor.value.copy(lightProbe(_col));
  };
  return mesh;
}

function buildHandleGeometry() {
  const prof = [
    [KNIFE.handleBack, 0.0072, 0.011],
    [KNIFE.handleBack + 0.006, 0.0086, 0.0128],
    [-0.03, 0.0093, 0.0136],
    [0.0, 0.0091, 0.0131],
    [0.025, 0.0086, 0.0122],
    [KNIFE.handleFront, 0.0082, 0.0117],
  ];
  const rings = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = KNIFE.handleBack + (KNIFE.handleFront - KNIFE.handleBack) * t;
    let k = 0;
    while (k < prof.length - 2 && z > prof[k + 1][0]) k++;
    const f = (z - prof[k][0]) / (prof[k + 1][0] - prof[k][0]);
    const s = f * f * (3 - 2 * f);
    rings.push({
      c: new THREE.Vector3(0, 0, z),
      ax: new THREE.Vector3(1, 0, 0),
      az: new THREE.Vector3(0, 1, 0),
      rx: prof[k][1] + (prof[k + 1][1] - prof[k][1]) * s,
      rzf: prof[k][2] + (prof[k + 1][2] - prof[k][2]) * s,
      e: 2.8,
      t,
    });
  }
  return buildLoft({
    rings,
    seg: 20,
    capStart: true,
    capEnd: true,
    uv: (i, th) => [rings[i].t, (th + Math.PI) / (Math.PI * 2)],
  });
}

function buildMetalGeometry() {
  // bolster
  const rings = [];
  const zs = [KNIFE.handleFront - 0.002, KNIFE.handleFront + 0.001, KNIFE.bladeStart - 0.002, KNIFE.bladeStart + 0.0015];
  const rs = [
    [0.0084, 0.012],
    [0.0094, 0.0132],
    [0.0088, 0.0128],
    [0.0024, 0.0118],
  ];
  for (let i = 0; i < zs.length; i++) {
    rings.push({
      c: new THREE.Vector3(0, 0.0005 * i, zs[i]),
      ax: new THREE.Vector3(1, 0, 0),
      az: new THREE.Vector3(0, 1, 0),
      rx: rs[i][0],
      rzf: rs[i][1],
      e: 3,
    });
  }
  const parts = [buildLoft({ rings, seg: 20, capStart: true, capEnd: true })];
  // rivets
  for (const z of [-0.049, -0.017, 0.017]) {
    const c = new THREE.CylinderGeometry(0.0033, 0.0033, 0.0198, 12, 1);
    c.rotateZ(Math.PI / 2);
    c.translate(0, 0, z);
    parts.push(c);
  }
  return mergeParts(parts);
}

/**
 * Builds the knife group (knife-local frame). Materials get the PMREM env map
 * so the steel reflects the bright Snell's window overhead. `lightProbe(color)`
 * (optional) returns the linear light the edge glint reflects.
 */
export function buildKnife({ envMap, quality, patch, lightProbe = null }) {
  const group = new THREE.Group();
  group.name = 'knife';
  const texSize = quality === 'low' ? 128 : 256;

  const steel = new THREE.MeshStandardMaterial({
    color: 0xc4cbd0,
    metalness: 1,
    roughness: 0.26,
    roughnessMap: makeBrushed(texSize),
    envMap,
    envMapIntensity: 1.15,
  });
  const edge = new THREE.MeshStandardMaterial({
    color: 0xe6eaec,
    metalness: 1,
    roughness: 0.07,
    envMap,
    envMapIntensity: 1.4,
  });
  const wood = new THREE.MeshStandardMaterial({
    map: makeWood(texSize),
    roughness: 0.62,
    metalness: 0,
    envMap,
    envMapIntensity: 0.25,
  });
  const brass = new THREE.MeshStandardMaterial({
    color: 0xa88a5c,
    metalness: 1,
    roughness: 0.34,
    envMap,
    envMapIntensity: 1.0,
  });
  const mats = [steel, edge, wood, brass].map((m) => patch(m));

  const blade = new THREE.Mesh(buildBladeGeometry(quality === 'low' ? 24 : 48), [mats[0], mats[1]]);
  const handle = new THREE.Mesh(buildHandleGeometry(), mats[2]);
  const metal = new THREE.Mesh(buildMetalGeometry(), mats[3]);
  for (const m of [blade, handle, metal]) {
    m.castShadow = quality !== 'low';
    m.receiveShadow = false;
    m.frustumCulled = false;
    group.add(m);
  }
  const glint = buildGlint(quality === 'low' ? 16 : 32, lightProbe);
  group.add(glint);
  return { group, glint, materials: { steel: mats[0], edge: mats[1], wood: mats[2], brass: mats[3], glint: glint.material } };
}
