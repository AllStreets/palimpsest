/** Side length, in world units, of one city block on the district grid. */
export const DISTRICT_PITCH = 240;

/**
 * The n-th block coordinate (n >= 1) on a square spiral centred on (0,0),
 * walking right, up, left, down with a side length that grows by one every
 * second turn. n = 1 is the block immediately to the right of the centre.
 */
function spiralBlock(n: number): { bx: number; bz: number } {
  let bx = 0;
  let bz = 0;
  let dx = 1;
  let dz = 0;
  let segmentLength = 1;
  let segmentPassed = 0;
  let turns = 0;

  for (let i = 1; i <= n; i++) {
    bx += dx;
    bz += dz;
    segmentPassed += 1;

    if (segmentPassed === segmentLength) {
      segmentPassed = 0;
      // Turn clockwise: (dx, dz) -> (-dz, dx).
      [dx, dz] = [-dz, dx];
      turns += 1;
      if (turns % 2 === 0) {
        segmentLength += 1;
      }
    }
  }

  return { bx, bz };
}

/**
 * The i-th district's origin (i = 0, 1, 2, ...), walking a square spiral over
 * block coordinates and skipping (0,0), which is reserved for the civic
 * plaza: district 0 is the spiral's first block, not the centre.
 */
export function districtOrigin(i: number): { x: number; z: number } {
  const { bx, bz } = spiralBlock(i + 1);
  return { x: bx * DISTRICT_PITCH, z: bz * DISTRICT_PITCH };
}

/**
 * Where each of a firm's agent towers stands in its quarter, from the
 * quarter's origin, by the agent's tower index (Task 4): four plots on the
 * corners of a square, far enough apart that the quarter reads as a cluster
 * of four practices round a shared court, never as four districts.
 */
export const QUARTER_OFFSETS: Array<{ x: number; z: number }> = [
  { x: -52, z: -52 },
  { x: 52, z: -52 },
  { x: -52, z: 52 },
  { x: 52, z: 52 },
];

/** Half the side of a quarter's square paved court, from its origin to the court's edge. */
export const QUARTER_COURT = 74;
