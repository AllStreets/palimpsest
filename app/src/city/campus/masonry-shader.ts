/**
 * The campus masonry's shader patch (masonry.ts explains the kinds), apart
 * from the material so it can be read in Node: it rewrites a compiled
 * MeshStandardMaterial's vertex and fragment shaders to pick each kind's
 * scan, roughness, normal and emission by the `aKind` attribute. The bare
 * emitter kind (15, a school tower's lit lines and lamps) goes out where a
 * firm's power is off: `lightsOut(vOutW)` is the lights-out patch's
 * (lightsout.ts lightsOutLit), which masonryMaterial applies after this one,
 * so the term is declared before the fragment reaches it.
 */

import { campusWalks } from './site.js';

/** The louvres' boards, metres to the course (Phase 5 Task 10: 18 cm read as a flat grey at 60 m). */
export const LOUVRE_PITCH = 0.3;

/**
 * The turf at dusk. Its albedo floor (the least of its tone, so a lawn in shadow keeps a lifted green olive) and a
 * light `mottle` of the sand scan (Phase 5 Task 15a: the coarse mottle read as clouds from above); the mower's
 * `stripe`, a band lighter and a band darker two metres wide; the grass worn toward straw and earth within `wear`
 * metres of a walk's edge; and the sky's fill from above as a share of its own albedo, the sky's colour taken toward a
 * warm grey (Task 15a: the blue fill on the green read teal), under the bloom threshold by a wide margin.
 */
export const TURF = { floor: 0.98, mottle: 0.12, stripe: 0.13, wear: 1.4, skyFill: 0.22, sky: [0.74, 0.72, 0.8] as [number, number, number] } as const;

/** How far from the eye the lawn's wear along the walks is drawn (Task 15a review): past it the walks' loop is skipped. */
export const WEAR_FAR = 450;

/** The walks' gravel as GLSL (campusWalks: centre and half size in the campus's frame), for the lawn's wear. */
const WALKS_GLSL = (() => {
  const w = campusWalks();
  const v = w.map(([x0, x1, z0, z1]) => `vec4(${((x0 + x1) / 2).toFixed(2)}, ${((z0 + z1) / 2).toFixed(2)}, ${((x1 - x0) / 2 + 0.3).toFixed(2)}, ${((z1 - z0) / 2 + 0.3).toFixed(2)})`);
  return `const int CAMPUS_WALKS = ${w.length};\n      const vec4 CAMPUS_WALK[${w.length}] = vec4[${w.length}](${v.join(', ')});`;
})();

export interface MasonryShader {
  vertexShader: string;
  fragmentShader: string;
}

export function patchMasonryShader(sh: MasonryShader): void {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aKind; varying float vKind;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvKind = aKind;');
  sh.fragmentShader = sh.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      varying float vKind;
      uniform sampler2D uSandMap; uniform sampler2D uSandNor; uniform sampler2D uSandArm;
      uniform sampler2D uAshMap; uniform sampler2D uAshNor; uniform sampler2D uAshArm;
      uniform sampler2D uDial; uniform float uDialLit; uniform float uSlitLit; uniform float uPlateLit;
      int campusKind() { return int(vKind + 0.5); }
      ${WALKS_GLSL}
      // How far a point of the terrace (the campus's frame, metres) stands from the nearest walk's kerb.
      float campusWalkGap(vec2 p) {
        float d = 1e4;
        for (int i = 0; i < CAMPUS_WALKS; i++) {
          vec2 q = max(abs(p - CAMPUS_WALK[i].xy) - CAMPUS_WALK[i].zw, 0.0);
          d = min(d, length(q));
        }
        return d;
      }
      float campusHash(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
      // Smooth value noise, for the lawn's patches and drifts (the sand scan is grain only at those sizes).
      float campusNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(campusHash(i), campusHash(i + vec2(1.0, 0.0)), f.x), mix(campusHash(i + vec2(0.0, 1.0)), campusHash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      // Copper gone green: how bare the metal is at this point (0 crusted verdigris, 1 brown copper showing),
      // from long streaks down the dome where the rain runs and the standing seams every 1.25 m across, which
      // shed water and keep their metal; the UVs are metres across (x) and along (y).
      float copperBare(vec2 uv) {
        float panel = fract(uv.x / 1.25);
        float seam = 1.0 - smoothstep(0.0, 0.09, min(panel, 1.0 - panel));
        float streak = texture2D(uSandMap, vec2(uv.x * 0.31, uv.y * 0.035)).g;
        float fine = texture2D(uSandMap, uv * 0.55).g;
        return smoothstep(0.46, 0.84, streak * 0.6 + fine * 0.4 + 0.35 * seam);
      }
      vec3 copperColour(vec2 uv, float bare) {
        float panel = fract(uv.x / 1.25);
        float ridge = smoothstep(0.0, 0.02, min(panel, 1.0 - panel));
        float fine = texture2D(uSandMap, uv * 0.55).g;
        float mottle = texture2D(uSandMap, uv * 0.07).g;
        float run = texture2D(uSandMap, vec2(uv.x * 0.9, uv.y * 0.06)).g;
        // Each sheet of copper weathered its own way: a tone per panel, and a drift down each panel's length.
        float sheet = fract(sin(floor(uv.x / 1.25) * 12.9898 + floor(uv.y / 2.4) * 78.233) * 43758.5453);
        // Verdigris from a pale chalky green to a deep blue-green, the darker where the rain runs, brown where bare.
        vec3 verdigris = mix(vec3(0.09, 0.25, 0.21), vec3(0.3, 0.52, 0.42), 0.3 * fine + 0.5 * mottle + 0.2 * sheet) * (0.72 + 0.46 * run) * (0.9 + 0.2 * sheet);
        vec3 metal = mix(vec3(0.2, 0.09, 0.05), vec3(0.34, 0.17, 0.09), fine);
        return mix(verdigris, metal, bare) * (0.68 + 0.32 * ridge);
      }`,
    )
    .replace(
      '#include <map_fragment>',
      `{
        int ck = campusKind();
        vec4 s;
        if (ck == 0) s = texture2D(map, vMapUv);
        else if (ck == 1) s = texture2D(uSandMap, vMapUv);
        else if (ck == 3) {
          // Ashlar: the scan, cooled toward limestone, and its repeat broken block by block: each course (0.6 m, four
          // a tile) and each block in it (a hash of the course and the block's place, offset every other course) a
          // shade lighter or darker, a slow drift tile to tile, and a hair's shadow under each course's bed joint.
          vec3 a = texture2D(uAshMap, vMapUv).rgb;
          float lum = dot(a, vec3(0.3, 0.59, 0.11));
          a = mix(a, vec3(lum), 0.55) * vec3(0.98, 1.0, 1.03);
          float course = floor(vMapUv.y * 4.0);
          float blk = floor(vMapUv.x * 3.0 + 0.5 * mod(course, 2.0));
          float hb = fract(sin(course * 12.9898 + blk * 78.233) * 43758.5453);
          float hc = fract(sin(course * 39.425) * 24631.3);
          float ht = fract(sin(floor(vMapUv.x) * 21.17 + floor(vMapUv.y) * 51.9) * 9173.7);
          float tone = 0.9 + 0.14 * hb + 0.08 * (hc - 0.5) + 0.06 * (ht - 0.5);
          float bed = 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.035, fract(vMapUv.y * 4.0)));
          s = vec4(a * tone * bed, 1.0);
        }
        else if (ck == 5) {
          // Gravel: the sand scan is a mid-grey meant to be tinted pale; lifted, it reads as crushed limestone.
          vec3 gr = texture2D(uSandMap, vMapUv).rgb;
          s = vec4(min(vec3(1.0), gr * 1.75 + 0.08), 1.0);
        }
        else if (ck == 2) {
          // Slate: courses of slates half a metre deep and a third wide, each course offset by half a slate, their
          // edges a shade darker, and the brick scan's shading as the stone's own variation.
          float c = texture2D(map, vMapUv).g;
          float course = floor(vMapUv.y * 4.0);
          float sx = fract(vMapUv.x * 6.0 + 0.5 * mod(course, 2.0));
          float sy = fract(vMapUv.y * 4.0);
          float edge = smoothstep(0.0, 0.1, sy) * smoothstep(0.0, 0.07, sx) * (1.0 - 0.5 * smoothstep(0.9, 1.0, sy));
          float tone = 0.9 + 0.2 * fract(sin(course * 12.9898 + floor(vMapUv.x * 6.0 + 0.5 * mod(course, 2.0)) * 78.233) * 43758.5453);
          s = vec4(vec3((0.82 + 0.3 * c) * (0.7 + 0.3 * edge) * tone), 1.0);
        } else if (ck == 6) {
          s = vec4(1.0);
        } else if (ck == 7) {
          // A clock dial: the painted face (cream, a chapter ring, roman numerals), the piece's own UVs.
          s = texture2D(uDial, vMapUv);
        } else if (ck == 8) {
          // Louvres: boards of weathered oak sloping out and down, 30 cm to the course (the UVs are metres; Phase 5
          // Task 10 opened them from 18 cm so they read at 60 m), each board's face pale where it takes the sky, a deep
          // dark gap under the board above it, and a bright lip along its top edge; the scan stretched along the grain.
          float slat = fract(vMapUv.y / ${LOUVRE_PITCH.toFixed(2)});
          float board = smoothstep(0.04, 0.3, slat);
          float lip = smoothstep(0.88, 0.95, slat) * (1.0 - smoothstep(0.97, 1.0, slat));
          float grain = texture2D(uSandMap, vMapUv * vec2(0.5, 4.0)).g;
          s = vec4(vec3((0.55 + 0.45 * grain) * (0.05 + 0.5 * board + 0.35 * lip)), 1.0);
        } else if (ck == 9) {
          s = vec4(1.0);
        } else if (ck == 10) {
          // Yew: the tone is the vertex colour's, a fine dark-light break from the sand scan, no lawn mottle.
          float f = texture2D(uSandMap, vMapUv * 2.3).g;
          s = vec4(vec3(0.38 + 0.32 * f), 1.0);
        } else if (ck == 11) {
          s = vec4(copperColour(vMapUv, copperBare(vMapUv)), 1.0);
        } else if (ck == 12 || ck == 13) {
          s = vec4(1.0);
        } else if (ck == 14) {
          // The lining's paint is near black (the sun through the slit adds nothing): its tone is its lamplight.
          s = vec4(0.06);
        } else if (ck == 15) {
          // A bare emitter (a school tower's lit lines and lamps): black paint, its tone is its light.
          s = vec4(0.0, 0.0, 0.0, 1.0);
        } else {
          // Turf (Phase 5 Task 15a): a mown lawn. The scan's grain at a fine scale and only a trace at a coarse one (the
          // coarse mottle read as clouds from above); the mower's stripes, two metres a band, one lighter and one darker,
          // soft at their edges; the grass worn thin toward straw and bare earth along the walks' kerbs.
          vec2 lp = vMapUv * 9.0;
          float a = texture2D(uSandMap, vMapUv * 0.13).g;
          float f = texture2D(uSandMap, vMapUv * 3.1).g;
          float band = fract(lp.x / 4.0);
          float stripe = 1.0 + ${TURF.stripe.toFixed(2)} * (smoothstep(0.02, 0.1, band) * (1.0 - smoothstep(0.52, 0.6, band)) - 0.5);
          // The blades (Phase 5 Task 10): drawn, not scanned (a scan minified to blade size averages to flat): cells a
          // centre-metre across and five long, each row offset, each blade its own shade, lit toward its tip; faded to
          // their mean as they shrink under a pixel, so they never shimmer from far.
          vec2 m = lp;
          vec2 bq = m * vec2(80.0, 18.0);
          bq.x += 0.5 * floor(bq.y);
          float bh = campusHash(floor(bq));
          float tip = fract(bq.y);
          float blades = (0.35 + 0.65 * bh) * (0.7 + 0.3 * tip) * (1.0 - 0.55 * smoothstep(0.32, 0.5, abs(fract(bq.x) - 0.5)));
          float small = smoothstep(0.25, 0.8, length(fwidth(bq)));
          float blade = mix(0.45 + 1.0 * blades, 1.0, small);
          // Hand-sized tufts and a little clover, a metre or two across, under the stripes.
          float clump = campusNoise(m * 0.7 + 3.1) * 0.65 + campusNoise(m * 2.3 + 7.7) * 0.35;
          float tuft = 0.92 + 0.16 * smoothstep(0.2, 0.85, clump);
          // A lawn is never one green: drier ground toward straw in drifts twenty metres across, never toward blue.
          float drift = campusNoise(m * 0.05 + 1.3);
          vec3 hue = mix(vec3(0.95, 1.0, 0.96), vec3(1.12, 1.05, 0.8), drift);
          vec3 g = vec3((${TURF.floor.toFixed(2)} + ${TURF.mottle.toFixed(2)} * a + 0.1 * f) * stripe * blade * tuft) * hue;
          // Worn along the kerbs: thinner grass, straw and then earth showing, broken up by the tufts.
          // Past WEAR_FAR metres a band 1.4 m wide is under a pixel or two: the walks' loop is skipped there.
          float wearNear = 1.0 - smoothstep(${(WEAR_FAR * 0.8).toFixed(1)}, ${WEAR_FAR.toFixed(1)}, length(vViewPosition));
          float worn = wearNear > 0.0 ? wearNear * (1.0 - smoothstep(0.0, ${TURF.wear.toFixed(2)}, campusWalkGap(lp))) * (0.55 + 0.45 * clump) : 0.0;
          g = mix(g, g * vec3(1.45, 1.05, 0.62) * 0.92, worn);
          s = vec4(g, 1.0);
        }
        diffuseColor *= s;
      }`,
    )
    .replace(
      '#include <roughnessmap_fragment>',
      `float roughnessFactor = roughness;
      {
        int ck = campusKind();
        float r = 1.0;
        if (ck == 0) r = texture2D(roughnessMap, vRoughnessMapUv).g;
        else if (ck == 1) r = texture2D(uSandArm, vRoughnessMapUv).g;
        else if (ck == 3) r = texture2D(uAshArm, vRoughnessMapUv).g;
        else if (ck == 5) r = 0.9 + 0.1 * texture2D(uSandArm, vRoughnessMapUv).g;
        else if (ck == 2) r = 0.52 + 0.22 * texture2D(roughnessMap, vRoughnessMapUv).g;
        else if (ck == 6) r = 0.5;
        else if (ck == 7) r = 0.42;
        else if (ck == 8) r = 0.88;
        else if (ck == 9) r = 0.34;
        else if (ck == 10) r = 0.95;
        else if (ck == 11) r = mix(0.68, 0.38, copperBare(vRoughnessMapUv));
        else if (ck == 12) r = 0.36;
        else if (ck == 13) r = 0.28;
        else if (ck == 14) r = 0.9;
        else if (ck == 15) r = 0.6;
        else {
          // Turf: blades are waxy and catch the sky's light at a slant, so a lawn at dusk carries a sheen; the mower's
          // stripes lay the blades two ways, one band glossier toward the eye than the next, and the blades break it up.
          float bl = texture2D(uSandMap, vRoughnessMapUv * vec2(9.0, 31.0)).g;
          float lay = step(0.5, fract(vRoughnessMapUv.x * 2.25));
          r = mix(0.66, 0.78, lay) + 0.22 * (bl - 0.5);
        }
        roughnessFactor *= r;
      }`,
    )
    // The copper and the brass are metals where the metal shows: the crust of verdigris is not.
    .replace(
      '#include <metalnessmap_fragment>',
      `float metalnessFactor = metalness;
      {
        int ck = campusKind();
        if (ck == 11) metalnessFactor = mix(0.08, 0.7, copperBare(vRoughnessMapUv));
        else if (ck == 13) metalnessFactor = 0.75;
      }`,
    )
    .replace(
      '#include <normal_fragment_maps>',
      `#ifdef USE_NORMALMAP_TANGENTSPACE
      {
        int ck = campusKind();
        vec3 mapN;
        float k = 1.0;
        if (ck == 0) mapN = texture2D(normalMap, vNormalMapUv).xyz;
        else if (ck == 1) { mapN = texture2D(uSandNor, vNormalMapUv).xyz; k = 0.8; }
        else if (ck == 3) { mapN = texture2D(uAshNor, vNormalMapUv).xyz; k = 1.1; }
        else if (ck == 5) { mapN = texture2D(uSandNor, vNormalMapUv).xyz; k = 0.25; }
        else if (ck == 2) { mapN = texture2D(normalMap, vNormalMapUv).xyz; k = 0.35; }
        else if (ck == 8) {
          // A louvre board's face slopes out and down, so it looks a little up at the sky; the gap under the board
          // above looks down at the ground. The slats' light comes from the sky, as a belfry's does at dusk.
          float slat = fract(vNormalMapUv.y / ${LOUVRE_PITCH.toFixed(2)});
          mapN = slat < 0.22 ? vec3(0.5, 0.2, 0.9) : vec3(0.5, 0.78, 0.92);
        }
        else if (ck == 6 || ck == 7 || ck == 9 || ck == 12 || ck == 13 || ck == 14 || ck == 15) { mapN = vec3(0.5, 0.5, 1.0); }
        else if (ck == 11) { mapN = texture2D(uSandNor, vNormalMapUv * 0.55).xyz; k = 0.22; }
        else { mapN = texture2D(uSandNor, vNormalMapUv * 2.9).xyz; k = 0.3; }
        mapN = mapN * 2.0 - 1.0;
        mapN.xy *= normalScale * k;
        normal = normalize( tbn * mapN );
      }
      #endif`,
    )
    // The lamp heads emit their own tone: warm, at a level the street lamps' lenses share, so bloom catches them at dusk.
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      // A lamp head is an opal glass globe (site.ts lamp): the bulb's light is strongest through the glass that faces
      // the eye and softens toward the globe's rim, where the light crosses more glass and leaves it at a slant, so
      // the globe reads round and the bloom gathers round it as a soft round glow.
      if (campusKind() == 6) {
        float facing = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        float core = facing * facing;
        totalEmissiveRadiance += vColor.rgb * (0.3 + 0.5 * core + 0.6 * core * core * core);
      }
      // The turf takes the dusk sky's fill from above (TURF): its own albedo times the sky's cool light, so a lawn in the
      // low sun's shadow keeps its tone, its drifts and its blades instead of going to black; the face turned up takes
      // all of it.
      if (campusKind() == 4) {
        float up = dot(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));
        totalEmissiveRadiance += diffuseColor.rgb * vec3(${TURF.sky.map((v) => v.toFixed(2)).join(', ')}) * ${TURF.skyFill.toFixed(2)} * clamp(0.5 + 0.5 * up, 0.0, 1.0);
      }
      // The belfry after sunset (ruling 18 (a), Phase 5 Task 10): a lamp hung in the bell chamber shows warm in the gaps
      // between the louvre boards, so the tower's top stage reads as a lit lantern over the roofs from home, at its
      // real height; under the bloom threshold, on the dials' own switch.
      if (campusKind() == 8) {
        float gap = 1.0 - smoothstep(0.04, 0.24, fract(vMapUv.y / ${LOUVRE_PITCH.toFixed(2)}));
        totalEmissiveRadiance += vec3(1.0, 0.62, 0.3) * 0.75 * gap * uDialLit;
      }
      // The dials after sunset: opal glass lit from behind, warm, at the exchange's level, under the bloom threshold.
      if (campusKind() == 7) totalEmissiveRadiance += texture2D(uDial, vMapUv).rgb * vec3(1.0, 0.86, 0.62) * (0.62 * uDialLit);
      // The observatory: the lamplit lining inside the dome while the slit is open, and the brass plate by the door
      // (with its lantern's lens) while the master is trusted, both real emitters under the bloom threshold.
      if (campusKind() == 14) {
        // Lamplit from below: brightest toward the dome's foot, falling off toward the apex; the lining's UVs are
        // metres round the dome and down from its apex. Its own paint is near black, so the sun through the slit
        // adds nothing: what shows is the lamplight.
        float down = clamp(vMapUv.y / 12.0, 0.0, 1.0);
        // A lime plaster, trowelled: broad clouds of a shade lighter or darker and a fine sand in it, so the lamplight
        // shows a surface and not a flat colour.
        float cloud = texture2D(uSandMap, vMapUv * 0.11).g;
        float sand = texture2D(uSandMap, vMapUv * 0.9).g;
        float plaster = 0.7 + 0.42 * cloud * cloud + 0.16 * sand;
        // The tone is the plaster under the lamplight in linear light (site.ts TONE.glow, a warm grey that the amber
        // warms without turning orange); the ribs carry a fraction of it and read dark against the lining.
        totalEmissiveRadiance += vColor.rgb * (0.15 + 0.85 * down * down) * plaster * uSlitLit;
      }
      if (campusKind() == 13) totalEmissiveRadiance += vColor.rgb * (0.9 * uPlateLit);
      // A school tower's lit lines and lamps: the tone is the tower's own emitter colour at its own level.
      // Where a firm's power is off (lightsout.ts, which supplies lightsOut and vOutW) the emitter is out with it.
      if (campusKind() == 15) totalEmissiveRadiance += vColor.rgb * (1.0 - lightsOut(vOutW));`,
    );
}
