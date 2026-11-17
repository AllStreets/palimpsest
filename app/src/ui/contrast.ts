/** WCAG contrast, pure: for the running head's backing over the city's brightest glass (audit 2026-11-17). */

export type Rgb = readonly [number, number, number];

/** An sRGB colour from `#rrggbb`. */
export function hex(h: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${h}`);
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance, 0 to 255 a channel. */
export function luminance([r, g, b]: Rgb): number {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** The WCAG contrast ratio of two colours, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A colour at `alpha` laid over `ground`, as the browser composites in sRGB. */
export function over(ground: Rgb, colour: Rgb, alpha: number): Rgb {
  const mix = (g: number, c: number): number => Math.round(g * (1 - alpha) + c * alpha);
  return [mix(ground[0], colour[0]), mix(ground[1], colour[1]), mix(ground[2], colour[2])];
}
