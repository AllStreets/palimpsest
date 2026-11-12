import * as THREE from 'three';

/** A district's or a firm's quarter's name plate: what it says, where it stands, what clicking it does. */
export interface Plate {
  key: string;
  origin: { x: number; z: number };
  name: string;
  /** The quieter second line: owner and floor count, the analysis step, or a firm's agents and credits. */
  sub: string;
  onActivate?: () => void;
  /** A plate that stands at a live point (a persona's figure, people.ts) rather than beside a district's origin. */
  at?: (out: THREE.Vector3) => THREE.Vector3;
  /** Its own fade band in metres from the eye (the districts' is FADE_START to FADE_END). */
  fade?: { start: number; end: number };
  /** A class on the plate's element besides `plate`. */
  className?: string;
}

export interface Plates {
  set(plates: Plate[]): void;
  /** Repositions every plate for the current camera. Call once per frame, after the camera moves. */
  update(): void;
  dispose(): void;
}

/** Plates stand this far out from the district's centre, on the side facing the eye, at street level. */
const STAND_OFF = 26;
/** Plates fade out between these eye distances, in metres. */
const FADE_START = 1500;
const FADE_END = 2300;
/** Occlusion is tested every few frames: towers move slowly against the eye. */
const OCCLUSION_EVERY = 6;

interface Live {
  plate: Plate;
  el: HTMLButtonElement;
  name: HTMLSpanElement;
  sub: HTMLSpanElement;
  hidden: boolean;
}

/**
 * Street-level name plates: one per district, set in the index's type, a
 * hairline standing from the pavement up to the name. Each plate stands on
 * the plaza edge nearest the eye, so the tower never hides its own name, and
 * hides when another tower stands in front of it.
 */
export function createPlates(
  host: HTMLElement,
  camera: THREE.PerspectiveCamera,
  occluders: () => THREE.Object3D[],
): Plates {
  const layer = document.createElement('div');
  layer.className = 'plates';
  host.appendChild(layer);

  let live: Live[] = [];
  let frame = 0;
  const raycaster = new THREE.Raycaster();
  // The ambient blocks draw on the view's own layer (lod.ts): the plates test against every layer.
  raycaster.layers.enableAll();
  const at = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  const toward = new THREE.Vector3();
  const ray = new THREE.Vector3();

  function anchor(p: Plate, out: THREE.Vector3): THREE.Vector3 {
    if (p.at) return p.at(out);
    toward.set(camera.position.x - p.origin.x, 0, camera.position.z - p.origin.z);
    if (toward.lengthSq() < 1e-6) toward.set(1, 0, 1);
    toward.normalize();
    // A quarter turn to the right of the line of sight, so the plate stands beside the root, not in front of it.
    const side = new THREE.Vector3(toward.z, 0, -toward.x);
    return out.set(p.origin.x, 0.5, p.origin.z).addScaledVector(toward, STAND_OFF * 0.75).addScaledVector(side, STAND_OFF * 0.75);
  }

  return {
    set(plates) {
      const byKey = new Map(live.map((l) => [l.plate.key, l]));
      const next: Live[] = [];
      for (const plate of plates) {
        let l = byKey.get(plate.key);
        if (l) {
          byKey.delete(plate.key);
          l.plate = plate;
        } else {
          const el = document.createElement('button');
          el.type = 'button';
          el.className = plate.className ? `plate ${plate.className}` : 'plate';
          const name = document.createElement('span');
          name.className = 'plate-name';
          const sub = document.createElement('span');
          sub.className = 'plate-sub';
          el.append(name, sub);
          layer.appendChild(el);
          l = { plate, el, name, sub, hidden: false };
          const self = l;
          el.addEventListener('click', () => self.plate.onActivate?.());
        }
        l.name.textContent = plate.name;
        l.sub.textContent = plate.sub;
        l.el.setAttribute('aria-label', `${plate.name}, ${plate.sub}`);
        l.el.disabled = !plate.onActivate;
        next.push(l);
      }
      for (const gone of byKey.values()) gone.el.remove();
      live = next;
      frame = 0;
    },
    update() {
      const w = host.clientWidth;
      const h = host.clientHeight;
      const testOcclusion = frame++ % OCCLUSION_EVERY === 0;
      const targets = testOcclusion ? occluders() : [];
      for (const l of live) {
        anchor(l.plate, at);
        const dist = at.distanceTo(camera.position);
        ndc.copy(at).project(camera);
        const behind = ndc.z > 1 || ndc.z < -1;
        const fade = 1 - THREE.MathUtils.smoothstep(dist, l.plate.fade?.start ?? FADE_START, l.plate.fade?.end ?? FADE_END);
        if (testOcclusion && !behind) {
          raycaster.set(camera.position, ray.copy(at).sub(camera.position).normalize());
          raycaster.far = dist - 2;
          l.hidden = raycaster.intersectObjects(targets, false).length > 0;
        }
        const show = !behind && !l.hidden && fade > 0.01;
        l.el.style.opacity = show ? fade.toFixed(3) : '0';
        l.el.style.visibility = show ? 'visible' : 'hidden';
        if (!show) continue;
        const x = (ndc.x * 0.5 + 0.5) * w;
        const y = (-ndc.y * 0.5 + 0.5) * h;
        l.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      }
    },
    dispose() {
      layer.remove();
      live = [];
    },
  };
}
