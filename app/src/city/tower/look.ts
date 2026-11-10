import * as THREE from 'three';

import type { District } from '../../../../shared/types';
import { materials, texture } from '../materials';
import { ANISO_PATCH_OK, patchAnisotropy } from './aniso-patch';
import type { Centerpiece } from '../scene';
import { buildTower } from './build';
import type { EraMatKey, TowerMaterials } from './kit';
import { type Finish, type Glazing, type Look, lookFor, lookKey, type Scan } from './variants';

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
function brushed(color: number, rough: number, aniso: number, env: number, vertexColors = false): THREE.MeshPhysicalMaterial {
  const g = brushedGrain();
  const m = new THREE.MeshPhysicalMaterial({
    color,
    vertexColors,
    metalness: 1,
    roughness: rough,
    roughnessMap: g.rough,
    normalMap: g.normal,
    normalScale: new THREE.Vector2(0.6, 0.6),
    // Without the patch below (three's shader text changed), anisotropy would risk NaN pixels: draw without it.
    anisotropy: ANISO_PATCH_OK ? aniso : 0,
    anisotropyRotation: Math.PI / 2,
    envMapIntensity: env,
  });
  // See aniso-patch.ts: keeps three's anisotropic path from producing NaN pixels.
  if (ANISO_PATCH_OK) {
    // One program for every brushed metal: the patch is the same text, and colour and grain strength are uniforms.
    m.customProgramCacheKey = () => 'palimpsest-brushed';
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = patchAnisotropy(sh.fragmentShader);
    };
  }
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
function windowMaterial(glazing: Glazing = { body: 0x000000, tint: 0xffffff, env: 1.15 }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.05, metalness: 0, envMapIntensity: glazing.env });
  // Every variant's glass shares one program: the glass body and the tint it gives the rooms are uniforms.
  const body = { value: new THREE.Color(glazing.body) };
  const tint = { value: new THREE.Color(glazing.tint) };
  m.customProgramCacheKey = () => 'palimpsest-tower-window';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGlassBody = body;
    sh.uniforms.uGlassTint = tint;
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
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoomO; varying vec3 vRoomD; varying vec3 vPane;\nuniform vec3 uGlassBody; uniform vec3 uGlassTint;\nfloat rh(float x){ return fract(sin(x * 91.345) * 47453.5453); }')
      .replace('#include <color_fragment>', '')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${ROOM_GLSL}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += roomLight;')
      // Coated glass tints what it reflects as well as what it lets through.
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectSpecular *= uGlassTint;\nreflectedLight.directSpecular *= uGlassTint;');
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
    // Tinted glass colours the rooms seen through it, and shows its own body colour against the sky.
    roomLight *= uGlassTint;
    roughnessFactor = 0.035;
    diffuseColor.rgb = uGlassBody;
    if (style > 0.15 && style < 0.35) {
      // Channel glass: translucent U-profiles a third of a metre wide, standing side by side. The rooms behind
      // read only as light through the milky glass, brightest at desk height; each channel's curved face takes
      // the light a little differently, and the flanges where two channels meet stay darker.
      vec2 q = ro.xy + 20.0;
      float ch = fract(q.x / 0.34);
      float rib = 0.8 + 0.2 * sin(ch * 3.14159);
      float flange = 1.0 - smoothstep(0.0, 0.07, min(ch, 1.0 - ch));
      vec3 glow = lc * uGlassTint * (0.1 + 0.9 * lit) * (0.5 + 0.5 * smoothstep(0.0, 1.0, 1.0 - abs(ny - 0.5) * 1.5));
      diffuseColor.rgb = uGlassBody * rib * (1.0 - 0.35 * flange);
      roughnessFactor = 0.3;
      roomLight = glow * rib * (1.0 - 0.6 * flange) * 0.85;
    }
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

/**
 * Each scan's split between body and joint in its linear luminance (from
 * the 2k colour maps): at or past `lo` reads as body, at or past `hi` as
 * joint. Brick and ironspot mortar is lighter than the brick; the joints of
 * sandstone, granite tiles and ashlar are darker than the stone, so their
 * split runs the other way, as does rust, whose dark streaks are the joint.
 * `refBody` and `refJoint` are each part's typical luminance; `rough` is the
 * mean of the scan's roughness map, so a finish's roughness is its true mean.
 */
const SCAN_STATS: Record<Scan, { lo: number; hi: number; refBody: number; refJoint: number; rough: number }> = {
  brick: { lo: 0.13, hi: 0.22, refBody: 0.09, refJoint: 0.26, rough: 0.53 },
  ironspot: { lo: 0.1, hi: 0.25, refBody: 0.04, refJoint: 0.31, rough: 0.81 },
  sand: { lo: 0.268, hi: 0.24, refBody: 0.3, refJoint: 0.23, rough: 0.51 },
  rust: { lo: 0.36, hi: 0.22, refBody: 0.37, refJoint: 0.2, rough: 0.42 },
  granite: { lo: 0.06, hi: 0.05, refBody: 0.077, refJoint: 0.05, rough: 0.54 },
  ashlar: { lo: 0.29, hi: 0.235, refBody: 0.35, refJoint: 0.21, rough: 0.51 },
};

/**
 * A scanned masonry or patina set in a variant's colours. The scan's
 * luminance splits it into body and joint (brick and mortar), each recoloured
 * to the variant while the scan's own brick-to-brick variation and relief
 * stay; with `keep` the scan's own colour shows under a tint instead. The
 * plaza floodlights wash it near the ground, and the vertex colour carries
 * the year drift. Every scan finish shares one program; its colours are
 * uniforms.
 */
function scanMaterial(f: Extract<Finish, { kind: 'scan' }>): THREE.MeshStandardMaterial {
  const arm = texture(`${f.tex}_arm.jpg`);
  const st = SCAN_STATS[f.tex];
  const n = f.normal ?? 1;
  const params: THREE.MeshPhysicalMaterialParameters = {
    map: texture(`${f.tex}_diff.jpg`, true),
    normalMap: texture(`${f.tex}_nor.jpg`),
    aoMap: arm,
    roughnessMap: arm,
    color: f.keep ? f.body : 0xffffff,
    roughness: Math.min(1, f.rough / st.rough),
    metalness: 0,
    vertexColors: true,
    normalScale: new THREE.Vector2(n, n),
  };
  // Polished stone (granite, marble) carries a hard glassy skin over its grain that mirrors the sky; it is a
  // clear coat over the stone rather than a lower roughness on it, so the grain stays matte underneath.
  // A full glaze (ceramic) is a mirror of the sky before it is a coloured surface, so it takes more of the sky
  // than a polished stone does.
  const m = f.polish
    ? new THREE.MeshPhysicalMaterial({ ...params, clearcoat: f.polish, clearcoatRoughness: f.polish >= 0.9 ? 0.02 : 0.04, envMapIntensity: f.polish >= 0.9 ? 4.2 : 2.6 })
    : new THREE.MeshStandardMaterial(params);
  const u = {
    uBody: { value: new THREE.Color(f.body) },
    uJoint: { value: new THREE.Color(f.joint ?? f.body) },
    uSplit: { value: new THREE.Vector4(st.lo, st.hi, st.refBody, st.refJoint) },
    uKeep: { value: f.keep ? 1 : 0 },
    // Cut stone weathers in patches and streaks; brick and patina carry their own variation in the scan.
    uWeather: { value: f.weather ?? (f.tex === 'sand' || f.tex === 'ashlar' || f.tex === 'granite' ? 0.22 : 0) },
    // How much of the scan's own grain shows through the recolour: granite's speckle is the point of it.
    uDetail: { value: f.detail ?? (f.tex === 'granite' ? 1.0 : 0.8) },
    uCourse: { value: f.courses ? new THREE.Vector4(f.courses.h, f.courses.l, f.courses.joint, f.courses.vary) : new THREE.Vector4(0, 1, 0, 0) },
    uGap: { value: f.courses?.gap ?? 0.012 },
    uTexScale: { value: 1 / (f.scale ?? 1) },
  };
  m.customProgramCacheKey = () => 'palimpsest-scan';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTFP; varying vec3 vTFN;\nuniform float uTexScale;')
      // Every map of a scan shares one scale, so its units can be enlarged or shrunk per finish.
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv *= uTexScale;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv *= uTexScale;
        #endif
        #ifdef USE_AOMAP
          vAoMapUv *= uTexScale;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv *= uTexScale;
        #endif`,
      )
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
      .replace('#include <common>', '#include <common>\nvarying vec3 vTFP; varying vec3 vTFN;\nuniform vec3 uBody; uniform vec3 uJoint; uniform vec4 uSplit; uniform float uKeep; uniform float uWeather; uniform float uDetail; uniform vec4 uCourse; uniform float uGap;\nfloat wHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\nfloat wNoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y); }')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        #ifdef USE_MAP
          {
            vec3 tex = sampledDiffuseColor.rgb;
            float l = dot(tex, vec3(0.299, 0.587, 0.114));
            float t = clamp((l - uSplit.x) / (uSplit.y - uSplit.x), 0.0, 1.0);
            t = t * t * (3.0 - 2.0 * t);
            float ref = mix(uSplit.z, uSplit.w, t);
            float d = clamp(l / max(ref, 0.01), 0.35, 2.0);
            vec3 recolour = mix(uBody, uJoint, t) * mix(1.0, d, uDetail);
            diffuseColor.rgb = mix(recolour, diffuse * tex, uKeep);
          }
        #endif
        if (uWeather > 0.0) {
          // Stone weathers unevenly: broad patches a few metres across where one bed or one batch of blocks runs
          // lighter or darker, and rain streaks running down the face. No hard edges, so it never fights the
          // scan's own joints.
          vec3 an = abs(vTFN);
          vec2 q = an.y > max(an.x, an.z) ? vTFP.xz : vec2(an.x > an.z ? vTFP.z : vTFP.x, vTFP.y);
          float wPatch = wNoise(q / 9.0) * 0.6 + wNoise(q / 3.0 + 19.0) * 0.4;
          // Whole beds and batches of blocks, 6 to 20 m across, lighter or darker: variation that survives any
          // distance, where the block-to-block grain has long averaged out.
          float wBed = wNoise(vec2(q.x / 22.0, q.y / 6.0) + 41.0);
          float streak = wNoise(vec2(q.x / 0.9, q.y / 14.0) + 7.0);
          // Long rain streaks a few metres wide, running the height of a run.
          float wide = wNoise(vec2(q.x / 3.2, q.y / 60.0) + 23.0);
          diffuseColor.rgb *= 1.0 + uWeather * ((wPatch - 0.5) * 1.6 + (wBed - 0.5) * 1.5 - max(streak - 0.5, 0.0) * 1.6 - max(wide - 0.55, 0.0) * 2.4);
        }
        if (uCourse.x > 0.0 && abs(vTFN.y) < 0.7) {
          // Coursed ashlar: bed joints every course, head joints staggered half a block course to course, each block
          // its own tone, and fine bedding in the stone running along the course. The joints widen into their
          // screen footprint, so from afar they fade into the wall's average rather than shimmer.
          vec3 an = abs(vTFN);
          vec2 q = vec2(an.x > an.z ? vTFP.z : vTFP.x, vTFP.y);
          float row = floor(q.y / uCourse.x);
          float u = q.x / uCourse.y + 0.5 * mod(row, 2.0);
          float col = floor(u);
          vec2 g = vec2(fract(u) * uCourse.y, fract(q.y / uCourse.x) * uCourse.x);
          vec2 e = min(g, vec2(uCourse.y, uCourse.x) - g);
          vec2 aa = fwidth(q) * 1.5 + 1e-4;
          float jx = 1.0 - smoothstep(uGap, uGap + aa.x, e.x);
          float jy = 1.0 - smoothstep(uGap * 1.15, uGap * 1.15 + aa.y, e.y);
          float joint = max(jx, jy);
          float hb = wHash(vec2(col, row) + 3.7);
          // Each block its own tone while a block still covers a few pixels; from farther off the tone is the bed's,
          // three courses sharing a quarry batch, so the coursing keeps reading as laid stone instead of as grain.
          float blockFade = 1.0 - smoothstep(uCourse.y * 0.2, uCourse.y * 0.6, aa.x);
          float bedTone = wHash(vec2(floor(row / 3.0), 11.0)) - 0.5;
          float bed = 1.0 + 0.045 * sin(q.y * 23.0 + hb * 9.0) * (1.0 - smoothstep(0.0, 0.05, aa.y));
          diffuseColor.rgb *= (1.0 + uCourse.w * ((hb - 0.5) * 2.0 * blockFade + bedTone * 1.6)) * bed * (1.0 - uCourse.z * joint);
        }
        // Soot and splash darken masonry toward the street, and the lowest floors most; porous cut stone soils deepest.
        diffuseColor.rgb *= 1.0 - (0.2 + 0.3 * uWeather) * exp(-max(vTFP.y - 20.0, 0.0) / 45.0);`,
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
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.8, 0.6) * wash;
        }`,
      );
  };
  return m;
}

const finishes = new Map<string, THREE.Material>();

/** The material for a finish, made once and shared by every tower and variant that uses it. */
function finishMaterial(f: Finish): THREE.Material {
  const key = JSON.stringify(f);
  let m = finishes.get(key);
  if (m) return m;
  switch (f.kind) {
    case 'scan':
      m = scanMaterial(f);
      break;
    case 'metal': {
      const mm = metal(f.color, f.rough, 0.35);
      mm.vertexColors = true;
      m = mm;
      break;
    }
    case 'brushed':
      m = brushed(f.color, f.rough, f.aniso, f.env, true);
      break;
    case 'solid':
      m =
        f.clearcoat || f.iridescence
          ? new THREE.MeshPhysicalMaterial({
              color: f.color,
              roughness: f.rough,
              metalness: f.metal ?? 0,
              clearcoat: f.clearcoat ?? 0,
              clearcoatRoughness: 0.12,
              iridescence: f.iridescence ?? 0,
              iridescenceIOR: 1.3,
              iridescenceThicknessRange: [220, 420],
              envMapIntensity: f.env ?? 1,
              vertexColors: true,
            })
          : new THREE.MeshStandardMaterial({ color: f.color, roughness: f.rough, metalness: f.metal ?? 0, envMapIntensity: f.env ?? 1, vertexColors: true });
      break;
  }
  finishes.set(key, m);
  return m;
}

const glazings = new Map<string, THREE.Material>();

function glazingMaterial(g: Glazing): THREE.Material {
  const key = JSON.stringify(g);
  let m = glazings.get(key);
  if (!m) glazings.set(key, (m = windowMaterial(g)));
  return m;
}

let library: Omit<TowerMaterials, EraMatKey> | null = null;
const looks = new Map<string, TowerMaterials>();

/** The tower materials for a look: the shared library, with each era's slots filled from the look's variants. */
export function towerMaterials(look: Look): TowerMaterials {
  const key = lookKey(look);
  const hit = looks.get(key);
  if (hit) return hit;
  const eras = {} as Record<EraMatKey, THREE.Material>;
  for (const era of ['stone', 'brick', 'glass', 'titanium', 'scifi'] as const) {
    const v = look[era];
    eras[`${v.era}Wall`] = finishMaterial(v.wall);
    eras[`${v.era}Trim`] = finishMaterial(v.trim);
    eras[`${v.era}Band`] = finishMaterial(v.band);
    eras[`${v.era}Win`] = glazingMaterial(v.glass);
  }
  const out = { ...baseMaterials(), ...eras } as TowerMaterials;
  looks.set(key, out);
  return out;
}

function baseMaterials(): Omit<TowerMaterials, EraMatKey> {
  if (library) return library;
  const lib = materials();
  library = {
    sand: stone(0xf3e9da, 'sand'),
    travertine: stone(0xf6ead2, 'travertine', 0.7, 0.55),
    gothic: stone(0xaeafb0, 'gothic', 1.0, 0.92),
    limestone: stone(0xe2ded6, 'limestone', 0.8, 0.85),
    granite: stone(0x8a8886, 'granite', 1.3, 0.9),
    // Polished, lighter than the mullion bronze: it takes the sun on one side and the warm horizon on the other.
    // A little diffuse response under the metal, so the band takes the low sun as bronze even where its mirror
    // sees only the dark city below; the polish still catches the sky on top and on the chamfers.
    datum: (() => {
      const d = metal(0xd9c26e, 0.4, 0.2);
      d.metalness = 0.8;
      d.envMapIntensity = 1.4;
      return d;
    })(),
    graphite: brushed(0x2e3136, 0.42, 0.4, 1.4),
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
    // Warm tungsten (about 2700 K) behind a louvre: a vent reads as fire-lit from across the city, never as neon.
    vent: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.5, 0.16).multiplyScalar(0.95) }),
    // Bituminous roofing: near black, matte, a little grit in the roughness map.
    roof: new THREE.MeshStandardMaterial({ color: 0x2b2d2f, roughness: 0.9, metalness: 0, roughnessMap: texture('metal_arm.jpg'), envMapIntensity: 0.6 }),
    // Aviation red, at a level that reads as a small hot lamp without a halo.
    beacon: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.1, 0.05).multiplyScalar(1.25) }),
    pick: new THREE.MeshBasicMaterial({ visible: false }),
  };
  return library;
}

/** A district's Palimpsest tower as a city centerpiece: floors pick as themselves, the root picks as the district. */
export function towerCenterpiece(d: District, quality: 'high' | 'medium', look: Look = lookFor(d.repo)): Centerpiece {
  const t = buildTower(d.tower, quality, towerMaterials(look), look);
  const pickables = new Map<THREE.Object3D, string | null>(t.pickables);
  pickables.set(t.rootPick, null);
  return { object: t.group, pickables, dispose: () => t.dispose() };
}
