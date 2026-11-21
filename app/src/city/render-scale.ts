/**
 * The city's render ratio: each tier's own (1.75 on retina at high, which keeps
 * 60 fps at full window size on the M5 Pro; 1 at medium), times a render scale
 * the screens may lower while the city stands far behind them (terminal mode,
 * screens redesign Task 12). The scale is clamped to a quarter through one.
 * Its own file, so node can test it.
 */
export function renderRatio(quality: 'high' | 'medium', dpr: number, scale: number): number {
  const base = Math.min(dpr, quality === 'high' ? 1.75 : 1);
  return base * Math.max(0.25, Math.min(1, scale));
}
