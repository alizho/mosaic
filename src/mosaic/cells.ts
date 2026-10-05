/**
 * Cell substrates: static per-cell attributes (seeded) and their evaluation at
 * a loop progress. Every motion is periodic in progress, so progress 0 and 1
 * produce identical frames. Geometry never rotates; gradient cells "breathe"
 * by easing their stop colors through a seeded tour of palette hues.
 */

import type { DitherPatternId, FillParams, GradientKind, MosaicParams } from "./params";
import { mixOklab, type Rgb } from "./palettes";
import { createRng, hashInts, pickWeighted } from "./rng";
import type { Rect } from "./tessellate";

export type FillMode = "solid" | "gradient" | "dither";

export type CellStyle = Readonly<{
  angle: number;
  centerX: number;
  centerY: number;
  colorA: number;
  colorB: number;
  fill: FillMode;
  gradientKind: GradientKind;
  /** Seeded palette indices each stop tours through (cyclic, after the base color). */
  huesA: readonly number[];
  huesB: readonly number[];
  phase: number;
}>;

const MAX_HUE_STEPS = 6;

export type CellFrame = Readonly<{
  /** First color (gradient start / dither "off" color). */
  a: Rgb;
  /** Second color (gradient end / dither "on" color). */
  b: Rgb;
  fill: FillMode;
  /** Scene-space gradient geometry shared by gradient and dither fills. */
  gradient:
    | Readonly<{ kind: "linear"; x0: number; x1: number; y0: number; y1: number }>
    | Readonly<{ cx: number; cy: number; kind: "radial"; radius: number }>;
  /** Gradient mid-stop position: where the A/B blend reaches 50%. */
  mid: number;
  pattern: DitherPatternId;
  /** Dither scroll in pattern cycles (ditherScroll × progress); whole cycles loop seamlessly. */
  scroll: number;
  rect: Rect;
}>;

const TAU = Math.PI * 2;

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function createCellStyles(
  cells: readonly Rect[],
  seed: number,
  fill: FillParams,
  palette: readonly Rgb[],
): CellStyle[] {
  const paletteSize = palette.length;
  const lightest = palette.reduce((best, color, index) => (luminance(color) > luminance(palette[best]!) ? index : best), 0);
  return cells.map((_, index) => {
    const pick = createRng(hashInts(seed, index, 0xf111));
    const color = createRng(hashInts(seed, index, 0xc010));
    const shape = createRng(hashInts(seed, index, 0x5a9e));

    const mode =
      pickWeighted<FillMode>(pick, [
        ["solid", fill.solidWeight],
        ["gradient", fill.gradientWeight],
        ["dither", fill.ditherWeight],
      ]) ?? "solid";
    const colorA = Math.floor(color() * paletteSize);
    // Many cells fade toward the lightest color, echoing washed color-field prints.
    const fadeToLight = color() < 0.45 && colorA !== lightest;
    const colorB = fadeToLight
      ? lightest
      : paletteSize > 1
        ? (colorA + 1 + Math.floor(color() * (paletteSize - 1))) % paletteSize
        : colorA;
    const radialRoll = shape();
    const hue = createRng(hashInts(seed, index, 0x4e7b));
    const tour = (base: number) =>
      Array.from({ length: MAX_HUE_STEPS }, () =>
        paletteSize > 1 ? (base + 1 + Math.floor(hue() * (paletteSize - 1))) % paletteSize : base,
      );

    return {
      angle: shape() * TAU,
      centerX: 0.2 + shape() * 0.6,
      centerY: 0.2 + shape() * 0.6,
      colorA,
      colorB,
      fill: mode,
      gradientKind:
        fill.gradientType === "mixed"
          ? radialRoll < 0.35
            ? "radial"
            : "linear"
          : fill.gradientType,
      huesA: tour(colorA),
      huesB: tour(colorB),
      phase: shape(),
    };
  });
}

/**
 * Color at a loop position: a cyclic tour base → hue₁ → … → hueₖ → base with
 * cosine easing between neighbors (continuous, no holds or snaps), blended in
 * OKLab and scaled by the breath amount.
 */
function breathe(palette: readonly Rgb[], base: number, hues: readonly number[], steps: number, amount: number, position: number): Rgb {
  const origin = palette[base] ?? palette[0]!;
  if (amount <= 0) return origin;
  const stops = [base, ...hues.slice(0, Math.max(1, Math.min(steps, hues.length)))];
  const scaled = (((position % 1) + 1) % 1) * stops.length;
  const index = Math.floor(scaled);
  const eased = 0.5 - 0.5 * Math.cos(Math.PI * (scaled - index));
  const from = palette[stops[index]!] ?? origin;
  const to = palette[stops[(index + 1) % stops.length]!] ?? origin;
  return mixOklab(origin, mixOklab(from, to, eased), amount);
}

export function evaluateCell(
  rect: Rect,
  style: CellStyle,
  params: MosaicParams,
  progress: number,
): CellFrame {
  const { motion, palette } = params;
  const wave = TAU * (progress + style.phase);
  const breathing = style.fill === "gradient" ? motion.colorBreath : 0;
  const a = breathe(palette, style.colorA, style.huesA, motion.hueSteps, breathing, progress + style.phase);
  const b = breathe(palette, style.colorB, style.huesB, motion.hueSteps, breathing, progress + style.phase + 0.37);
  const mid = 0.5 + motion.drift * 0.38 * Math.sin(wave);
  const scroll = motion.ditherScroll * progress;

  let gradient: CellFrame["gradient"];
  if (style.gradientKind === "radial") {
    const cx = rect.x + rect.width * (style.centerX + motion.drift * 0.15 * Math.cos(wave));
    const cy = rect.y + rect.height * (style.centerY + motion.drift * 0.15 * Math.sin(wave));
    const radius = Math.max(
      Math.hypot(cx - rect.x, cy - rect.y),
      Math.hypot(rect.x + rect.width - cx, cy - rect.y),
      Math.hypot(cx - rect.x, rect.y + rect.height - cy),
      Math.hypot(rect.x + rect.width - cx, rect.y + rect.height - cy),
      1e-3,
    );
    gradient = { cx, cy, kind: "radial", radius };
  } else {
    const dx = Math.cos(style.angle);
    const dy = Math.sin(style.angle);
    const half = (Math.abs(rect.width * dx) + Math.abs(rect.height * dy)) / 2;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    gradient = { kind: "linear", x0: cx - dx * half, x1: cx + dx * half, y0: cy - dy * half, y1: cy + dy * half };
  }

  return { a, b, fill: style.fill, gradient, mid, pattern: params.fill.ditherPattern, rect, scroll };
}

/** Gradient parameter t ∈ [0, 1] at a scene point. */
export function gradientParam(gradient: CellFrame["gradient"], x: number, y: number): number {
  if (gradient.kind === "radial") {
    return Math.min(1, Math.hypot(x - gradient.cx, y - gradient.cy) / gradient.radius);
  }
  const vx = gradient.x1 - gradient.x0;
  const vy = gradient.y1 - gradient.y0;
  const lengthSq = vx * vx + vy * vy || 1;
  return Math.min(1, Math.max(0, ((x - gradient.x0) * vx + (y - gradient.y0) * vy) / lengthSq));
}

/** Piecewise-linear warp so the A/B midpoint lands on `mid`. */
export function warpParam(t: number, mid: number): number {
  return t <= mid ? (t / Math.max(mid, 1e-6)) * 0.5 : 0.5 + ((t - mid) / Math.max(1 - mid, 1e-6)) * 0.5;
}

/** Inverse of `warpParam`: the raw t at which the warped value equals `value`. */
export function unwarpParam(value: number, mid: number): number {
  return value <= 0.5 ? (value / 0.5) * mid : mid + ((value - 0.5) / 0.5) * (1 - mid);
}

/** Cells sharing a boundary with the outer frame. */
export function touchesFrame(rect: Rect, root: Rect): boolean {
  const eps = 1e-6;
  return (
    rect.x <= root.x + eps ||
    rect.y <= root.y + eps ||
    rect.x + rect.width >= root.x + root.width - eps ||
    rect.y + rect.height >= root.y + root.height - eps
  );
}

/**
 * Explode Edges: perimeter cells are suppressed when their seeded roll falls
 * under the removal fraction. Rolls are fixed per cell, so raising the amount
 * only ever removes more of the same cells.
 */
export function isCellPruned(rect: Rect, root: Rect, seed: number, index: number, edgeRemoval: number): boolean {
  if (edgeRemoval <= 0 || !touchesFrame(rect, root)) return false;
  return hashInts(seed, index, 0xed6e) / 4294967296 < edgeRemoval;
}
