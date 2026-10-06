/**
 * Rectilinear partitioning of one root rectangle. Children always share exact
 * split coordinates and the leaves cover the root with zero gaps and no
 * overlap, so edges stay flush with the artboard by construction rather than
 * by clipping.
 *
 * Free mode is recursive guillotine (binary space) slicing with independent
 * width and height limits. Every cut keeps both parts *feasible* — a length L
 * is feasible on an axis with limits [lo, hi] when some whole number of
 * pieces fits it (n·lo ≤ L ≤ n·hi) — so the limits hold for every leaf
 * whenever the root itself can satisfy them.
 *
 * Square mode packs a near-square module grid with k×k squares.
 */

import type { LayoutParams } from "./params";
import { createRng, hashInts, type Rng } from "./rng";

export type Rect = Readonly<{ height: number; width: number; x: number; y: number }>;

const MAX_DEPTH = 28;
const MAX_CELLS = 6000;
const EPS = 1e-6;

type Axis = "vertical" | "horizontal";
type Interval = readonly [number, number];

type AxisLimits = Readonly<{ hi: number; lo: number }>;

type SplitContext = Readonly<{
  cells: Rect[];
  height: AxisLimits;
  layout: LayoutParams;
  origin: Readonly<{ x: number; y: number }>;
  rng: Rng;
  width: AxisLimits;
}>;

/** Max whole pieces enumerated before the feasible set is treated as gap-free. */
const MAX_PIECES = 256;

/** Lengths that split into whole pieces within [lo, hi], as sorted disjoint intervals up to `limit`. */
function feasibleLengths({ hi, lo }: AxisLimits, limit: number): Interval[] {
  const intervals: Interval[] = [];
  for (let n = 1; n <= MAX_PIECES && n * lo <= limit + EPS; n += 1) {
    const start = n * lo;
    // Once consecutive piece counts overlap, every longer length is feasible.
    if ((n + 1) * lo <= n * hi + EPS || n === MAX_PIECES) {
      intervals.push([start, Infinity]);
      break;
    }
    intervals.push([start, n * hi]);
  }
  return intervals;
}

export function isFeasibleLength(length: number, limits: AxisLimits): boolean {
  return feasibleLengths(limits, length).some(([start, end]) => length >= start - EPS && length <= end + EPS);
}

/**
 * Valid first-part lengths `a` for cutting `length`: both `a` and `length - a`
 * feasible. When `length` itself is infeasible (the limits cannot all hold),
 * only the minimum is enforced.
 */
function validCuts(length: number, limits: AxisLimits): Interval[] {
  const lower = limits.lo;
  const upper = length - limits.lo;
  if (lower > upper + EPS) return [];
  if (!isFeasibleLength(length, limits)) return [[lower, upper]];
  const first = feasibleLengths(limits, length);
  // a ∈ length − F  ⇔  length − a ∈ F
  const second = first.map(([start, end]) => [length - end, length - start] as Interval).reverse();
  const result: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < first.length && j < second.length) {
    const start = Math.max(first[i]![0], second[j]![0], lower);
    const end = Math.min(first[i]![1], second[j]![1], upper);
    if (start <= end + EPS) result.push([start, Math.max(start, end)]);
    if (first[i]![1] < second[j]![1]) i += 1;
    else j += 1;
  }
  return result;
}

function inIntervals(value: number, intervals: readonly Interval[]): boolean {
  return intervals.some(([start, end]) => value >= start - EPS && value <= end + EPS);
}

/** Cut position nearest the requested fraction that keeps both parts valid (and snapped, if set). */
function resolveSplitPosition(
  start: number,
  length: number,
  fraction: number,
  limits: AxisLimits,
  snap: number,
  gridOrigin: number,
): number | null {
  const cuts = validCuts(length, limits);
  if (cuts.length === 0) return null;
  const raw = fraction * length;

  if (snap > 0) {
    const base = Math.round((start + raw - gridOrigin) / snap);
    const reach = Math.ceil(length / snap) + 1;
    for (let step = 0; step <= reach; step += 1) {
      for (const offset of step === 0 ? [0] : [-step, step]) {
        const position = gridOrigin + (base + offset) * snap;
        if (inIntervals(position - start, cuts)) return position;
      }
    }
    return null;
  }

  let best = cuts[0]![0];
  let bestDistance = Infinity;
  for (const [low, high] of cuts) {
    const candidate = Math.min(high, Math.max(low, raw));
    const distance = Math.abs(candidate - raw);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  // Prefer whole pixels when rounding keeps the cut valid.
  const rounded = Math.round(start + best);
  return inIntervals(rounded - start, cuts) ? rounded : start + best;
}

function chooseAxis(rect: Rect, ctx: SplitContext, canVertical: boolean, canHorizontal: boolean): Axis {
  if (canVertical && !canHorizontal) return "vertical";
  if (canHorizontal && !canVertical) return "horizontal";
  const { splitBias } = ctx.layout;
  const tooWide = rect.width > ctx.width.hi + EPS;
  const tooTall = rect.height > ctx.height.hi + EPS;
  if (tooWide && !tooTall) return "vertical";
  if (tooTall && !tooWide) return "horizontal";

  // Aspect relative to the size limits: cells wide for their allowed width
  // prefer vertical cuts. The bias tilts toward columns (+1) or rows (-1).
  const aspect = rect.width / ctx.width.hi / Math.max(1e-6, rect.height / ctx.height.hi);
  const verticalWeight = Math.pow(aspect, 1.6) * Math.exp(splitBias * 2.2);
  const horizontalWeight = Math.exp(-splitBias * 2.2);
  return ctx.rng() * (verticalWeight + horizontalWeight) < verticalWeight
    ? "vertical"
    : "horizontal";
}

function split(rect: Rect, depth: number, ctx: SplitContext): void {
  const { density, snap, varianceX, varianceY } = ctx.layout;
  const canVertical = rect.width >= ctx.width.lo * 2 - EPS;
  const canHorizontal = rect.height >= ctx.height.lo * 2 - EPS;
  const mustSplit = rect.width > ctx.width.hi + EPS || rect.height > ctx.height.hi + EPS;

  if (
    depth >= MAX_DEPTH ||
    ctx.cells.length >= MAX_CELLS ||
    (!canVertical && !canHorizontal) ||
    (!mustSplit && ctx.rng() > density)
  ) {
    ctx.cells.push(rect);
    return;
  }

  const preferred = chooseAxis(rect, ctx, canVertical, canHorizontal);
  const axes: Axis[] = preferred === "vertical" ? ["vertical", "horizontal"] : ["horizontal", "vertical"];

  for (const axis of axes) {
    if (axis === "vertical" && !canVertical) continue;
    if (axis === "horizontal" && !canHorizontal) continue;
    const variance = axis === "vertical" ? varianceX : varianceY;
    const fraction = 0.5 + (ctx.rng() * 2 - 1) * 0.5 * variance;
    const position =
      axis === "vertical"
        ? resolveSplitPosition(rect.x, rect.width, fraction, ctx.width, snap, ctx.origin.x)
        : resolveSplitPosition(rect.y, rect.height, fraction, ctx.height, snap, ctx.origin.y);
    if (position === null) continue;

    if (axis === "vertical") {
      split({ height: rect.height, width: position - rect.x, x: rect.x, y: rect.y }, depth + 1, ctx);
      split({ height: rect.height, width: rect.x + rect.width - position, x: position, y: rect.y }, depth + 1, ctx);
    } else {
      split({ height: position - rect.y, width: rect.width, x: rect.x, y: rect.y }, depth + 1, ctx);
      split({ height: rect.y + rect.height - position, width: rect.width, x: rect.x, y: position }, depth + 1, ctx);
    }
    return;
  }

  ctx.cells.push(rect);
}

/**
 * Square packing. The root is divided into a module grid as close to square
 * as the root allows (exactly square when its sides are whole multiples of the
 * module). Scanning row-major, each free module starts the largest k×k square
 * that fits, shrunk at random by density, so every leaf is a square between
 * the width limits and the grid stays gap-free.
 */
function packSquares(root: Rect, layout: LayoutParams, rng: Rng): Rect[] {
  const { density, maxWidth, minWidth, snap } = layout;
  let unit = snap > 0 ? snap * Math.max(1, Math.round(minWidth / snap)) : minWidth;
  if (Math.round(root.width / unit) * Math.round(root.height / unit) > MAX_CELLS) {
    unit *= Math.sqrt((root.width * root.height) / (unit * unit) / MAX_CELLS);
  }
  let columns = Math.max(1, Math.round(root.width / unit));
  let rows = Math.max(1, Math.round(root.height / unit));
  if (snap <= 0) {
    // Without a snap grid, pick the module (never below the minimum) whose
    // rows and columns fit the root most exactly, so squares are true squares.
    const most = Math.max(1, Math.floor(root.width / unit + EPS));
    let bestError = Infinity;
    for (let candidate = most; candidate >= Math.max(1, Math.floor(most / 2)); candidate -= 1) {
      const side = root.width / candidate;
      const candidateRows = Math.max(1, Math.round(root.height / side));
      const error = Math.abs(candidateRows * side - root.height) / root.height;
      if (error < bestError - 1e-4) {
        bestError = error;
        columns = candidate;
        rows = candidateRows;
      }
    }
    unit = root.width / columns;
  }
  const maxSpan = Math.max(1, Math.floor(maxWidth / unit + EPS));
  const xAt = (column: number) => root.x + (column / columns) * root.width;
  const yAt = (row: number) => root.y + (row / rows) * root.height;
  const taken = new Uint8Array(columns * rows);
  const cells: Rect[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (taken[row * columns + column]) continue;
      let fit = 1;
      grow: while (fit < maxSpan && column + fit < columns && row + fit < rows) {
        for (let i = 0; i <= fit; i += 1) {
          if (taken[(row + i) * columns + column + fit] || taken[(row + fit) * columns + column + i]) break grow;
        }
        fit += 1;
      }
      // Density 0 always takes the largest square; higher density skews smaller.
      const span = Math.max(1, Math.min(fit, Math.round(1 + (fit - 1) * Math.pow(rng(), density * 3))));
      for (let i = 0; i < span; i += 1) taken.fill(1, (row + i) * columns + column, (row + i) * columns + column + span);
      cells.push({ height: yAt(row + span) - yAt(row), width: xAt(column + span) - xAt(column), x: xAt(column), y: yAt(row) });
    }
  }
  return cells;
}

export function tessellate(root: Rect, layout: LayoutParams, tileSeed: number = layout.seed): Rect[] {
  if (!(root.width > 0 && root.height > 0)) return [];
  const rng = createRng(hashInts(tileSeed, 0x7e55e11a));
  if (layout.square) return packSquares(root, layout, rng);
  const cells: Rect[] = [];
  split(root, 0, {
    cells,
    height: { hi: layout.maxHeight, lo: layout.minHeight },
    layout,
    origin: { x: root.x, y: root.y },
    rng,
    width: { hi: layout.maxWidth, lo: layout.minWidth },
  });
  return cells;
}

/** Seed for an Infinity-mode neighbor tile; tile (0, 0) is the artboard itself. */
export function tileSeed(seed: number, column: number, row: number): number {
  return column === 0 && row === 0 ? seed : hashInts(seed, column, row, 0x71e5);
}
