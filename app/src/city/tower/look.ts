import * as THREE from 'three';

import type { District } from '../../../../shared/types';
import { materials, texture } from '../materials';
import type { Centerpiece } from '../scene';
import { buildTower } from './build';
import type { TowerMaterials } from './kit';

/**
 * The tower materials in the browser: the scanned stone, brick and metal
 * sets, floodlit at the root; glazing that shows a lit room behind it; and
 * the few real emitters (light lines, the Claude accent, stained glass).
 */

/**
 * Scanned sandstone retinted per vernacular (`desat` strips the sandstone's
 * own hue first, so grey limestone reads grey), washed by the plaza
 * floodlights near the ground.
 */
function stone(color: number, key: string, normal = 0.9, desat = 0, rough = 1): THREE.MeshStandardMaterial {
  const sand = materials().sand;
  const m = new THREE.MeshStandardMaterial({
    map: sand.map,
    normalMap: sand.normalMap,
    aoMap: sand.aoMap,
    roughnessMap: sand.roughnessMap,
    color,
    roughness: rough,
    normalScale: new THREE.Vector2(normal, normal),
  });
  return floodlit(m, key, 1, desat);
}

/**
 * Floodlights on the plaza graze the root from below: warm light on the
 * walls, strongest at the foot, carrying up the root and gone by the floors.
 */
function floodlit<T extends THREE.MeshStandardMaterial>(m: T, key: string, strength = 1, desat = 0): T {
  m.customProgramCacheKey = () => `palimpsest-tower-flood-${key}`;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTFP; varying vec3 vTFN;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        {
          mat4 fm = modelMatrix;
          #ifdef USE_INSTANCING
            fm = modelMatrix * instanceMatrix;
          #endif
          vTFP = (fm * vec4(transformed, 1.0)).xyz;
          vTFN = normalize(mat3(fm) * objectNormal);
        }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTFP; varying vec3 vTFN;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        #ifdef USE_MAP
          {
            vec3 tex = sampledDiffuseColor.rgb;
            float l = dot(tex, vec3(0.299, 0.587, 0.114));
            diffuseColor.rgb = diffuse * mix(tex, vec3(l) * 1.12, ${desat.toFixed(2)});
          }
        #endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float side = 1.0 - abs(vTFN.y);
          float up = max(-vTFN.y, 0.0);
          float y = max(vTFP.y, 0.0);
          float wash = side * (0.05 + 0.55 * exp(-y / 7.0)) + up * 0.25 * exp(-y / 12.0) + max(vTFN.y, 0.0) * (0.05 + 0.4 * exp(-y / 2.5));
          wash *= 1.0 - smoothstep(30.0, 46.0, y);
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.8, 0.6) * wash * ${strength.toFixed(2)};
        }`,
      );
  };
  return m;
}

/** A scanned metal plate's normal and roughness under a flat tint: cast bronze. */
function metal(color: number, rough: number, normal: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 1,
    roughness: rough,
    normalMap: texture('metal_nor.jpg'),
    roughnessMap: texture('metal_arm.jpg'),
    normalScale: new THREE.Vector2(normal, normal),
  });
}

let grain: { normal: THREE.Texture; rough: THREE.Texture } | null = null;

/**
 * A brushed grain, drawn once: fine streaks running the length of the
 * texture's v axis (up the fins), as a normal map (the slope across the
 * streaks) and a roughness map (polished and dull streaks side by side).
 */
function brushedGrain(): { normal: THREE.Texture; rough: THREE.Texture } {
  if (grain) return grain;
  const W = 512;
  const H = 64;
  let seed = 11;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // Height across the streaks: fine scratches over a few broader bands.
  const height = new Float32Array(W);
  for (let x = 0; x < W; x++) height[x] = rnd() * 0.6;
  for (let pass = 0; pass < 2; pass++) {
    for (let x = 0; x < W; x++) height[x] = (height[x] + height[(x + 1) % W] * 0.5 + height[(x + W - 1) % W] * 0.5) / 2;
  }
  for (let b = 0; b < 24; b++) {
    const c = Math.floor(rnd() * W);
    const wdt = 2 + rnd() * 10;
    const amp = (rnd() - 0.5) * 0.5;
    for (let x = 0; x < W; x++) {
      const d = Math.min(Math.abs(x - c), W - Math.abs(x - c));
      height[x] += amp * Math.exp(-(d * d) / (wdt * wdt));
    }
  }
  const make = (fill: (x: number, y: number) => [number, number, number]): THREE.CanvasTexture => {
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');
    if (g) {
      const img = g.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const [r, gg, b] = fill(x, y);
          const i = (y * W + x) * 4;
          img.data[i] = r;
          img.data[i + 1] = gg;
          img.data[i + 2] = b;
          img.data[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
    }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(5, 1);
    t.anisotropy = 8;
    return t;
  };
  const normal = make((x) => {
    const slope = (height[(x + 1) % W] - height[(x + W - 1) % W]) * 4;
    const nx = -slope / Math.hypot(slope, 1);
    const nz = 1 / Math.hypot(slope, 1);
    return [Math.round((nx * 0.5 + 0.5) * 255), 128, Math.round((nz * 0.5 + 0.5) * 255)];
  });
  const rough = make((x, y) => {
    const v = 0.45 + 0.55 * Math.min(1, Math.max(0, height[x] + 0.25 + 0.05 * Math.sin(y * 0.4 + x)));
    const c = Math.round(v * 255);
    return [c, c, c];
  });
  grain = { normal, rough };
  return grain;
}

/**
 * Brushed metal: a fine streaked grain in the normal and roughness maps,
 * highlights stretched along the grain by anisotropy, no paint-like
 * clearcoat, and enough reflection weight that the dusk sky's PMREM shows
 * as a gradient across every curved surface.
 */
function brushed(color: number, rough: number, aniso: number, env: number, key: string): THREE.MeshPhysicalMaterial {
  const g = brushedGrain();
  const m = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 1,
    roughness: rough,
    roughnessMap: g.rough,
    normalMap: g.normal,
    normalScale: new THREE.Vector2(0.6, 0.6),
    anisotropy: aniso,
    anisotropyRotation: Math.PI / 2,
    envMapIntensity: env,
  });
  // three's anisotropic path divides by zero where a face's UVs give no tangent, or where the
  // bitangent lines up with the view; one NaN pixel then spreads through the bloom chain to the
  // whole frame. Fall back to a tangent from the normal, and keep the bent normal finite.
  m.customProgramCacheKey = () => `palimpsest-brushed-${key}`;
  m.onBeforeCompile = (sh) => {
    const anisoFix = `material.anisotropyB = tbn[ 1 ] * anisotropyV.x - tbn[ 0 ] * anisotropyV.y;
      if ( dot( material.anisotropyT, material.anisotropyT ) < 1e-8 || dot( material.anisotropyB, material.anisotropyB ) < 1e-8 ) {
        vec3 upRef = abs( normal.y ) < 0.99 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
        material.anisotropyB = normalize( cross( normal, upRef ) );
        material.anisotropyT = cross( material.anisotropyB, normal );
      }`;
    const lights = THREE.ShaderChunk.lights_physical_fragment.replace(
      'material.anisotropyB = tbn[ 1 ] * anisotropyV.x - tbn[ 0 ] * anisotropyV.y;',
      anisoFix,
    );
    const env = THREE.ShaderChunk.envmap_physical_pars_fragment.replaceAll(
      'bentNormal = normalize( cross( bentNormal, bitangent ) );',
      'bentNormal = normalize( cross( bentNormal, bitangent ) + normal * 1e-4 );',
    );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <lights_physical_fragment>', lights)
      .replace('#include <envmap_physical_pars_fragment>', env);
  };
  return m;
}

/**
 * Glazing over a lit room, by interior mapping: each pane traces the view
 * ray into a box room behind it (back wall with furniture, ceiling with
 * light strips, floor, side walls), so rooms have depth and parallax rather
 * than a painted glow. Instance colour carries the data: r = light level,
 * g = warmth, b = pane style (full height, sill, or sash with glazing bars).
 * The glass itself is black and glossy, so the dusk sky reflects off it at
 * grazing angles.
 */
function windowMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.05, metalness: 0, envMapIntensity: 1.15 });
  m.customProgramCacheKey = () => 'palimpsest-tower-window';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoomO; varying vec3 vRoomD; varying vec3 vPane;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          mat4 pm = modelMatrix;
          #ifdef USE_INSTANCING
            pm = modelMatrix * instanceMatrix;
          #endif
          vec3 pT = pm[0].xyz; vec3 pB = pm[1].xyz; vec3 pN = normalize(pm[2].xyz);
          float psx = length(pT); float psy = length(pB);
          pT /= psx; pB /= psy;
          vec3 pV = (pm * vec4(transformed, 1.0)).xyz - cameraPosition;
          vRoomD = vec3(dot(pV, pT), dot(pV, pB), dot(pV, pN));
          vRoomO = vec3(transformed.x * psx, transformed.y * psy, 0.0);
          vPane = vec3(psx, psy, fract(sin(dot(pm[3].xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453));
        }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoomO; varying vec3 vRoomD; varying vec3 vPane;\nfloat rh(float x){ return fract(sin(x * 91.345) * 47453.5453); }')
      .replace('#include <color_fragment>', '')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${ROOM_GLSL}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += roomLight;');
  };
  return m;
}

const ROOM_GLSL = /* glsl */ `
  vec3 roomLight = vec3(0.0);
  {
    float lit = vColor.r;
    float warm = vColor.g;
    float style = vColor.b;
    vec2 sz = vPane.xy;
    float seed = vPane.z;
    vec3 rd = normalize(vRoomD);
    rd.z = min(rd.z, -0.002);
    vec3 rdx = sign(rd) * max(abs(rd), vec3(1e-4));
    vec3 ro = vRoomO;
    float sillH = style > 0.25 ? 0.9 : 0.04;
    float floorY = -sz.y * 0.5 - sillH;
    float ceilY = sz.y * 0.5 + (style > 0.25 ? 0.4 : 0.08);
    // Rooms are wider than a pane and not too deep, so oblique views still land on lit walls.
    float hw = max(sz.x * 0.5 + 1.0, 5.0 + 4.0 * seed);
    float depth = 3.6 + 2.4 * fract(seed * 5.3);
    float tx = ((rd.x > 0.0 ? hw : -hw) - ro.x) / rdx.x;
    float ty = ((rd.y > 0.0 ? ceilY : floorY) - ro.y) / rdx.y;
    float tz = (-depth - ro.z) / rdx.z;
    float t = min(tx, min(ty, tz));
    vec3 p = ro + rd * t;
    vec3 lc = mix(vec3(0.6, 0.76, 1.0), vec3(1.0, 0.68, 0.4), warm);
    float hgt = clamp((p.y - floorY) / (ceilY - floorY), 0.0, 1.0);
    vec3 room = vec3(0.0);
    if (t == tz || t == tx) {
      // Walls: lit from the ceiling, brightest near it; furniture and shelving in silhouette along the foot.
      float along = t == tz ? p.x : -p.z * sign(rd.x) + 17.0;
      room = lc * (0.25 + 0.6 * smoothstep(0.1, 1.0, hgt)) * (t == tz ? 1.0 : 0.82);
      float col = floor((along + 40.0) / 1.3);
      float hc = rh(col + seed * 37.0);
      float fh = hc > 0.82 ? 2.0 : 0.78;
      if (p.y - floorY < fh && hc > 0.3) room *= 0.12;
      float door = rh(floor((along + 40.0) / 3.7) + seed * 11.0);
      if (door > 0.85 && p.y - floorY < 2.1) room *= 0.45;
    } else if (t == ty && rd.y > 0.0) {
      // Ceiling: rows of light fittings running across the room.
      float lz = abs(fract(-p.z / 2.4) - 0.5);
      float lx = abs(fract(p.x / 3.0) - 0.5);
      float fitting = (1.0 - smoothstep(0.05, 0.08, lz)) * (1.0 - smoothstep(0.32, 0.36, lx));
      room = lc * (0.12 + fitting * 0.75);
    } else if (t == ty) {
      // Floor: pools under the fittings, darker toward the window.
      room = lc * (0.16 + 0.16 * smoothstep(0.5, 3.0, -p.z));
    }
    room *= exp(-max(-p.z, 0.0) * 0.06);
    // Blinds drawn partway on some windows: slatted fabric, lit from behind.
    float ny = clamp((ro.y / sz.y) + 0.5, 0.0, 1.0);
    float drop = rh(seed * 13.0) < 0.42 ? rh(seed * 29.0) * 0.7 : 0.0;
    if (ny > 1.0 - drop) room = lc * (0.26 + 0.06 * step(0.5, fract(ro.y * 9.0)));
    // An unlit room still holds a little of the sky.
    roomLight = room * lit * 2.6;
    // Roll off the brightest rooms without shifting their hue: dim rooms lift a little, bright ones settle
    // under the bloom threshold, and the room keeps its contrast instead of clipping to white.
    float peak = max(roomLight.r, max(roomLight.g, roomLight.b));
    roomLight *= 1.0 / (1.0 + 0.45 * peak);
    roughnessFactor = 0.035;
    diffuseColor.rgb = vec3(0.0);
    if (style > 0.6 && style < 0.9) {
      // Shoji: lit paper in a timber kumiko lattice; no room shows through.
      vec2 q = ro.xy + 20.0;
      float dx = (0.5 - abs(fract(q.x / 0.46) - 0.5)) * 0.46;
      float dy = (0.5 - abs(fract(q.y / 0.62) - 0.5)) * 0.62;
      float bar = 1.0 - smoothstep(0.014, 0.026, min(dx, dy));
      float fibre = 0.92 + 0.08 * rh(floor(q.x * 7.0) + floor(q.y * 5.0) * 13.0);
      vec3 lamp = vec3(1.0, 0.72, 0.46) * (0.55 + 0.45 * smoothstep(0.0, 1.0, ny));
      diffuseColor.rgb = mix(vec3(0.62, 0.6, 0.54), vec3(0.09, 0.05, 0.035), bar);
      roughnessFactor = 0.85;
      roomLight = lamp * fibre * (0.12 + lit * 0.95) * (1.0 - bar);
    }
    if (style > 0.9) {
      // Glazing bars: a frame round the edge, one upright and a meeting rail.
      vec2 c = ro.xy / sz;
      vec2 e = 0.5 - abs(c);
      float frame = 1.0 - smoothstep(0.035, 0.045, min(e.x * sz.x, e.y * sz.y) / max(sz.x, sz.y) * 4.0);
      float bar = max(1.0 - smoothstep(0.03, 0.045, abs(c.x) * sz.x), 1.0 - smoothstep(0.035, 0.05, abs(c.y - 0.04) * sz.y));
      float b = clamp(max(frame, bar), 0.0, 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.52, 0.5, 0.46), b);
      roughnessFactor = mix(roughnessFactor, 0.6, b);
      roomLight *= 1.0 - b;
    }
  }
`;

/** Stained glass for the rose window: jewel-coloured petals in lead cames, lit from inside. */
function stainedMaterial(): THREE.MeshBasicMaterial {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (g) {
    const R = size / 2;
    g.fillStyle = '#05040a';
    g.fillRect(0, 0, size, size);
    const palette = ['#16307a', '#8a1420', '#1d5a3a', '#b8861c', '#3a1c6e', '#0f4a7a'];
    let s = 3;
    const r = (): number => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let ring = 0; ring < 6; ring++) {
      const r0 = (ring / 6) * R;
      const r1 = ((ring + 1) / 6) * R;
      const n = 12 * (ring === 0 ? 1 : ring);
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        g.beginPath();
        g.arc(R, R, r1 - 3, a0, a1);
        g.arc(R, R, Math.max(0, r0 + 3), a1, a0, true);
        g.closePath();
        g.fillStyle = palette[Math.floor(r() * palette.length)];
        g.globalAlpha = 0.6 + 0.4 * r();
        g.fill();
      }
    }
    g.globalAlpha = 1;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(1.4, 1.3, 1.2) });
}

let library: TowerMaterials | null = null;

export function towerMaterials(): TowerMaterials {
  if (library) return library;
  const lib = materials();
  library = {
    sand: stone(0xf3e9da, 'sand'),
    travertine: stone(0xf6ead2, 'travertine', 0.7, 0.55),
    gothic: stone(0xaeafb0, 'gothic', 1.0, 0.92),
    limestone: stone(0xe2ded6, 'limestone', 0.8, 0.85),
    granite: stone(0x8a8886, 'granite', 1.3, 0.9),
    brick: lib.brick,
    bronze: metal(0x6b4a2e, 0.42, 0.35),
    titanium: brushed(0xa9afb7, 0.13, 0.6, 2.2, 'titanium'),
    graphite: brushed(0x2e3136, 0.42, 0.4, 1.4, 'graphite'),
    steel: lib.darkMetal,
    slab: lib.concrete,
    window: windowMaterial(),
    stained: stainedMaterial(),
    roofTile: new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.38, metalness: 0.1, envMapIntensity: 1.2 }),
    timber: floodlit(new THREE.MeshStandardMaterial({ color: 0x7a2416, roughness: 0.48 }), 'timber', 0.8),
    plaster: floodlit(new THREE.MeshStandardMaterial({ color: 0xe6dfd2, roughness: 0.92 }), 'plaster', 0.7),
    // Neutral white (about 4500 K), at a level that reads as a lit reveal rather than neon.
    lightLine: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.88, 0.93, 1.0).multiplyScalar(1.0) }),
    // Saturated amber, a hue the architecture never uses, so a Claude floor reads apart from any light line.
    accent: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.36, 0.05).multiplyScalar(1.5) }),
    pick: new THREE.MeshBasicMaterial({ visible: false }),
  };
  return library;
}

/** A district's Palimpsest tower as a city centerpiece: floors pick as themselves, the root picks as the district. */
export function towerCenterpiece(d: District, quality: 'high' | 'medium'): Centerpiece {
  const t = buildTower(d.tower, quality, towerMaterials());
  const pickables = new Map<THREE.Object3D, string | null>(t.pickables);
  pickables.set(t.rootPick, null);
  return { object: t.group, pickables, dispose: () => t.dispose() };
}
