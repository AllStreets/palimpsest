import * as THREE from 'three';

/**
 * Physically based materials from Poly Haven scans (CC0, see CREDITS.md),
 * shared by the ground, the district plinths and the towers. Textures load
 * on first use, so a material nobody touches costs nothing; only the first
 * sets (FIRST_SETS) are asked for ahead of use, as the city opens.
 */

/**
 * The scanned sets in app/public/textures, in the order the home view needs
 * them: the stone (the roots and the stone floors, the ambient city's
 * commercial fronts, the kerbs), then the brick (the walk-ups and the brick
 * floors, the dark ironspot floors), then the paving under it all, and last
 * the metals (brushed steel and the primer, near or on the job sites). Each
 * set is `<set>_diff.jpg`, `_nor.jpg` and `_arm.jpg`.
 */
export const TEXTURE_SETS = ['sand', 'ashlar', 'granite', 'brick', 'ironspot', 'pave', 'metal', 'rust'] as const;
export type TextureSet = (typeof TEXTURE_SETS)[number];

/**
 * The sets the city is drawn on: the stone, brick and glass (the glass is
 * drawn in code, from no scan). The city reports ready once these are in
 * (`firstTexturesIn`); the rest land behind the first frame.
 */
export const FIRST_SETS: readonly TextureSet[] = ['sand', 'ashlar', 'granite', 'brick', 'ironspot'];

/** The three maps of a set, colour first. */
export const MAPS = ['diff', 'nor', 'arm'] as const;

/** The rank a texture file loads by: its set's place in TEXTURE_SETS, then its map's place in MAPS (a file of no set last). */
export function textureRank(name: string): number {
  const m = /^([a-z]+)_([a-z]+)\./.exec(name);
  const set = m ? TEXTURE_SETS.indexOf(m[1] as TextureSet) : -1;
  const map = m ? MAPS.indexOf(m[2] as (typeof MAPS)[number]) : -1;
  return set < 0 || map < 0 ? TEXTURE_SETS.length * MAPS.length : set * MAPS.length + map;
}

/**
 * Decoded off the main thread (an ImageBitmap), so the first frame uploads a
 * decoded image rather than decoding each file in line. Flipped and left
 * unconverted at decode, as an image element is at upload (flipY, and three's
 * UNPACK_COLORSPACE_CONVERSION of NONE): the same texels either way.
 */
let loader: THREE.ImageBitmapLoader | null = null;
function bitmaps(): THREE.ImageBitmapLoader {
  loader ??= new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  return loader;
}
const cache = new Map<string, THREE.Texture>();
const loaded = new Map<string, Promise<void>>();
let maxAniso = 8;
let pending = 0;
let waiters: Array<() => void> = [];
const queue: Array<{ name: string; rank: number; start: () => void }> = [];
let flushing = false;

function settle(): void {
  pending -= 1;
  if (pending === 0) {
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  }
}

/**
 * Starts every load asked for in this task, lowest rank first. None waits on
 * another's arrival: a load's own callback runs on the main thread, which the
 * city's first build holds for a second or more, so a load that waited for
 * one to land would not start until the build was done.
 */
function pump(): void {
  if (flushing) return;
  flushing = true;
  queueMicrotask(() => {
    flushing = false;
    const now = queue.splice(0).sort((a, b) => a.rank - b.rank);
    for (const q of now) q.start();
  });
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

/**
 * Asks for the first sets (FIRST_SETS) ahead of anything else and resolves
 * once all of them have loaded (or failed): the city is drawn from then on,
 * while the paving and the metals land behind it.
 */
export function firstTexturesIn(): Promise<void> {
  const names = FIRST_SETS.flatMap((set) => MAPS.map((map) => [`${set}_${map}.jpg`, map === 'diff'] as const));
  for (const [name, srgb] of names) texture(name, srgb);
  return Promise.all(names.map(([name, srgb]) => loaded.get(`${name}:${srgb}`) ?? Promise.resolve())).then(() => undefined);
}

/**
 * A repeating texture from app/public/textures, cached by name. Colour maps
 * are sRGB, data maps linear. It is handed back at once and filled when its
 * file lands; the files asked for together load in TEXTURE_SETS order.
 */
export function texture(name: string, srgb = false): THREE.Texture {
  const key = `${name}:${srgb}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const t = new THREE.Texture();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  // In Node (the grid's tests) there is no image to load into: the blank texture stands in.
  if (typeof document === 'undefined') return t;
  pending += 1;
  const url = `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'}textures/${name}`;
  loaded.set(
    key,
    new Promise<void>((done) => {
      const finish = (): void => {
        settle();
        done();
      };
      queue.push({
        name,
        rank: textureRank(name),
        start: () =>
          bitmaps().load(
            url,
            (image) => {
              t.image = image;
              t.flipY = false;
              t.needsUpdate = true;
              finish();
            },
            undefined,
            () => {
              console.warn(`texture ${name} failed to load`);
              finish();
            },
          ),
      });
      pump();
    }),
  );
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
