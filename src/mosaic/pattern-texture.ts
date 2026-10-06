/**
 * Organic scanline texture shared by the WebGL shader (GLSL port below), the
 * Canvas 2D fallback and SVG export. The texture is a property of the "paper":
 * it is keyed to the cell's unscrolled local coordinates, so loops stay
 * seamless while lines scroll through it.
 *
 * With spacing S, texture amount v, normal coordinate u and along-line
 * coordinate w (both cell-local pixels):
 *   swell   = valueNoise(w / 8S, u / S)        slow per-stroke thickness swell
 *   fade    = valueNoise(w / 5S, u / S + 0.5)  ink-density (opacity) drift
 *   ragged  = valueNoise(w / 0.7S, u / S)      fine edge wobble
 *   halfWidth = S·thickness/2 · max(0.15, 1 + 1.4v(swell − ½)) + 0.1vS(ragged − ½)
 *   opacity   = 1 − 0.6v · fade
 * The shader adds a fine speckle on top (raster only).
 */

import type { FillParams } from "./params";
import type { Rect } from "./tessellate";

/** PCG hash, bit-identical to the shader's `pcg`. */
function pcg(value: number): number {
  const state = (Math.imul(value >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

function hash(x: number, y: number, salt: number): number {
  return pcg((Math.imul(x >>> 0, 1597334677) ^ pcg((y ^ salt) >>> 0)) >>> 0) / 4294967295;
}

export function valueNoise(x: number, y: number, salt: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const top = hash(ix, iy, salt) + (hash(ix + 1, iy, salt) - hash(ix, iy, salt)) * fx;
  const bottom = hash(ix, iy + 1, salt) + (hash(ix + 1, iy + 1, salt) - hash(ix, iy + 1, salt)) * fx;
  return top + (bottom - top) * fy;
}

export const SCANLINE_TEXTURE_GLSL = `
float scanlineHalfWidth(float u, float w, float spacing, float thickness, float v) {
  float swell = valueNoise(vec2(w / (spacing * 8.0), u / spacing), 11u);
  float ragged = valueNoise(vec2(w / (spacing * 0.7), u / spacing), 37u);
  return spacing * thickness * 0.5 * max(0.15, 1.0 + v * 1.4 * (swell - 0.5)) + v * 0.1 * spacing * (ragged - 0.5);
}
float scanlineOpacity(float u, float w, float spacing, float v) {
  return 1.0 - v * 0.6 * valueNoise(vec2(w / (spacing * 5.0), u / spacing + 0.5), 23u);
}`;

function halfWidth(u: number, w: number, spacing: number, thickness: number, v: number): number {
  const swell = valueNoise(w / (spacing * 8), u / spacing, 11);
  const ragged = valueNoise(w / (spacing * 0.7), u / spacing, 37);
  return spacing * thickness * 0.5 * Math.max(0.15, 1 + v * 1.4 * (swell - 0.5)) + v * 0.1 * spacing * (ragged - 0.5);
}

function opacity(u: number, w: number, spacing: number, v: number): number {
  return 1 - v * 0.6 * valueNoise(w / (spacing * 5), u / spacing + 0.5, 23);
}

export type ScanlineStroke = Readonly<{ opacity: number; points: readonly (readonly [number, number])[] }>;

const MAX_SAMPLES = 400;

/**
 * Scanline strokes as closed polygons in scene coordinates, covering `area`
 * of a cell whose lattice origin is `origin`. Each stroke samples its varying
 * width along its length and carries its mean opacity.
 */
export function scanlineStrokes(
  origin: Rect,
  area: Rect,
  vertical: boolean,
  scroll: number,
  fill: Pick<FillParams, "scanlineSpacing" | "scanlineTexture" | "scanlineThickness">,
): ScanlineStroke[] {
  const { scanlineSpacing: spacing, scanlineTexture: v, scanlineThickness: thickness } = fill;
  const across = vertical ? area.width : area.height;
  const along = vertical ? area.height : area.width;
  const acrossStart = vertical ? area.x - origin.x : area.y - origin.y;
  const alongStart = vertical ? area.y - origin.y : area.x - origin.x;
  const shift = (((scroll % 1) + 1) % 1) * spacing;
  const samples = v > 0 ? Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(along / (spacing * 0.5)) + 1)) : 2;
  const toScene = (u: number, w: number): readonly [number, number] =>
    vertical ? [origin.x + u, origin.y + w] : [origin.x + w, origin.y + u];
  const strokes: ScanlineStroke[] = [];

  const first = Math.floor((acrossStart - shift) / spacing) - 1;
  for (let k = first; (k - 1) * spacing + shift <= acrossStart + across; k += 1) {
    const center = (k + 0.5) * spacing + shift;
    const near: (readonly [number, number])[] = [];
    const far: (readonly [number, number])[] = [];
    let opacitySum = 0;
    for (let i = 0; i < samples; i += 1) {
      const w = alongStart + (along * i) / (samples - 1);
      const h = Math.max(0, halfWidth(center, w, spacing, thickness, v));
      opacitySum += opacity(center, w, spacing, v);
      near.push(toScene(center - h, w));
      far.push(toScene(center + h, w));
    }
    strokes.push({ opacity: opacitySum / samples, points: [...near, ...far.reverse()] });
  }
  return strokes;
}

/** Monospace grid pitch for ASCII cells: advance 0.6 em, rows 1 em. */
export function asciiPitch(size: number): readonly [number, number] {
  return [size * 0.6, size];
}

export const ASCII_FONT_STACK = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';
