import * as THREE from 'three';

/**
 * Physically based materials from Poly Haven scans (CC0, see CREDITS.md),
 * shared by the ground, the district plinths and the towers. Textures load
 * on first use, so a material nobody touches costs nothing.
 */

const loader = new THREE.TextureLoader();
const cache = new Map<string, THREE.Texture>();
let maxAniso = 8;
let pending = 0;
let waiters: Array<() => void> = [];

function settle(): void {
  pending -= 1;
  if (pending === 0) {
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  }
}

/** Sets the anisotropy used by every texture loaded from now on. Call once with the renderer. */
export function configureMaterials(renderer: THREE.WebGLRenderer): void {
  maxAniso = renderer.capabilities.getMaxAnisotropy();
}

/** Resolves once every texture requested so far has loaded (or failed). */
export function texturesSettled(): Promise<void> {
  if (pending === 0) return Promise.resolve();
  return new Promise((resolve) => waiters.push(resolve));
}

/** A repeating texture from app/public/textures, cached by name. Colour maps are sRGB, data maps linear. */
export function texture(name: string, srgb = false): THREE.Texture {
  const key = `${name}:${srgb}`;
  const hit = cache.get(key);
  if (hit) return hit;
  pending += 1;
  const t = loader.load(`${import.meta.env.BASE_URL}textures/${name}`, settle, undefined, () => {
    console.warn(`texture ${name} failed to load`);
    settle();
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

/** A scanned material: `<prefix>_diff` colour, `_nor` normal, `_arm` (AO, roughness, metalness packed). */
function pbr(prefix: string, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const arm = texture(`${prefix}_arm.jpg`);
  return new THREE.MeshStandardMaterial({
    map: texture(`${prefix}_diff.jpg`, true),
    normalMap: texture(`${prefix}_nor.jpg`),
    aoMap: arm,
    roughnessMap: arm,
    metalnessMap: arm,
    roughness: 1,
    metalness: 0,
    ...extra,
  });
}

export interface MaterialLibrary {
  /** Sandstone blocks: Beaux-Arts and classical stone. */
  sand: THREE.MeshStandardMaterial;
  /** Red brick. */
  brick: THREE.MeshStandardMaterial;
  /** Precast stone paving: plazas and pavements. */
  pave: THREE.MeshStandardMaterial;
  /** Brushed steel plate. */
  brushed: THREE.MeshStandardMaterial;
  /** Rusty red primer: steel frames and scars. */
  primer: THREE.MeshStandardMaterial;
  bronze: THREE.MeshStandardMaterial;
  darkMetal: THREE.MeshStandardMaterial;
  titanium: THREE.MeshPhysicalMaterial;
  concrete: THREE.MeshStandardMaterial;
  /** Curtain-wall glass over a lit interior. */
  glass: THREE.MeshPhysicalMaterial;
  /** Opaque dark window glass. */
  winGlass: THREE.MeshPhysicalMaterial;
}

const FACTORIES: { [K in keyof MaterialLibrary]: () => MaterialLibrary[K] } = {
  sand: () => pbr('sand', { color: 0xf3e9da }),
  brick: () => pbr('brick', { color: 0xd8c4b8 }),
  pave: () => pbr('pave', { color: 0x8a8580, roughness: 0.55, normalScale: new THREE.Vector2(0.8, 0.8) }),
  brushed: () => pbr('metal', { color: 0xd5d8dc, metalness: 1, roughness: 0.55 }),
  primer: () => pbr('rust', { color: 0xb8553a, metalness: 0.35 }),
  bronze: () => new THREE.MeshStandardMaterial({ color: 0x3a2f26, metalness: 1, roughness: 0.38 }),
  darkMetal: () => new THREE.MeshStandardMaterial({ color: 0x1e2125, metalness: 1, roughness: 0.42 }),
  titanium: () => new THREE.MeshPhysicalMaterial({ color: 0xc9ccd1, metalness: 1, roughness: 0.22, clearcoat: 0.3 }),
  concrete: () => new THREE.MeshStandardMaterial({ color: 0x8e8b86, roughness: 0.9 }),
  glass: () =>
    new THREE.MeshPhysicalMaterial({
      color: 0x0c1418,
      metalness: 0.15,
      roughness: 0.035,
      transparent: true,
      opacity: 0.42,
      envMapIntensity: 2.2,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      ior: 1.5,
      specularIntensity: 1,
    }),
  winGlass: () =>
    new THREE.MeshPhysicalMaterial({ color: 0x111619, metalness: 0.2, roughness: 0.05, envMapIntensity: 1.8, clearcoat: 1 }),
};

let library: MaterialLibrary | null = null;

/** The shared material library. Each material (and its textures) is built on first access. */
export function materials(): MaterialLibrary {
  if (library) return library;
  const lib = {} as MaterialLibrary;
  for (const key of Object.keys(FACTORIES) as Array<keyof MaterialLibrary>) {
    let made: THREE.Material | null = null;
    Object.defineProperty(lib, key, {
      enumerable: true,
      get: () => (made ??= FACTORIES[key]()),
    });
  }
  library = lib;
  return lib;
}

/**
 * A box whose UVs are scaled to world size, so a tiled scan keeps its real
 * scale on any box (`scale` is metres per texture tile). Casts and receives shadows.
 */
export function worldBox(w: number, h: number, d: number, mat: THREE.Material, scale = 3): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const dims = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * dims[f][0]) / scale, (uv.getY(i) * dims[f][1]) / scale);
    }
  }
  const m = new THREE.Mesh(g, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}
