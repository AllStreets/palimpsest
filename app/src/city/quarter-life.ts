/**
 * The firms' quarters over time (Task 28): what the city draws for each
 * quarter as its firm goes bankrupt and its towers are sold. It keeps the
 * live events' clocks, turns each quarter into what shows now
 * (quarters.ts quarterShow), writes the lights-out zones (lightsout.ts),
 * and stands a re-clad scaffold round each tower a buyer is re-cladding.
 *
 * Between events nothing is recomputed: with no clock running, update()
 * returns at once. The quarters to draw change only when a re-clad reaches
 * the top of its rise (the floors rebuild behind the scaffold), so the
 * scene rebuilds a quarter once per sale and never for a bankruptcy.
 */
import * as THREE from 'three';

import type { Quarter } from '../../../shared/types.js';
import { quarterZones, setZones, type OutZone } from './lightsout.js';
import { GLARE_FRAG, GLARE_VERT, pixelScale } from './construction.js';
import { LANTERN_GLASS, quarterBuildKey, quarterShow, type QuarterShow, RECLAD } from './quarters.js';
import { makeRecladScaffold, type RecladScaffold } from './scaffold.js';

const RECLAD_TOTAL = RECLAD.rise + RECLAD.rebuild + RECLAD.strike + RECLAD.relight;

export type QuarterEvent = { kind: 'bankrupt'; firmId: string } | { kind: 'sold'; agentId: string };

export interface QuarterLife {
  /** Scaffolds standing round towers being re-clad. */
  group: THREE.Group;
  /** The engine's quarters as served; returns the quarters to draw now. */
  set(quarters: Quarter[]): Quarter[];
  /** An event seen live: its clock starts now. */
  event(e: QuarterEvent): void;
  /**
   * Advances the clocks. Returns the quarters to draw when what is drawn
   * changed (a re-clad reached the top of its rise), else null; `moved` is
   * true while a scaffold changed what it shows (the shadow map wants it).
   */
  update(dt: number): { draw: Quarter[] | null; moved: boolean };
  /** Each quarter as it shows now, by firm (tests and captures). */
  shows(): Map<string, QuarterShow>;
  dispose(): void;
}

/**
 * `towerBox(agentId)` gives a tower's box in the world as built now, for
 * sizing its scaffold.
 */
export function quarterLife(towerBox: (agentId: string) => THREE.Box3 | null): QuarterLife {
  const group = new THREE.Group();
  group.name = 'quarter-life';
  let served: Quarter[] = [];
  const bankrupt = new Map<string, number>();
  const sold = new Map<string, number>();
  const scaffolds = new Map<string, { s: RecladScaffold; at: THREE.Vector3 }>();
  let shows = new Map<string, QuarterShow>();
  let drawnKey = '';

  // The court lanterns' glare, every quarter's in one draw: a small hot core with a few pixels' floor, so from
  // across the city a firm's court still shows as a lamp, and a faint warm haze round it. Out with the court.
  const MAX_LANTERNS = 64;
  const glareGeo = new THREE.InstancedBufferGeometry();
  glareGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  glareGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const gPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LANTERNS * 2 * 3), 3);
  const gColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LANTERNS * 2 * 3), 3);
  const gSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LANTERNS * 2 * 3), 3);
  glareGeo.setAttribute('iPos', gPos);
  glareGeo.setAttribute('iColor', gColor);
  glareGeo.setAttribute('iSize', gSize);
  glareGeo.instanceCount = 0;
  const glareMat = new THREE.ShaderMaterial({
    vertexShader: GLARE_VERT,
    fragmentShader: GLARE_FRAG,
    uniforms: { uPixel: { value: 0.001 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glare = new THREE.Mesh(glareGeo, glareMat);
  glare.name = 'quarter:lantern-glare';
  glare.frustumCulled = false;
  glare.renderOrder = 3;
  glare.onBeforeRender = (renderer, _s, camera) => {
    glareMat.uniforms.uPixel.value = pixelScale(renderer, camera);
  };
  group.add(glare);
  /** Tungsten behind glass: the lantern's core, and the warm air round it, both scaled by the court's light. */
  const CORE = new THREE.Color(1.0, 0.56, 0.2).multiplyScalar(3.4);
  const HAZE = new THREE.Color(1.0, 0.56, 0.2).multiplyScalar(0.38);
  let glareKey = '';
  function placeGlare(): void {
    const lit = served.slice(0, MAX_LANTERNS).map((q) => [q.origin.x, q.origin.z, shows.get(q.firmId)?.court ?? 1] as const).filter(([, , c]) => c > 0.01);
    const key = JSON.stringify(lit);
    if (key === glareKey) return;
    glareKey = key;
    lit.forEach(([x, z, c], i) => {
      for (const [k, colour, size] of [
        [2 * i, CORE, [LANTERN_GLASS.half * 1.4, 5, 0]],
        [2 * i + 1, HAZE, [5.5, 20, 1]],
      ] as const) {
        gPos.setXYZ(k, x, LANTERN_GLASS.y, z);
        gColor.setXYZ(k, colour.r * c, colour.g * c, colour.b * c);
        gSize.setXYZ(k, size[0], size[1], size[2]);
      }
    });
    glareGeo.instanceCount = lit.length * 2;
    for (const a of [gPos, gColor, gSize]) a.needsUpdate = true;
    glare.visible = lit.length > 0;
  }

  const live = (): boolean => bankrupt.size > 0 || sold.size > 0;

  function compute(): Quarter[] {
    shows = new Map(served.map((q) => [q.firmId, quarterShow(q, { bankrupt: bankrupt.get(q.firmId), sold })]));
    const zones: OutZone[] = [];
    for (const q of served) zones.push(...quarterZones(q.origin, shows.get(q.firmId)!));
    setZones(zones);
    placeGlare();
    return served.map((q) => shows.get(q.firmId)!.quarter);
  }

  /** Stands, moves or strikes each re-clad's scaffold; true when any changed what it shows. */
  function scaffoldAll(): boolean {
    let moved = false;
    const want = new Set<string>();
    for (const q of served) {
      for (const t of shows.get(q.firmId)?.towers ?? []) {
        const id = t.spec.agentId;
        if (!id || t.scaffold <= 0) continue;
        want.add(id);
        let entry = scaffolds.get(id);
        if (!entry) {
          const box = towerBox(id);
          if (!box || box.isEmpty()) continue;
          const size = box.getSize(new THREE.Vector3());
          const centre = box.getCenter(new THREE.Vector3());
          const s = makeRecladScaffold(size.x / 2 + 0.6, size.z / 2 + 0.6, size.y);
          s.object.position.set(centre.x, box.min.y, centre.z);
          group.add(s.object);
          entry = { s, at: centre };
          scaffolds.set(id, entry);
        }
        if (entry.s.setHeight(t.scaffold * entry.s.height)) moved = true;
      }
    }
    for (const [id, e] of scaffolds) {
      if (want.has(id)) continue;
      group.remove(e.s.object);
      e.s.dispose();
      scaffolds.delete(id);
      moved = true;
    }
    return moved;
  }

  return {
    group,
    set(quarters) {
      served = quarters;
      const draw = compute();
      drawnKey = draw.map(quarterBuildKey).join('\n');
      scaffoldAll();
      return draw;
    },
    event(e) {
      if (e.kind === 'bankrupt') bankrupt.set(e.firmId, 0);
      else sold.set(e.agentId, 0);
    },
    update(dt) {
      if (!live()) return { draw: null, moved: false };
      for (const [k, t] of bankrupt) {
        // Kept a little past the fade, so a refresh that lands late still starts it where it should be.
        if (t > 30) bankrupt.delete(k);
        else bankrupt.set(k, t + dt);
      }
      for (const [k, t] of sold) {
        if (t > RECLAD_TOTAL + 30) sold.delete(k);
        else sold.set(k, t + dt);
      }
      const draw = compute();
      const key = draw.map(quarterBuildKey).join('\n');
      const changed = key !== drawnKey;
      drawnKey = key;
      const moved = scaffoldAll();
      return { draw: changed ? draw : null, moved };
    },
    shows: () => shows,
    dispose() {
      for (const e of scaffolds.values()) e.s.dispose();
      scaffolds.clear();
      setZones([]);
      glareGeo.dispose();
      glareMat.dispose();
    },
  };
}
