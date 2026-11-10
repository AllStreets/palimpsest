import * as THREE from 'three';

import {
  BLOCK,
  BOLLARD_RING,
  BOLLARDS,
  LAMP_EDGE,
  LAMP_OFFSETS,
  PITCH,
  PLAZA_LAMP_RING,
  PLAZA_LAMPS,
  PLAZA_RADIUS,
  COURT_LANTERN_INSET,
  COURT_LANTERN_REACH,
  COURT_LANTERN_STEP,
  COURT_PLINTH_CLEAR,
  type Plaza,
} from './grid';
import { QUARTER_OFFSETS } from '../../../shared/district-layout.js';
import { OUT_PARS, OUT_UNIFORMS } from './lightsout.js';
import { CIVIC_LAMPS, FOUNTAIN, HALL } from './exchange.js';
import { AGENT_ROOT_SCALE } from '../../../shared/tower-layout.js';
import { materials, texture, worldBox } from './materials';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BANKS, BRIDGE_APPROACH, BRIDGES, PIERS, QUAY, RIVER } from '../../../shared/commute.js';
import { COPING, QUAY_LAMP_CLEAR, QUAY_LAMP_IN, QUAY_LAMP_REACH, QUAY_LAMP_STEP } from './river.js';

/** Across each quay, from the wall's face inland: the coping, then a promenade of granite setts, then the quay road to its far kerb. */
const PROMENADE_TO = COPING + 4.2;
const QUAY_ROAD_TO = QUAY - 1.2;

/** Most plazas the ground shader tracks at once (the civic plaza plus districts). */
export const MAX_PLAZAS = 64;
const GROUND_SIZE = 16000;
/** Metres per paving texture tile. */
const PAVE_TILE = 4;
/** Lamp heads reach this far over the road from the pole. */
const LAMP_REACH = 1.3;
/** The plinth's base course, in metres (its steps add 4 m each side). */
const PLINTH_FOOT = 34;
/** Half the foot of an agent tower's root (a district root's 21 m at the agent scale): the floodlit edge on a court. */
const AGENT_FOOT_HALF = 21 * AGENT_ROOT_SCALE;

export interface Ground {
  mesh: THREE.Mesh;
  setPlazas(plazas: Plaza[]): void;
  /** Plazas the ground paves now, the civic plaza included (tests and debugging). */
  plazas(): number;
  dispose(): void;
}

/**
 * The ground: precast stone paving everywhere, asphalt lanes with worn
 * centre dashes down every street, open paved plazas where districts and the
 * civic plaza sit, and the light pools of the sodium lamps (the lamps in
 * grid.ts sit on the same lattice the shader computes, so every pool has its
 * lamp). Pools are albedo-weighted irradiance, not paint, so asphalt takes
 * less light than stone.
 */
export function createGround(): Ground {
  // Two halves either side of the river's channel (and its granite copings): the water lies below in the gap.
  const holeW = BANKS.west - COPING;
  const holeE = BANKS.east + COPING;
  const half = GROUND_SIZE / 2;
  const westG = new THREE.PlaneGeometry(holeW + half, GROUND_SIZE, 1, 1).translate((holeW - half) / 2, 0, 0);
  const eastG = new THREE.PlaneGeometry(half - holeE, GROUND_SIZE, 1, 1).translate((holeE + half) / 2, 0, 0);
  const geo = mergeGeometries([westG, eastG])!;
  westG.dispose();
  eastG.dispose();
  // UVs from position, centred on zero, so precision is best where the city is.
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / PAVE_TILE, pos.getY(i) / PAVE_TILE);

  const arm = texture('pave_arm.jpg');
  const mat = new THREE.MeshStandardMaterial({
    map: texture('pave_diff.jpg', true),
    normalMap: texture('pave_nor.jpg'),
    aoMap: arm,
    roughnessMap: arm,
    color: 0xc4bdb5,
    roughness: 0.6,
    metalness: 0,
    normalScale: new THREE.Vector2(0.8, 0.8),
  });

  const uniforms = {
    // x and z of each plaza's centre, a quarter's court half-side (0 for a round plaza), and its standing plots as bits.
    uPlazas: { value: Array.from({ length: MAX_PLAZAS }, () => new THREE.Vector4(1e6, 1e6, 0, 0)) },
    uPlazaCount: { value: 1 },
  };

  mat.customProgramCacheKey = () => 'palimpsest-ground-river';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, OUT_UNIFORMS);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const lampOffsets = LAMP_OFFSETS.map((o) => o.toFixed(1)).join(', ');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vGP;
        ${OUT_PARS}
        uniform vec4 uPlazas[${MAX_PLAZAS}];
        uniform int uPlazaCount;
        const float PITCH = ${PITCH.toFixed(1)};
        const float HALF_BLOCK = ${(BLOCK / 2).toFixed(1)};
        const float LAMP_AT = ${(LAMP_EDGE + LAMP_REACH).toFixed(2)};
        const float PLAZA_R = ${PLAZA_RADIUS.toFixed(1)};
        const float RING_R = ${PLAZA_LAMP_RING.toFixed(1)};
        const float RING_N = ${PLAZA_LAMPS.toFixed(1)};
        const float BOLLARD_R = ${BOLLARD_RING.toFixed(1)};
        const float BOLLARD_N = ${BOLLARDS.toFixed(1)};
        const float PLINTH_HALF = ${(PLINTH_FOOT / 2 + 4).toFixed(1)};
        const float AGENT_FOOT = ${AGENT_FOOT_HALF.toFixed(2)};
        const float QOFF = ${Math.abs(QUARTER_OFFSETS[0].x).toFixed(1)};
        const float LANTERN_IN = ${COURT_LANTERN_INSET.toFixed(1)};
        const float LANTERN_STEP = ${COURT_LANTERN_STEP.toFixed(1)};
        const float LANTERN_REACH = ${COURT_LANTERN_REACH.toFixed(1)};
        const float PLINTH_CLEAR = ${COURT_PLINTH_CLEAR.toFixed(1)};
        const float OFFS[4] = float[4](${lampOffsets});
        const vec2 CIVIC_LAMP[4] = vec2[4](${CIVIC_LAMPS.map((l) => `vec2(${l.x.toFixed(1)}, ${l.z.toFixed(1)})`).join(', ')});
        const vec2 FOUNT = vec2(${FOUNTAIN.x.toFixed(1)}, ${FOUNTAIN.z.toFixed(1)});
        const float FOUNT_R = ${FOUNTAIN.radius.toFixed(1)};
        const float STAIR_FOOT = ${(HALL.z0 + HALL.depth + HALL.stair).toFixed(1)};
        const float HALL_HALF = ${(HALL.width / 2).toFixed(1)};
        const float RIVER_X = ${RIVER.x.toFixed(1)};
        const float RIVER_HALF = ${(RIVER.width / 2).toFixed(1)};
        const float BANK_W = ${BANKS.west.toFixed(1)};
        const float BANK_E = ${BANKS.east.toFixed(1)};
        const float QUAY_W = ${QUAY.toFixed(1)};
        const float PROM_TO = ${PROMENADE_TO.toFixed(2)};
        const float QROAD_TO = ${QUAY_ROAD_TO.toFixed(2)};
        const float APPROACH = ${BRIDGE_APPROACH.toFixed(1)};
        const float BRIDGE_Z[3] = float[3](${BRIDGES.map((z) => z.toFixed(1)).join(', ')});
        const float QLAMP_IN = ${QUAY_LAMP_IN.toFixed(2)};
        const float QLAMP_STEP = ${QUAY_LAMP_STEP.toFixed(1)};
        const float QLAMP_REACH = ${QUAY_LAMP_REACH.toFixed(1)};
        const float QLAMP_CLEAR = ${QUAY_LAMP_CLEAR.toFixed(1)};
        const vec2 PIER_AT[${PIERS.length}] = vec2[${PIERS.length}](${PIERS.map((p) => `vec2(${p.bank === 'west' ? '-1.0' : '1.0'}, ${p.z.toFixed(1)})`).join(', ')});
        // True when a quay lamp stands at z on this bank (-1 west, 1 east): river.ts quayLampClear.
        bool quayLamp(float side, float z) {
          if (abs(z) > QLAMP_REACH + 0.5) return false;
          for (int i = 0; i < 3; i++) if (abs(z - BRIDGE_Z[i]) < QLAMP_CLEAR) return false;
          for (int i = 0; i < ${PIERS.length}; i++) if (PIER_AT[i].x == side && abs(z - PIER_AT[i].y) < QLAMP_CLEAR) return false;
          return true;
        }
        float gHash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
        // The plaza whose edge is nearest: its centre, its radius (a quarter's court half-side), whether it is a
        // district (index 0 is the civic plaza) and a quarter's standing plots. Returns the distance from its centre,
        // round for a plaza and square (the larger of the two offsets) for a court.
        float nearestPlaza(vec2 p, out vec2 c, out bool district, out bool civic, out float r, out float court, out float plots) {
          float best = 1e9; float bestD = 1e9; c = vec2(1e6); district = false; civic = false; r = PLAZA_R; court = 0.0; plots = 0.0;
          for (int i = 0; i < ${MAX_PLAZAS}; i++) {
            if (i >= uPlazaCount) break;
            vec4 u = uPlazas[i];
            vec2 q = abs(p - u.xy);
            float d = u.z > 0.0 ? max(q.x, q.y) : length(q);
            float rr = u.z > 0.0 ? u.z : PLAZA_R;
            if (d - rr < best) { best = d - rr; bestD = d; c = u.xy; district = i > 0 && u.z == 0.0; civic = i == 0; r = rr; court = u.z; plots = u.w; }
          }
          return bestD;
        }
        // Nearest of n lights evenly spaced on a ring of radius r (offset by half a step when half is 0.5).
        vec2 ringLight(vec2 d, float r, float n, float half_) {
          float st = 6.28318530718 / n;
          float a = (floor(atan(d.y, d.x) / st - half_ + 0.5) + half_) * st;
          return d - vec2(cos(a), sin(a)) * r;
        }
        float gNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(gHash(i), gHash(i+vec2(1,0)), f.x), mix(gHash(i+vec2(0,1)), gHash(i+vec2(1,1)), f.x), f.y); }
        float pool(vec2 d) { return exp(-dot(d, d) / 38.0) + 0.18 * exp(-dot(d, d) / 260.0); }
        bool inPlaza(vec2 p) {
          for (int i = 0; i < ${MAX_PLAZAS}; i++) {
            if (i >= uPlazaCount) break;
            vec4 u = uPlazas[i];
            vec2 q = abs(p - u.xy);
            if (u.z > 0.0 ? max(q.x, q.y) < u.z : length(q) < PLAZA_R) return true;
          }
          return false;
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        vec2 gp = vGP.xz;
        vec2 cellId = floor((gp + PITCH * 0.5) / PITCH);
        vec2 lc = gp - cellId * PITCH;                 // position within this block's cell, block centred
        vec2 plazaC;
        bool district;
        bool civic;
        float plazaR;
        float court;
        float plots;
        float plazaD = nearestPlaza(gp, plazaC, district, civic, plazaR, court, plots);
        float plaza = 1.0 - smoothstep(plazaR - 2.0, plazaR, plazaD);
        float edge = max(abs(lc.x), abs(lc.y));
        float road = smoothstep(HALF_BLOCK + 3.9, HALF_BLOCK + 4.1, edge) * (1.0 - plaza);
        // The quays: inland from each wall's face, the coping (under granite), a promenade of setts, the quay road.
        float dq = gp.x < RIVER_X ? BANK_W - gp.x : gp.x - BANK_E;
        float onQuay = step(0.0, dq) * (1.0 - step(QUAY_W, dq));
        float quayRoad = smoothstep(PROM_TO, PROM_TO + 0.15, dq) * (1.0 - smoothstep(QROAD_TO - 0.15, QROAD_TO, dq)) * (1.0 - plaza);
        float prom = onQuay * (1.0 - smoothstep(PROM_TO - 0.1, PROM_TO, dq));
        // Each bridge carries its carriageway on inland across the quay to the next street.
        float approach = 0.0;
        for (int i = 0; i < 3; i++) {
          float az = abs(gp.y - BRIDGE_Z[i]);
          approach = max(approach, (1.0 - smoothstep(7.8, 8.0, az)) * step(0.0, dq) * (1.0 - step(QUAY_W + APPROACH, dq)));
        }
        approach *= 1.0 - plaza;
        float quayKerb = (onQuay * (smoothstep(PROM_TO - 0.25, PROM_TO - 0.1, dq) * (1.0 - smoothstep(PROM_TO, PROM_TO + 0.1, dq)) + smoothstep(QROAD_TO - 0.05, QROAD_TO + 0.05, dq) * (1.0 - smoothstep(QROAD_TO + 0.2, QROAD_TO + 0.3, dq)))) * (1.0 - approach) * (1.0 - plaza);
        road = max(road, max(quayRoad, approach));
        float kerb = smoothstep(HALF_BLOCK + 3.6, HALF_BLOCK + 3.75, edge) * (1.0 - smoothstep(HALF_BLOCK + 3.85, HALF_BLOCK + 4.0, edge)) * (1.0 - plaza);
        // Asphalt: dark, faintly blue, worn smoother where tyres run, with fine grain.
        float grain = gHash(floor(gp * 9.0)) * 0.12 + gHash(floor(gp * 1.3)) * 0.08;
        vec3 asphalt = vec3(0.028, 0.029, 0.032) * (0.9 + grain);
        // Centre dashes on streets that are not intersections.
        bool alongZ = abs(lc.x) > HALF_BLOCK + 4.0 && abs(lc.y) <= HALF_BLOCK;
        bool alongX = abs(lc.y) > HALF_BLOCK + 4.0 && abs(lc.x) <= HALF_BLOCK;
        float centre = alongZ ? abs(abs(lc.x) - PITCH * 0.5) : alongX ? abs(abs(lc.y) - PITCH * 0.5) : 99.0;
        float run = alongZ ? lc.y : lc.x;
        float dash = (1.0 - smoothstep(0.07, 0.1, centre)) * step(0.5, fract(run / 6.0)) * (0.55 + 0.45 * gHash(floor(gp * 3.0)));
        asphalt = mix(asphalt, vec3(0.3, 0.27, 0.2), dash * 0.8);
        // Weathering: broad stains and lighter worn patches so the paving never reads as one repeated tile.
        float stain = gNoise(gp * 0.045) * 0.6 + gNoise(gp * 0.21) * 0.4;
        diffuseColor.rgb *= 0.72 + 0.5 * stain;
        diffuseColor.rgb = mix(diffuseColor.rgb, asphalt, road);
        diffuseColor.rgb *= 1.0 - kerb * 0.35;
        diffuseColor.rgb *= 1.0 - quayKerb * 0.3;
        // The promenade: small granite setts in rows along the river, cooler and darker than the precast paving.
        if (prom > 0.0 && approach < 0.5) {
          vec2 sp = vec2(dq / 0.32, gp.y / 0.44 + 0.5 * mod(floor(dq / 0.32), 2.0));
          vec2 sj = abs(fract(sp) - 0.5);
          float sjoint = 1.0 - smoothstep(0.38, 0.47, max(sj.x, sj.y));
          vec3 sett = vec3(0.34, 0.335, 0.33) * (0.82 + 0.3 * gHash(floor(sp))) * mix(0.55, 1.0, sjoint);
          diffuseColor.rgb = mix(diffuseColor.rgb, sett, prom * (1.0 - plaza));
        }
        // Plaza ring: a band of lighter dressed stone at the plaza's edge.
        float ring = smoothstep(plazaR - 4.0, plazaR - 3.6, plazaD) * (1.0 - smoothstep(plazaR - 1.2, plazaR - 0.8, plazaD));
        diffuseColor.rgb *= 1.0 + ring * 0.18;
        // Inside the plaza: warmer, paler dressed paving laid in concentric courses; a court is laid in a grid of
        // large slabs in staggered rows, and a little darker, so the quarter reads as one paved yard.
        vec2 paveTilt = vec2(0.0);
        float course = 1.0 - 0.3 * (1.0 - smoothstep(0.02, 0.06, abs(fract(plazaD / 6.0) - 0.5) - 0.44));
        if (court > 0.0) {
          vec2 cl = gp - plazaC;
          float row = floor(cl.y / 3.0);
          // Relief: each slab bedded a touch out of true, and its arrises worn round into the joint, so the court
          // catches the lanterns slab by slab instead of lying flat as a printed grid.
          vec2 sl = fract(vec2(cl.x / 6.0 + 0.5 * mod(row, 2.0), cl.y / 3.0)) - 0.5;
          vec2 sid = vec2(floor(cl.x / 6.0 + 0.5 * mod(row, 2.0)), row);
          paveTilt = (vec2(gHash(sid + 3.1), gHash(sid + 7.7)) - 0.5) * 0.07;
          paveTilt += vec2(smoothstep(0.43, 0.5, abs(sl.x)) * sign(sl.x), smoothstep(0.4, 0.5, abs(sl.y)) * sign(sl.y)) * 0.45;
          paveTilt *= plaza;
          vec2 slab = abs(fract(vec2(cl.x / 6.0 + 0.5 * mod(row, 2.0), cl.y / 3.0)) - 0.5);
          float joint = 1.0 - smoothstep(0.455, 0.48, max(slab.x * 1.0, slab.y * 0.5 + 0.25));
          course = (0.86 + 0.08 * gHash(vec2(floor(cl.x / 6.0 + 0.5 * mod(row, 2.0)), row))) * mix(0.72, 1.0, joint);
        }
        vec3 civicTone = vec3(1.0);
        if (civic && plazaD < plazaR) {
          // The civic plaza is laid to the exchange, not in rings: pale slabs in running bond across the axis; a
          // processional of dark granite setts from the stair to the fountain and on to the plaza's edge; a rosette
          // of radiating setts round the basin inside a dark band; and a dark border framing the forecourt.
          vec2 cl = gp - plazaC;
          float row = floor(cl.y / 1.5);
          vec2 slab = abs(fract(vec2(cl.x / 3.0 + 0.5 * mod(row, 2.0), cl.y / 1.5)) - 0.5);
          float sj = 1.0 - smoothstep(0.46, 0.49, max(slab.x, slab.y * 0.5 + 0.25));
          course = (0.9 + 0.1 * gHash(vec2(floor(cl.x / 3.0 + 0.5 * mod(row, 2.0)), row))) * mix(0.8, 1.0, sj);
          vec2 fd = cl - FOUNT;
          float fr = length(fd);
          float axis = step(abs(cl.x), 6.0) * step(STAIR_FOOT, cl.y);
          vec2 sett = abs(fract(cl / 0.6) - 0.5);
          float sjoint = 1.0 - smoothstep(0.42, 0.48, max(sett.x, sett.y));
          vec3 granite = vec3(0.56, 0.55, 0.56) * (0.88 + 0.16 * gHash(floor(cl / 0.6))) * mix(0.7, 1.0, sjoint);
          float rosette = step(FOUNT_R + 0.4, fr) * step(fr, FOUNT_R + 7.0);
          float ringJ = abs(fract(fr / 0.8) - 0.5);
          float rayJ = abs(fract(atan(fd.y, fd.x) / 6.28318530718 * 96.0 + floor(fr / 0.8) * 0.5) - 0.5);
          float rj = 1.0 - smoothstep(0.42, 0.48, max(ringJ, rayJ));
          vec3 rose = vec3(1.08, 1.0, 0.9) * (0.9 + 0.12 * gHash(vec2(floor(fr / 0.8), floor(atan(fd.y, fd.x) * 15.0)))) * mix(0.72, 1.0, rj);
          float band = step(FOUNT_R + 7.0, fr) * step(fr, FOUNT_R + 8.2);
          float border = step(abs(abs(cl.x) - (HALL_HALF + 4.0)), 0.6) * step(STAIR_FOOT - 1.0, cl.y) * step(cl.y, 66.0);
          civicTone = mix(vec3(1.0), granite / course, max(axis * (1.0 - rosette), 0.0));
          civicTone = mix(civicTone, rose / course, rosette);
          civicTone = mix(civicTone, vec3(0.5, 0.49, 0.5) / course, max(band, border));
        }
        diffuseColor.rgb *= mix(vec3(1.0), vec3(1.28, 1.2, 1.08) * course * civicTone, plaza * (1.0 - ring));
        roughnessFactor = mix(roughnessFactor, 0.74 + grain, road);`,
      )
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n        normal = normalize(normal + (viewMatrix * vec4(paveTilt.x, 0.0, paveTilt.y, 0.0)).xyz);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float light = 0.0;
          bool nearP = plazaD < plazaR + 24.0;
          for (int k = 0; k < 4; k++) {
            float o = OFFS[k];
            vec2 lamps[4] = vec2[4](vec2(o, LAMP_AT), vec2(LAMP_AT, o), vec2(o, LAMP_AT - PITCH), vec2(LAMP_AT - PITCH, o));
            for (int q = 0; q < 4; q++) {
              vec2 lp = lamps[q];
              // No street lamp stands in the river's channel (grid.ts), so none lights the quay.
              if (abs(cellId.x * PITCH + lp.x - RIVER_X) < RIVER_HALF + 2.0) continue;
              if (nearP) {
                vec2 pole = cellId * PITCH + lp - (q % 2 == 0 ? vec2(0.0, ${LAMP_REACH.toFixed(2)}) : vec2(${LAMP_REACH.toFixed(2)}, 0.0));
                if (inPlaza(pole)) continue;
              }
              light += pool(lc - lp);
            }
          }
          // The quay lamps: warm white lanterns along both promenades (river.ts).
          float quayLight = 0.0;
          if (dq > -1.0 && dq < QUAY_W + 6.0) {
            float side = gp.x < RIVER_X ? -1.0 : 1.0;
            float lx = side < 0.0 ? BANK_W - QLAMP_IN : BANK_E + QLAMP_IN;
            float zl = floor(gp.y / QLAMP_STEP + 0.5) * QLAMP_STEP;
            for (int k = -1; k <= 1; k++) {
              float z = zl + float(k) * QLAMP_STEP;
              if (quayLamp(side, z)) quayLight += pool(gp - vec2(lx, z));
            }
          }
          // Lanterns around the nearest plaza, or lining a quarter's court.
          float streetLight = light;
          if (court > 0.0) {
            vec2 d = gp - plazaC;
            float l = court - LANTERN_IN;
            if (plazaD < l + 14.0) {
              // The nearest lantern on the edge running along x, and on the edge running along z.
              float ux = clamp(floor(d.x / LANTERN_STEP + 0.5) * LANTERN_STEP, -LANTERN_REACH, LANTERN_REACH);
              float uz = clamp(floor(d.y / LANTERN_STEP + 0.5) * LANTERN_STEP, -LANTERN_REACH, LANTERN_REACH);
              vec2 a = vec2(ux, sign(d.y) * l);
              vec2 b = vec2(sign(d.x) * l, uz);
              if (!(a.y > 0.0 && abs(a.x) < PLINTH_CLEAR)) light += 0.8 * pool(d - a);
              light += 0.8 * pool(d - b);
            }
          } else if (plazaD < RING_R + 14.0) {
            vec2 d = gp - plazaC;
            float step_ = 6.28318530718 / RING_N;
            float a = floor(atan(d.y, d.x) / step_ + 0.5) * step_;
            vec2 lp = vec2(cos(a), sin(a)) * RING_R;
            light += 0.8 * pool(d - lp);
          }
          // The civic plaza: a broad pool under each of the exchange's lamp standards, the warm spill of the open
          // doors down the stair and onto the forecourt, and the lamps' light caught round the basin's kerb.
          if (civic && plazaD < plazaR + 10.0) {
            vec2 cl = gp - plazaC;
            for (int k = 0; k < 4; k++) {
              vec2 d = cl - CIVIC_LAMP[k];
              float dd = dot(d, d);
              light += 1.25 * exp(-dd / 70.0) + 0.3 * exp(-dd / 520.0);
            }
            float spill = exp(-pow(max(abs(cl.x) - 18.0, 0.0), 2.0) / 30.0) * exp(-pow(max(cl.y - STAIR_FOOT, 0.0), 2.0) / 90.0) * step(STAIR_FOOT - 2.0, cl.y);
            light += 0.55 * spill;
            float fr = length(cl - FOUNT);
            light += 0.35 * exp(-pow(fr - FOUNT_R - 0.6, 2.0) / 3.0);
          }
          // District plazas: floodlight spill at the plinth's foot and lit bollards around it.
          // The plaza floor holds a broad, low wash from all of it together, brightest toward the plinth.
          if (district) light += 0.55 * (1.0 - smoothstep(18.0, PLAZA_R - 4.0, plazaD));
          // A quarter: floodlight spill at the foot of each standing tower's root, and a softer wash over the court.
          if (court > 0.0 && plots >= 0.0 && plazaD < court) {
            vec2 d = gp - plazaC;
            light += 0.3 * (1.0 - smoothstep(court - 30.0, court, plazaD));
            for (int k = 0; k < 4; k++) {
              if (mod(floor(plots / pow(2.0, float(k))), 2.0) < 0.5) continue;
              vec2 off = vec2(k % 2 == 0 ? -QOFF : QOFF, k < 2 ? -QOFF : QOFF);
              vec2 q = abs(d - off);
              float foot = max(q.x, q.y);
              light += 2.0 * exp(-pow(max(foot - AGENT_FOOT, 0.0), 2.0) / 9.0) * step(AGENT_FOOT - 0.5, foot);
            }
          }
          if (district && plazaD < BOLLARD_R + 10.0) {
            vec2 d = gp - plazaC;
            vec2 q = abs(d);
            float foot = max(q.x, q.y);
            light += 2.2 * exp(-pow(max(foot - PLINTH_HALF, 0.0), 2.0) / 9.0) * step(PLINTH_HALF - 0.5, foot);
            vec2 b = ringLight(d, BOLLARD_R, BOLLARD_N, 0.5);
            light += 1.6 * exp(-dot(b, b) / 5.0);
          }
          // A bankrupt firm's court: its lanterns and floodlights out with its towers (lightsout.ts), a re-clad tower's own spill back on.
          if (court > 0.0) light = streetLight + (light - streetLight) * (1.0 - lightsOut(vec3(gp.x, 0.0, gp.y)));
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.56, 0.22) * light * 2.6;
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.74, 0.46) * quayLight * 2.4;
        }`,
      );
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.name = 'ground';

  return {
    mesh,
    setPlazas(plazas) {
      const all: Plaza[] = [{ x: 0, z: 0 }, ...plazas].slice(0, MAX_PLAZAS);
      // A dark quarter's plots go in as -1: its floodlights are off.
      all.forEach((p, i) => uniforms.uPlazas.value[i].set(p.x, p.z, p.court ?? 0, p.dark ? -1 : (p.towers ?? 0)));
      uniforms.uPlazaCount.value = all.length;
    },
    plazas: () => uniforms.uPlazaCount.value,
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/**
 * A plain dressed-stone plinth reserving a district's place: three steps, a
 * base and a cornice, washed with warm floodlight from the ground (the
 * plaza's floor shows the matching spill). Towers stand on this footprint
 * from Task 8.
 */
export function makePlinth(): THREE.Group {
  const mat = floodlitStone();
  const g = new THREE.Group();
  const FOOT = PLINTH_FOOT;
  for (let s = 0; s < 3; s++) {
    const step = worldBox(FOOT + 8 - s * 2, 0.45, FOOT + 8 - s * 2, mat, 2.5);
    step.position.y = 0.225 + s * 0.45;
    g.add(step);
  }
  const base = worldBox(FOOT, 2.6, FOOT, mat, 2.2);
  base.position.y = 1.35 + 1.3;
  g.add(base);
  const cornice = worldBox(FOOT + 1.4, 0.7, FOOT + 1.4, mat, 2.2);
  cornice.position.y = 1.35 + 2.6 + 0.35;
  g.add(cornice);
  return g;
}

let floodlit: THREE.MeshStandardMaterial | null = null;

/**
 * The sandstone scan lit as if by floodlights at the plinth's foot: warm
 * light on the sides falling off with height, a little on the top. Light
 * here is albedo-weighted, so the stone's own texture carries it.
 */
function floodlitStone(): THREE.MeshStandardMaterial {
  if (floodlit) return floodlit;
  const sand = materials().sand;
  const m = new THREE.MeshStandardMaterial({
    map: sand.map,
    normalMap: sand.normalMap,
    aoMap: sand.aoMap,
    roughnessMap: sand.roughnessMap,
    color: 0xf3e9da,
    roughness: 1,
  });
  m.customProgramCacheKey = () => 'palimpsest-floodlit-stone';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlP; varying vec3 vFlN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvFlP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFlN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlP; varying vec3 vFlN;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float side = 1.0 - abs(vFlN.y);
        float wash = side * (0.35 + 0.9 * exp(-vFlP.y / 2.2)) + (1.0 - side) * 0.25;
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.7, 0.42) * wash * 1.1;`,
      );
  };
  floodlit = m;
  return m;
}
