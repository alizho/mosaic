/** Default palette; the palette is always the user-editable color list. */
export const DEFAULT_PALETTE: readonly string[] = [
  "#0000FF",
  "#FFFFFF",
  "#FFFFFF",
  "#FFBCEE",
  "#CFFF54",
  "#000000",
];

export type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/iu.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1] ?? "0", 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function resolvePalette(colors: readonly string[]): readonly Rgb[] {
  const parsed = colors.map((color) => parseHex(color)).filter((color): color is Rgb => color !== null);
  if (parsed.length > 0) return parsed;
  return DEFAULT_PALETTE.map((color) => parseHex(color)!);
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

type Lab = readonly [number, number, number];

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function fromLinear(channel: number): number {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(Math.max(channel, 0), 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, c * 255));
}

function rgbToOklab([r8, g8, b8]: Rgb): Lab {
  const r = toLinear(r8);
  const g = toLinear(g8);
  const b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, A, B]: Lab): Rgb {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Perceptual blend: OKLab keeps hue transitions vivid instead of passing through mud. */
export function mixOklab(a: Rgb, b: Rgb, t: number): Rgb {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const la = rgbToOklab(a);
  const lb = rgbToOklab(b);
  return oklabToRgb([la[0] + (lb[0] - la[0]) * t, la[1] + (lb[1] - la[1]) * t, la[2] + (lb[2] - la[2]) * t]);
}

export function rgbToCss(color: Rgb): string {
  return `rgb(${Math.round(color[0])} ${Math.round(color[1])} ${Math.round(color[2])})`;
}

export function rgbToHex(color: Rgb): string {
  return `#${color
    .map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}
