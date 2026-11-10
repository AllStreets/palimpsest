/**
 * The silhouette board for captures and the UI test (Task 23): until Task 24
 * stands each firm's quarter in the city, one agent tower of each silhouette
 * from the sample economy is stood in a row off the city's western edge,
 * where the dusk sky is behind it. The economy's agents hold 3 to 14 floors;
 * each is grown to twenty by laying its own floors again in order (as the
 * agent would after a few more weeks of the same work), so a needle reaches
 * its taper and a lens its fourth ring.
 */
import type { District, Quarter, Silhouette, TowerSpec } from '../shared/types.js';

export const BOARD_FLOORS = 20;
export const BOARD_ORDER: Silhouette[] = ['lens', 'cantilever', 'needle', 'plain'];
/** Metres between the towers in the row. */
const SPACING = 46;

/** The longest standing tower of each silhouette, grown to `floors` earned floors. */
export function boardTowers(quarters: Quarter[], floors = BOARD_FLOORS): TowerSpec[] {
  const all = quarters.filter((q) => !q.dark).flatMap((q) => q.towers.filter((t) => !t.dark && t.floors.length > 0));
  const out: TowerSpec[] = [];
  for (const s of BOARD_ORDER) {
    const t = all.filter((x) => (x.silhouette ?? 'plain') === s).sort((a, b) => b.floors.length - a.floors.length)[0];
    if (!t) continue;
    const grown = Array.from({ length: floors }, (_, i) => {
      const f = t.floors[i % t.floors.length];
      const round = Math.floor(i / t.floors.length);
      // A scar stays a scar only where it was laid; the floors laid again are merged work.
      const earned = f.earned && round > 0 ? { ...f.earned, state: 'lit' as const } : f.earned;
      return round === 0 ? f : { ...f, id: `${f.id}~${round}`, earned };
    });
    out.push({ ...t, floors: grown });
  }
  return out;
}

export interface BoardFrame {
  spots: Array<{ x: number; z: number }>;
  /** The row's centre on the ground. */
  centre: { x: number; z: number };
}

/**
 * A row running east to west, far enough north of every district that
 * nothing of the city stands behind it seen from the south. A cantilever
 * steps out east and west, so from the south its steps are in the outline,
 * and the low western sun rakes across every tower.
 */
export function boardFrame(city: District[], count: number): BoardFrame {
  const minZ = Math.min(...city.map((d) => d.origin.z));
  const cx = city.reduce((a, d) => a + d.origin.x, 0) / Math.max(1, city.length);
  const centre = { x: cx, z: minZ - 320 };
  const spots = Array.from({ length: count }, (_, i) => ({ x: centre.x + (i - (count - 1) / 2) * SPACING, z: centre.z }));
  return { spots, centre };
}

type V3 = [number, number, number];

/**
 * The board's views: the row against the dusk sky from the south, the row
 * from the city's home bearing, and close crops of the lens crown, the
 * cantilever brackets and the needle's spire.
 */
export function boardViews(frame: BoardFrame, towers: TowerSpec[], tops: number[]): Array<[string, V3, V3]> {
  const { centre, spots } = frame;
  const tallest = Math.max(...tops);
  const views: Array<[string, V3, V3]> = [
    ['silhouettes', [centre.x + 40, 26, centre.z + 240], [centre.x, tallest * 0.56, centre.z]],
    ['silhouettes-home', [centre.x + 0.63 * 300, 70, centre.z + 0.78 * 300], [centre.x, tallest * 0.5, centre.z]],
  ];
  towers.forEach((t, i) => {
    const { x, z } = spots[i];
    const top = tops[i];
    if (t.silhouette === 'lens') {
      // From the city's side the lens's upper face holds the sunset behind it; from the sun's side, the evening sky.
      views.push(['silhouettes-crown', [x + 15, top + 8, z + 12], [x, top + 3, z]]);
      views.push(['silhouettes-crown-west', [x - 16, top + 7, z + 9], [x, top + 3, z]]);
    }
    if (t.silhouette === 'cantilever') {
      // Under the third and fourth floors' brackets, from the south-east and a little below them.
      const y = top * 0.5;
      views.push(['silhouettes-brackets', [x + 24, y - 12, z + 30], [x + 4, y + 2, z]]);
    }
    if (t.silhouette === 'needle') views.push(['silhouettes-spire', [x + 34, top - 4, z + 30], [x, top + 8, z]]);
  });
  return views;
}
