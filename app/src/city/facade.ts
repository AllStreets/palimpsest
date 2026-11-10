import * as THREE from 'three';

import type { Archetype } from './lots';
import { SECTIONS } from './lots';
import { texture } from './materials';

/**
 * The ambient city's facades, one program per building type, drawn from
 * world position in the shader so every building keeps real window scale at
 * any size (a stretched texture reads as a toy). Each instance carries its
 * wall colour (instance colour), an accent (`aAccent`: sills and cornices,
 * spandrels, glass, window frames) and a style (`aStyle`: paint, rhythm
 * seed, lit share, variant), so one material draws every building of a type
 * in all its colours and patterns.
 *
 * - walkup: brick (scanned, recoloured per building), punched windows under
 *   stone lintels on sills, fire escapes on some fronts, lit shopfronts;
 * - commercial: dressed stone (scanned), a rusticated base, windows grouped
 *   between piers over recessed spandrels;
 * - midcentury: ribbon windows over enamelled spandrel panels, or a curtain
 *   wall with proud mullions;
 * - glass: unitised curtain wall, fins, or banded spandrel glass, glossy
 *   and mirrored so the panes give back the dusk sky;
 * - brutalist: board-formed concrete, deep-set windows, rain staining;
 * - parking: open decks with upstands, columns, ceiling tubes and cars;
 * - industrial: brick piers and multi-pane steel windows, or corrugated
 *   siding, roll-up doors at the dock.
 * Roofs (faces pointing up) are gravel, membrane, tar, metal or parking deck.
 */

const ARCH_ID: Record<Archetype, number> = { walkup: 1, commercial: 2, midcentury: 3, glass: 4, brutalist: 5, parking: 6, industrial: 7 };

/** Scanned surfaces, sampled in world space so every wall keeps real scale: texture prefix, metres per tile, and the scan's mean linear colour. */
const SCANS: Partial<Record<Archetype, { prefix: string; tile: number; mean: [number, number, number] }>> = {
  walkup: { prefix: 'brick', tile: 1.5, mean: [0.15, 0.096, 0.079] },
  industrial: { prefix: 'brick', tile: 1.5, mean: [0.15, 0.096, 0.079] },
  commercial: { prefix: 'ashlar', tile: 3.2, mean: [0.438, 0.334, 0.191] },
};

const v3 = (v: [number, number, number]): string => `vec3(${v.map((x) => x.toFixed(4)).join(', ')})`;

export function facadeMaterial(arch: Archetype): THREE.MeshStandardMaterial {
  const scan = SCANS[arch];
  const glassy = arch === 'glass';
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: glassy ? 0.3 : 0.85 });
  if (scan) {
    m.map = texture(`${scan.prefix}_diff.jpg`, true);
    m.normalMap = texture(`${scan.prefix}_nor.jpg`);
    m.roughnessMap = texture(`${scan.prefix}_arm.jpg`);
    m.normalScale.set(0.9, 0.9);
  }
  // Low-e glazing is more reflective than bare glass; the extra env weight stands in for its coating.
  m.envMapIntensity = glassy ? 2.6 : arch === 'midcentury' ? 1.6 : 1.0;
  const s = SECTIONS[arch];
  m.customProgramCacheKey = () => `palimpsest-ambient-${arch}`;
  m.onBeforeCompile = (sh) => {
    const mean = scan?.mean ?? [1, 1, 1];
    sh.defines = {
      ...(sh.defines ?? {}),
      ARCH: ARCH_ID[arch],
      FACADE_TILE: (scan?.tile ?? 1).toFixed(2),
      GROUND: s.ground.toFixed(2),
      STOREY: s.floor.toFixed(2),
      PARAPET: s.parapet.toFixed(2),
    };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 aAccent; attribute vec4 aStyle;
        varying vec3 vWP; varying vec3 vWN; varying vec3 vSeed; varying vec3 vSize; varying vec3 vAccent; varying vec4 vStyle;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        mat4 mm = modelMatrix;
        #ifdef USE_INSTANCING
          mm = modelMatrix * instanceMatrix;
        #endif
        vWP = (mm * vec4(transformed, 1.0)).xyz;
        vWN = normalize(mat3(mm) * objectNormal);
        vSeed = mm[3].xyz;
        vSize = vec3(length(mm[0].xyz), length(mm[1].xyz), length(mm[2].xyz));
        vAccent = aAccent;
        vStyle = aStyle;
        vec2 wuv = (abs(vWN.x) > 0.5 ? vWP.zy : abs(vWN.z) > 0.5 ? vWP.xy : vWP.xz) / FACADE_TILE;
        #ifdef USE_MAP
          vMapUv = wuv;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv = wuv;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv = wuv;
        #endif`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWP; varying vec3 vWN; varying vec3 vSeed; varying vec3 vSize; varying vec3 vAccent; varying vec4 vStyle;
        float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
        float box1(float x, float a, float b, float e) { return smoothstep(a, a + e, x) * smoothstep(b, b - e, x); }`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          // The scan recoloured to the building's own brick or stone: its grain as luminance over the instance colour,
          // its own colour variation kept (paint -1), or flattened under a coat of paint (paint toward 1).
          vec4 tx = texture2D(map, vMapUv);
          float gl = dot(tx.rgb, vec3(0.2126, 0.7152, 0.0722)) / dot(${v3(mean)}, vec3(0.2126, 0.7152, 0.0722));
          vec3 grain = vStyle.x < -0.5 ? tx.rgb / ${v3(mean)} : mix(vec3(gl), vec3(1.0), clamp(vStyle.x, 0.0, 1.0) * 0.6);
          if (vStyle.w > 1.5 || vWN.y > 0.5) grain = vec3(1.0);
          diffuseColor.rgb *= grain;
        #endif`,
      )
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FACADE_GLSL}`);
  };
  return m;
}

const FACADE_GLSL = /* glsl */ `
  vec3 an = abs(vWN);
  float bs = vStyle.y;
  float variant = fract(vStyle.w);
  float siding = step(1.5, vStyle.w);
  float vTop = vSeed.y + vSize.y * 0.5;
  float vBase = vSeed.y - vSize.y * 0.5;
  if (an.y < 0.5) {
    bool onX = an.x > 0.5;
    float u = onX ? vWP.z : vWP.x;
    float faceW = onX ? vSize.z : vSize.x;
    // Along the face from its own corner, so bays sit symmetrically between the corners as built ones do.
    float lu = u - ((onX ? vSeed.z : vSeed.x) - faceW * 0.5);
    float face = floor(dot(sign(vWN.xz), vec2(1.0, 2.0)) + 3.0);
    vec3 tangentView = normalize((viewMatrix * vec4(onX ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0), 0.0)).xyz);
    vec3 wall = diffuseColor.rgb;
    float y = vWP.y;
    float fromTop = vTop - y;
    // Grime: darker at the foot, a little soot under the parapet.
    float grime = mix(0.8, 1.0, smoothstep(0.0, 3.0, y)) * mix(0.9, 1.0, smoothstep(0.0, 2.5, fromTop));
    // Light falls off into the building's own corners, and weather mottles a wall in broad patches.
    float edge = min(lu, faceW - lu);
    grime *= mix(0.78, 1.0, smoothstep(0.0, 1.4, edge));
    grime *= 0.93 + 0.07 * sin(lu * 0.37 + bs * 40.0) * sin(y * 0.23 + lu * 0.11 + bs * 9.0);
    float win = 0.0, lit = 0.0, k = 0.0, room = 1.0, shade = 1.0, glow = 1.0;
    vec3 lamp = vec3(1.0, 0.74, 0.45);
    float occupancy = clamp(vStyle.z, 0.0, 0.92);
    vec2 cell = vec2(0.0), id = vec2(0.0);
    float x0 = 0.3, x1 = 0.7, y0 = 0.2, y1 = 0.8;
    bool ground = vBase < 0.5 && y < GROUND;
    bool parapet = fromTop < PARAPET;

    // ---------------------------------------------------------------- the ground storey
    if (ground) {
      #if ARCH == 6
        // Parking: open bays between columns at the street, the entry lit.
        float bw = 8.2;
        float n = max(1.0, floor(faceW / bw + 0.5));
        float cw = faceW / n;
        float bx = fract(lu / cw);
        float open = box1(bx, 0.07, 0.93, 0.01) * box1(y, 0.0, GROUND - 0.6, 0.05);
        diffuseColor.rgb = mix(wall, vec3(0.018, 0.018, 0.02), open);
        totalEmissiveRadiance += open * vec3(0.9, 0.95, 1.0) * 0.2 * smoothstep(GROUND - 1.0, GROUND - 0.7, y);
      #elif ARCH == 7
        // The dock: roll-up doors of ribbed steel, a few open on lit sheds; brick or siding between.
        float bw = 5.4;
        float n = max(1.0, floor(faceW / bw + 0.5));
        float cw = faceW / n;
        float bx = fract(lu / cw);
        float bid = floor(lu / cw);
        float door = box1(bx, 0.16, 0.84, 0.01) * box1(y, 0.0, 4.0, 0.02) * step(0.35, h21(vec2(bid, bs * 17.0 + face)));
        float openDoor = door * step(0.8, h21(vec2(bid * 3.1, bs + face)));
        float ribs = 0.8 + 0.2 * step(0.5, fract(y / 0.18));
        diffuseColor.rgb = mix(diffuseColor.rgb, vAccent * 1.4 * ribs, door);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02), openDoor);
        totalEmissiveRadiance += openDoor * vec3(1.0, 0.78, 0.5) * 0.35 * (0.6 + 0.4 * smoothstep(0.0, 3.5, y));
        roughnessFactor = mix(roughnessFactor, 0.5, door);
      #else
        // Shopfronts and lobbies: tall glass bays under a fascia, most of them lit.
        float bw = 4.2 + bs * 2.4;
        float n = max(1.0, floor(faceW / bw + 0.5));
        float cw = faceW / n;
        float bx = fract(lu / cw);
        float bid = floor(lu / cw) + face * 31.0;
        float top = GROUND - 1.0;
        float glass = box1(bx, 0.06, 0.94, 0.01) * box1(y, 0.35, top, 0.06);
        glass *= 1.0 - 0.85 * box1(bx, 0.495, 0.505, 0.004);
        float open = step(0.32, h21(vec2(bid, bs * 31.0)));
        // Shut shops pull a ribbed steel shutter down over the glass.
        float shut = (1.0 - open) * step(0.5, h21(vec2(bid, bs * 5.0)));
        vec3 shop = mix(vec3(1.0, 0.66, 0.36), vec3(0.82, 0.88, 1.0), step(0.8, h21(vec2(bid * 1.3, bs))));
        // The shop's depth: brighter toward the ceiling, darker goods and people against the glass below.
        float depth = 0.35 + 0.65 * smoothstep(0.4, top, y);
        float goods = 0.6 + 0.4 * step(0.5, h21(floor(vec2(lu / 0.7, y / 0.6)) + bid));
        totalEmissiveRadiance += glass * open * shop * depth * goods * (0.18 + 0.32 * h21(vec2(bid, 7.0)));
        // A fascia band for the sign, painted per shop, and a stone or metal plinth under the glass.
        float fascia = box1(y, top + 0.15, GROUND - 0.15, 0.02);
        vec3 sign = mix(vec3(0.04, 0.045, 0.05), vAccent, step(0.5, h21(vec2(bid, 3.0))));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02), glass);
        diffuseColor.rgb = mix(diffuseColor.rgb, sign, fascia * 0.85);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.16, 0.155) * (0.8 + 0.2 * step(0.5, fract(y / 0.09))), glass * shut);
        roughnessFactor = mix(roughnessFactor, 0.1, glass * (1.0 - shut));
        #if ARCH == 2
          // Rusticated base: deep horizontal joints in the stone piers.
          float rust = box1(fract(y / 0.62), 0.0, 0.07, 0.02) * (1.0 - glass);
          diffuseColor.rgb *= 1.0 - 0.45 * rust;
          normal = normalize(normal + vec3(0.0, 1.0, 0.0) * rust * 0.4);
        #endif
      #endif
      diffuseColor.rgb *= grime;
    } else if (!parapet) {
      float wy = y - GROUND;
      float fh = STOREY;
      // Bays sized to the face: as near the type's own bay as whole bays allow.
      float bayT = 2.4;
      #if ARCH == 1
        bayT = 2.2 + bs * 0.6;
      #elif ARCH == 2
        bayT = 5.0 + bs * 1.2;
      #elif ARCH == 3
        bayT = 1.5;
      #elif ARCH == 4
        bayT = variant < 0.33 ? 1.5 : variant < 0.66 ? 1.2 : 3.0;
      #elif ARCH == 5
        bayT = 2.8 + bs * 0.6;
      #elif ARCH == 6
        bayT = 8.2;
      #elif ARCH == 7
        bayT = siding > 0.5 ? 3.0 : 5.0 + bs * 1.0;
      #endif
      float n = max(1.0, floor(faceW / bayT + 0.5));
      float cw = faceW / n;
      cell = vec2(fract(lu / cw), fract(wy / fh));
      id = vec2(floor(lu / cw) + face * 97.0, floor(wy / fh));
      float floorOn = step(0.22, h21(vec2(id.y, bs * 91.0 + face)));
      lit = step(1.0 - occupancy, h21(id + bs * 57.0)) * floorOn;
      lamp = mix(vec3(1.0, 0.74, 0.45), vec3(0.8, 0.9, 1.0), step(0.68, h21(vec2(bs, id.y))));
      k = 0.25 + 0.75 * pow(h21(id * 1.7 + bs), 2.0);

      #if ARCH == 1
        // Walk-up: one punched window per bay, a stone lintel over and a sill under, deep reveals.
        x0 = 0.31; x1 = 0.69; y0 = 0.2; y1 = 0.78;
        win = box1(cell.x, x0, x1, 0.02) * box1(cell.y, y0, y1, 0.02);
        float trim = box1(cell.x, x0 - 0.05, x1 + 0.05, 0.01) * (box1(cell.y, y0 - 0.06, y0, 0.01) + box1(cell.y, y1, y1 + 0.07, 0.01));
        diffuseColor.rgb = mix(diffuseColor.rgb, vAccent, trim * 0.9);
        // A brick soldier course at each floor line on some buildings.
        diffuseColor.rgb *= 1.0 - 0.12 * step(0.5, variant) * box1(cell.y, 0.0, 0.04, 0.01);
        // Fire escape on the street fronts of some: platforms at each floor, rails, ladders between, over two bays.
        float feAt = floor(variant * max(1.0, n - 1.0));
        float fe = step(0.35, variant) * step(feAt, floor(lu / cw)) * step(floor(lu / cw), feAt + 1.0) * step(1.0, id.y);
        float lx = fract(lu / (cw * 2.0) + 0.5 * mod(feAt, 2.0));
        float platform = box1(cell.y, 0.0, 0.035, 0.005);
        float rail = box1(cell.y, 0.27, 0.29, 0.005) + box1(cell.y, 0.0, 0.29, 0.005) * step(0.8, fract(lu / 0.2)) * 0.6;
        float ladder = box1(abs(fract(lx * 0.9 + cell.y * 0.45) - 0.5), 0.0, 0.025, 0.006) * box1(lx, 0.15, 0.85, 0.01);
        float iron = clamp(platform + rail + ladder, 0.0, 1.0) * fe * box1(lx, 0.04, 0.96, 0.01);
        shade *= 1.0 - 0.6 * fe * box1(cell.y, 0.0, 0.3, 0.02);
      #elif ARCH == 2
        // Commercial: piers between bays, two or three windows a bay, recessed spandrels in a darker stone.
        float pier = 1.0 - box1(cell.x, 0.1, 0.9, 0.01);
        float panes = variant < 0.5 ? 2.0 : 3.0;
        float px = fract((cell.x - 0.1) / 0.8 * panes);
        x0 = 0.1; x1 = 0.9; y0 = 0.14; y1 = 0.86;
        win = box1(cell.x, x0, x1, 0.01) * box1(cell.y, y0, y1, 0.015) * box1(px, 0.06, 0.94, 0.02);
        float spandrel = box1(cell.x, x0, x1, 0.01) * (1.0 - box1(cell.y, y0, y1, 0.015)) * (1.0 - pier);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.62 + vAccent * 0.15, spandrel);
        normal = normalize(normal + tangentView * (box1(cell.x, 0.085, 0.11, 0.008) - box1(cell.x, 0.89, 0.915, 0.008)) * 0.6);
        float iron = 0.0;
      #elif ARCH == 3
        // Mid-century: a continuous ribbon of glass over an enamelled spandrel panel, or a curtain wall with proud mullions.
        bool curtain = variant > 0.6;
        y0 = curtain ? 0.24 : 0.4; y1 = 0.97;
        float mull = 1.0 - box1(cell.x, 0.03, 0.97, 0.004);
        win = box1(cell.y, y0, y1, 0.008) * (1.0 - mull);
        float spandrel = 1.0 - box1(cell.y, y0, y1, 0.008);
        float joint = box1(cell.x, 0.0, 0.015, 0.004) * spandrel;
        diffuseColor.rgb = mix(diffuseColor.rgb, vAccent * (0.92 + 0.12 * h21(id)) * (1.0 - joint * 0.5), spandrel);
        roughnessFactor = mix(roughnessFactor, 0.35, spandrel);
        metalnessFactor = mix(metalnessFactor, 0.6, mull);
        normal = normalize(normal + tangentView * (box1(cell.x, 0.0, 0.03, 0.004) - box1(cell.x, 0.97, 1.0, 0.004)) * (curtain ? 0.9 : 0.3));
        float iron = 0.0;
      #elif ARCH == 4
        // Glass: unitised panels, fins, or bands of spandrel glass; the panes mirror the sky.
        float slab = box1(cell.y, 0.0, variant < 0.66 ? 0.09 : 0.3, 0.006);
        float mw = variant < 0.33 ? 0.03 : variant < 0.66 ? 0.09 : 0.02;
        float mull = 1.0 - box1(cell.x, mw, 1.0 - mw, 0.004);
        win = (1.0 - slab) * (1.0 - mull);
        x0 = 0.0; x1 = 1.0; y0 = variant < 0.66 ? 0.09 : 0.3; y1 = 1.0;
        float iron = 0.0;
        glow = 0.6;
        normal = normalize(normal + tangentView * (box1(cell.x, 0.0, mw, 0.004) - box1(cell.x, 1.0 - mw, 1.0, 0.004)) * (variant > 0.33 && variant < 0.66 ? 1.4 : 0.4));
        vec3 pane = vAccent;
        diffuseColor.rgb = mix(diffuseColor.rgb, pane * 0.6, slab * (variant < 0.66 ? 0.0 : 1.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, wall * 0.6, slab * (variant < 0.66 ? 1.0 : 0.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, pane, win);
        // Each panel sits a touch out of plane, so the reflection breaks panel to panel as real glass does.
        float wobble = (h21(id * 2.3 + bs) - 0.5) * 0.06;
        normal = normalize(normal + tangentView * wobble * win);
        roughnessFactor = mix(roughnessFactor, 0.04, win + slab * 0.6);
        metalnessFactor = mix(metalnessFactor, 0.35 + 0.6 * clamp(vStyle.x, 0.0, 1.0), win + slab * 0.5);
        metalnessFactor = mix(metalnessFactor, 0.8, mull);
      #elif ARCH == 5
        // Brutalist: deep-set windows in a heavy frame, board-formed concrete, rain stains from the sills.
        x0 = 0.2; x1 = 0.8; y0 = 0.28; y1 = 0.8;
        win = box1(cell.x, x0, x1, 0.01) * box1(cell.y, y0, y1, 0.01);
        float board = 0.94 + 0.12 * h21(vec2(floor(y / 0.16), floor(lu / 2.4) + face));
        diffuseColor.rgb *= board * (1.0 - 0.15 * box1(fract(y / 0.16), 0.0, 0.06, 0.02));
        // Fins every other bay, standing proud.
        float fin = box1(cell.x, 0.0, 0.06, 0.01) * step(0.5, mod(id.x, 2.0));
        normal = normalize(normal + tangentView * fin * 0.8);
        diffuseColor.rgb *= 1.0 - 0.18 * step(0.5, variant) * box1(cell.y, y1, y1 + 0.08, 0.01);
        float iron = 0.0;
      #elif ARCH == 6
        // Parking: an upstand, the open deck with its ceiling tubes and the cars, the slab edge, columns.
        float col = 1.0 - box1(cell.x, 0.04, 0.96, 0.005);
        float open = box1(cell.y, 0.38, 0.9, 0.006) * (1.0 - col);
        float mesh = siding;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.015, 0.016, 0.018), open * (1.0 - mesh * 0.55));
        // Fluorescent tubes on the deck ceiling, in a cool white, every few metres.
        float tube = box1(cell.y, 0.84, 0.88, 0.006) * box1(fract(lu / 2.7), 0.25, 0.75, 0.05) * open;
        totalEmissiveRadiance += tube * vec3(0.8, 0.92, 1.0) * (0.9 - mesh * 0.5) + open * vec3(0.06, 0.07, 0.08) * (1.0 - mesh);
        // Cars parked against the upstand.
        float slot = floor(lu / 2.6);
        float car = box1(cell.y, 0.38, 0.55, 0.01) * box1(fract(lu / 2.6), 0.08, 0.92, 0.03) * step(0.35, h21(vec2(slot, id.y + bs * 13.0))) * open;
        vec3 paint = vec3(0.04, 0.045, 0.05) + 0.25 * vec3(h21(vec2(slot, id.y)), h21(vec2(slot * 1.3, id.y)), h21(vec2(slot * 2.1, id.y))) * step(0.6, h21(vec2(slot, 9.0)));
        diffuseColor.rgb = mix(diffuseColor.rgb, paint, car * (1.0 - mesh));
        // A metal mesh screen over the decks on some: perforated, the light glowing through.
        float holes = step(0.5, fract(lu * 6.0)) * step(0.5, fract(y * 6.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, vAccent * (0.7 + 0.3 * holes), mesh * (1.0 - col) * box1(cell.y, 0.3, 1.0, 0.01));
        metalnessFactor = mix(metalnessFactor, 0.7, mesh * (1.0 - col));
        roughnessFactor = mix(roughnessFactor, 0.45, mesh * (1.0 - col));
        float edge = box1(cell.y, 0.9, 1.0, 0.004) + box1(cell.y, 0.0, 0.03, 0.004);
        diffuseColor.rgb *= 1.0 - 0.15 * edge;
        float iron = 0.0;
        win = 0.0;
      #elif ARCH == 7
        // Industrial: wide steel windows of small panes between brick piers; or a ribbon high in corrugated siding.
        float iron = 0.0;
        if (siding > 0.5) {
          x0 = 0.04; x1 = 0.96; y0 = 0.62; y1 = 0.86;
          win = box1(cell.x, x0, x1, 0.005) * box1(cell.y, y0, y1, 0.01) * step(0.3, h21(vec2(id.y, bs)));
          float rib = sin(lu * 6.2831853 / 0.2);
          normal = normalize(normal + tangentView * rib * 0.25 * (1.0 - win));
          diffuseColor.rgb *= 0.9 + 0.1 * rib;
          metalnessFactor = mix(metalnessFactor, 0.55, 1.0 - win);
          roughnessFactor = mix(roughnessFactor, 0.5, 1.0 - win);
          diffuseColor.rgb *= 0.85 + 0.25 * h21(vec2(floor(lu / 0.9), 3.0));
        } else {
          x0 = 0.16; x1 = 0.84; y0 = 0.12; y1 = 0.84;
          win = box1(cell.x, x0, x1, 0.01) * box1(cell.y, y0, y1, 0.01);
          float pane = box1(fract((cell.x - x0) / (x1 - x0) * 6.0), 0.07, 0.93, 0.02) * box1(fract((cell.y - y0) / (y1 - y0) * 5.0), 0.08, 0.92, 0.02);
          iron = win * (1.0 - pane);
          // A segmental head of brick on edge, and a stone sill.
          float head = box1(cell.x, x0 - 0.02, x1 + 0.02, 0.01) * box1(cell.y, y1, y1 + 0.05, 0.01);
          diffuseColor.rgb *= 1.0 - 0.18 * head;
        }
        glow = 0.75;
        lamp = mix(lamp, vec3(0.75, 0.88, 1.0), 0.5);
      #endif

      // The room behind the glass: ceiling light falling toward the sill, blinds at varied heights.
      float wy01 = clamp((cell.y - y0) / max(0.01, y1 - y0), 0.0, 1.0);
      float wx01 = clamp((cell.x - x0) / max(0.01, x1 - x0), 0.0, 1.0);
      room = 0.45 + 0.55 * smoothstep(0.1, 0.95, wy01);
      float blindDrop = h21(id * 3.1 + bs) < 0.45 ? h21(id * 5.7) * 0.7 : 0.0;
      float slats = 0.75 + 0.25 * step(0.5, fract(cell.y * fh * 9.0));
      shade *= wy01 > 1.0 - blindDrop ? 0.4 * slats : 1.0;
      float reveal = 0.0;
      float revealShade = 1.0;
      #if ARCH == 1 || ARCH == 2 || ARCH == 5 || ARCH == 7
        // Deep reveals, seen as they are from where the eye stands: the jamb on the far side of the opening, the
        // soffit of the head from below and the sill from above, each as wide as the recess and the angle make it.
        #if ARCH == 5
          float rd = 0.55;
        #elif ARCH == 2
          float rd = 0.32;
        #else
          float rd = 0.24;
        #endif
        vec3 V = normalize(cameraPosition - vWP);
        vec3 T = onX ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
        float vn = max(dot(V, normalize(vWN)), 0.08);
        float vu = dot(V, T) / vn;
        float vy = V.y / vn;
        float ww = (x1 - x0) * cw;
        float wh = (y1 - y0) * fh;
        float rpx = wx01 * ww;
        float rpy = (1.0 - wy01) * wh;
        float jamb = vu > 0.0 ? step(rpx, rd * vu) : step(ww - rpx, -rd * vu);
        float head = step(rpy, rd * max(-vy, 0.0) + 0.04);
        float sill = step(wh - rpy, rd * max(vy, 0.0));
        reveal = max(max(jamb, head), sill) * win;
        revealShade = head > 0.5 ? 0.35 : sill > 0.5 ? 0.85 : 0.55;
        win *= 1.0 - reveal;
        // Rain stains: the sill's runoff darkens the wall below each opening.
        float below = box1(cell.x, x0 + 0.05, x1 - 0.05, 0.03) * smoothstep(y0, y0 - 0.5, cell.y) * step(cell.y, y0);
        diffuseColor.rgb *= 1.0 - (0.1 + 0.12 * h21(id + 2.0)) * below * (1.0 - win);
      #endif
      #if ARCH == 4
        vec3 behind = lamp * mix(vec3(1.0), vAccent * 4.0 + 0.25, 0.5);
      #else
        vec3 behind = lamp;
      #endif
      #if ARCH == 1
        // Window air conditioners in some of the walk-up windows, sat on the sill.
        float acOn = step(h21(id * 4.7 + bs), 0.2) * win;
        float ac = acOn * box1(wx01, 0.28, 0.72, 0.02) * box1(wy01, 0.0, 0.2, 0.02);
        win *= 1.0 - ac;
      #endif
      totalEmissiveRadiance += win * lit * behind * k * room * shade * glow;
      #if ARCH != 4 && ARCH != 6
        // Unlit glass is dark and glossy and gives back the sky.
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012, 0.014, 0.017), win);
        roughnessFactor = mix(roughnessFactor, 0.06, win * (1.0 - lit));
        metalnessFactor = mix(metalnessFactor, 0.3, win * (1.0 - lit));
      #endif
      // The reveal itself: the wall's own material turned into the opening, in its own light.
      diffuseColor.rgb = mix(diffuseColor.rgb, wall * revealShade, reveal);
      roughnessFactor = mix(roughnessFactor, 0.85, reveal);
      metalnessFactor = mix(metalnessFactor, 0.0, reveal);
      #if ARCH == 1
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.32, 0.3) * (0.8 + 0.2 * step(0.5, fract(vWP.y * 18.0))), ac);
      #endif
      #if ARCH == 1 || ARCH == 7
        diffuseColor.rgb = mix(diffuseColor.rgb, vAccent * 0.35, iron);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02, 0.021, 0.022), iron);
        roughnessFactor = mix(roughnessFactor, 0.5, iron);
      #endif
      diffuseColor.rgb *= grime;
      // Per-floor-run variation in the wall, as repairs and cleaning leave it.
      diffuseColor.rgb *= 0.95 + 0.1 * h21(vec2(floor(id.y / 3.0), bs * 7.0)) * (1.0 - win);
    } else {
      // The parapet: plain wall, a little darker where the coping drips.
      diffuseColor.rgb *= 0.92 * grime;
      #if ARCH == 4
        diffuseColor.rgb = mix(diffuseColor.rgb, vAccent * 0.7, 0.8);
        roughnessFactor = 0.08;
        metalnessFactor = 0.6;
      #endif
    }
  } else if (vWN.y > 0.5) {
    // Roofs, as each type has them: tar and silver-coated tar on walk-ups, gravel ballast, grey and white
    // membranes on offices (some under rows of solar panels), metal and skylights on sheds, decks on garages.
    float kind = h21(vSeed.xz * 0.021 + 7.3);
    float grit = h21(floor(vWP.xz * 1.7));
    vec2 rl = vWP.xz - (vSeed.xz - vSize.xz * 0.5);
    float inner = box1(rl.x, 2.0, vSize.x - 2.0, 0.1) * box1(rl.y, 2.0, vSize.z - 2.0, 0.1);
    vec3 gravel = vec3(0.085, 0.082, 0.077) * (0.8 + 0.4 * grit);
    float seam = 1.0 - 0.25 * box1(fract(vWP.x / 2.0), 0.0, 0.03, 0.01);
    vec3 membrane = vec3(0.17, 0.17, 0.165) * seam * (0.9 + 0.1 * grit);
    vec3 white = vec3(0.42, 0.43, 0.43) * seam * (0.85 + 0.15 * grit);
    vec3 tar = vec3(0.05, 0.048, 0.046) * (0.85 + 0.3 * grit);
    vec3 silver = vec3(0.26, 0.26, 0.255) * (0.75 + 0.25 * grit);
    #if ARCH == 1
      diffuseColor.rgb = kind < 0.35 ? tar : kind < 0.8 ? silver : gravel;
      roughnessFactor = kind < 0.45 ? 0.8 : kind < 0.8 ? 0.55 : 0.95;
    #elif ARCH == 3 || ARCH == 4
      diffuseColor.rgb = kind < 0.45 ? white : kind < 0.8 ? membrane : gravel;
      roughnessFactor = kind < 0.45 ? 0.6 : kind < 0.8 ? 0.6 : 0.95;
    #else
      diffuseColor.rgb = kind < 0.4 ? gravel : kind < 0.6 ? membrane : kind < 0.88 ? white : tar;
      roughnessFactor = kind < 0.5 ? 0.95 : 0.65;
    #endif
    metalnessFactor = 0.0;
    #if ARCH != 6 && ARCH != 7
      // Rows of solar panels on some flat roofs, tilted to the south, framed in aluminium.
      float solar = step(0.72, h21(vSeed.xz * 0.037 + 1.9)) * inner;
      float panel = box1(fract(rl.y / 2.4), 0.08, 0.62, 0.02) * box1(fract(rl.x / 1.05), 0.04, 0.96, 0.02) * solar;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.018, 0.024, 0.045), panel);
      roughnessFactor = mix(roughnessFactor, 0.15, panel);
      metalnessFactor = mix(metalnessFactor, 0.4, panel);
    #endif
    #if ARCH == 6
      float bayLine = box1(fract(vWP.x / 2.6), 0.0, 0.04, 0.01) * box1(fract(vWP.z / 16.0), 0.1, 0.9, 0.01);
      diffuseColor.rgb = mix(vec3(0.06, 0.06, 0.062) * (0.85 + 0.3 * grit), vec3(0.5, 0.5, 0.48), bayLine);
      roughnessFactor = 0.85;
    #elif ARCH == 7
      float rib = box1(fract(vWP.x / 0.6), 0.0, 0.2, 0.05);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.165, 0.17) * (0.8 + 0.2 * rib), step(0.6, kind));
      metalnessFactor = 0.4 * step(0.6, kind);
      // Skylights in a grid over the shop floor, a few lit from the night shift below.
      vec2 sk = vec2(fract(rl.x / 6.0), fract(rl.y / 4.0));
      float sky = box1(sk.x, 0.3, 0.7, 0.02) * box1(sk.y, 0.25, 0.75, 0.02) * inner * step(0.4, kind);
      float skyLit = step(0.82, h21(floor(rl / vec2(6.0, 4.0)) + vSeed.xz));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.06, 0.065), sky);
      roughnessFactor = mix(roughnessFactor, 0.2, sky);
      totalEmissiveRadiance += sky * skyLit * vec3(0.9, 0.95, 1.0) * 0.5;
    #endif
  }`;

/** Shared trim (copings, cornices, the brutalist cap): dentils under the cornices of masonry, read from afar as a band of shadow. */
export function trimMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
  m.customProgramCacheKey = () => 'palimpsest-ambient-trim';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 tWP; varying vec3 tWN; varying float tH;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        mat4 tm = modelMatrix;
        #ifdef USE_INSTANCING
          tm = modelMatrix * instanceMatrix;
        #endif
        tWP = (tm * vec4(transformed, 1.0)).xyz;
        tWN = normalize(mat3(tm) * objectNormal);
        tH = length(tm[1].xyz);`,
      );
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 tWP; varying vec3 tWN; varying float tH;').replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      if (abs(tWN.y) < 0.5 && tH > 0.5 && tH < 1.5) {
        // A cornice: a crown moulding at the top, a shadowed bed of modillions under it.
        float u = abs(tWN.x) > 0.5 ? tWP.z : tWP.x;
        float t = fract(tWP.y / tH);
        float bed = smoothstep(0.45, 0.4, t);
        float modillion = step(0.55, fract(u / 0.55));
        diffuseColor.rgb *= mix(1.0, mix(0.45, 0.8, modillion), bed) * (1.0 - 0.25 * smoothstep(0.75, 0.8, t) * smoothstep(0.9, 0.85, t));
      }
      if (tWN.y < -0.5) diffuseColor.rgb *= 0.5;`,
    );
  };
  return m;
}

/**
 * Roof structures (stair bulkheads, lift overruns, cores, chimneys, cars):
 * their walls carry a door on one side, panel joints or brick coursing by
 * size, a darker foot where the roof's water sits, and gravel or membrane on top.
 */
export function roofboxMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
  m.customProgramCacheKey = () => 'palimpsest-ambient-roofbox';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 rWP; varying vec3 rWN; varying vec3 rC; varying vec3 rS;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        mat4 rm = modelMatrix;
        #ifdef USE_INSTANCING
          rm = modelMatrix * instanceMatrix;
        #endif
        rWP = (rm * vec4(transformed, 1.0)).xyz;
        rWN = normalize(mat3(rm) * objectNormal);
        rC = rm[3].xyz;
        rS = vec3(length(rm[0].xyz), length(rm[1].xyz), length(rm[2].xyz));`,
      );
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 rWP; varying vec3 rWN; varying vec3 rC; varying vec3 rS;\nfloat rh(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }').replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      float y0 = rC.y - rS.y * 0.5;
      float yl = rWP.y - y0;
      if (abs(rWN.y) < 0.5) {
        bool onX = abs(rWN.x) > 0.5;
        float u = (onX ? rWP.z - rC.z : rWP.x - rC.x) + (onX ? rS.z : rS.x) * 0.5;
        float w = onX ? rS.z : rS.x;
        float big = step(1.8, rS.y) * step(2.0, min(rS.x, rS.z));
        // Coursing on masonry bulkheads, standing seams on metal ones, chosen per structure.
        float metal = step(0.5, rh(rC.xz * 0.11));
        float course = mix(1.0 - 0.18 * step(0.85, fract(rWP.y / 0.3)), 1.0 - 0.2 * step(0.9, fract(u / 0.6)), metal);
        diffuseColor.rgb *= mix(1.0, course, big);
        // A door on one face of the bigger ones.
        float faceId = dot(sign(rWN.xz), vec2(1.0, 2.0));
        float door = big * step(abs(faceId - (rh(rC.xz) < 0.5 ? 1.0 : -2.0)), 0.1) * step(abs(u - w * 0.5), 0.5) * step(yl, 2.1);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.032, 0.034), door);
        // Weather: darker toward the roof where water sits, lighter under the coping.
        diffuseColor.rgb *= mix(0.7, 1.0, smoothstep(0.0, 0.6, yl)) * mix(1.0, 0.85, smoothstep(rS.y - 0.25, rS.y, yl) * big);
        roughnessFactor = mix(roughnessFactor, 0.5, metal * big);
      } else if (rWN.y > 0.5) {
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.118, 0.112) * (0.8 + 0.4 * rh(floor(rWP.xz * 2.0))), step(2.0, min(rS.x, rS.z)));
      }`,
    );
  };
  return m;
}

/** Louvred plant screens and penthouses: horizontal blades, dark between them. */
export function louvreMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.45 });
  m.customProgramCacheKey = () => 'palimpsest-ambient-louvre';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 lWP; varying vec3 lWN;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        mat4 lm = modelMatrix;
        #ifdef USE_INSTANCING
          lm = modelMatrix * instanceMatrix;
        #endif
        lWP = (lm * vec4(transformed, 1.0)).xyz;
        lWN = normalize(mat3(lm) * objectNormal);`,
      );
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 lWP; varying vec3 lWN;').replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      if (abs(lWN.y) < 0.5) diffuseColor.rgb *= 0.72 + 0.28 * smoothstep(0.3, 0.6, fract(lWP.y / 0.16));`,
    );
  };
  return m;
}
