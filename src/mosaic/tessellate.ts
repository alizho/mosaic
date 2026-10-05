/**
 * Rectilinear partitioning: recursive guillotine (binary space) slicing of one
 * root rectangle. Children always share exact split coordinates and the leaves
 * cover the root with zero gaps and no overlap, so edges stay flush with the
 * artboard by construction rather than by clipping.
 */

import type { LayoutParams } from "./params";
import { createRng, hashInts, type Rng } from "./rng";

export type Rect = Readonly<{ height: number; width: number; x: number; y: number }>;

const MAX_DEPTH = 28;
const MAX_CELLS = 6000;

type Axis = "vertical" | "horizontal";

type SplitContext = Readonly<{
  cells: Rect[];
  layout: LayoutParams;
  origin: Readonly<{ x: number; y: number }>;
  rng: Rng;
}>;

/** Snap a split coordinate to the global module grid, keeping both parts valid. */
function resolveSplitPosition(
  start: number,
  length: number,
  fraction: number,
  minCell: number,
  snap: number,
  gridOrigin: number,
): number | null {
  const min = start + minCell;
  const max = start + length - minCell;
  if (min > max) return null;

  const raw = start + fraction * length;
  if (snap <= 0) {
    return Math.min(max, Math.max(min, Math.round(raw)));
  }

  const snapped = gridOrigin + Math.round((raw - gridOrigin) / snap) * snap;
  const candidates = [snapped, snapped - snap, snapped + snap];
  for (const candidate of candidates) {
    if (candidate >= min - 1e-6 && candidate <= max + 1e-6) return candidate;
  }
  return null;
}

function chooseAxis(rect: Rect, ctx: SplitContext, canVertical: boolean, canHorizontal: boolean): Axis {
  if (canVertical && !canHorizontal) return "vertical";
  if (canHorizontal && !canVertical) return "horizontal";
  const { maxCell, splitBias } = ctx.layout;
  const tooWide = rect.width > maxCell;
  const tooTall = rect.height > maxCell;
  if (tooWide && !tooTall) return "vertical";
  if (tooTall && !tooWide) return "horizontal";

  // Wide cells prefer vertical cuts; the bias tilts the result toward
  // columns (+1, tall cells) or rows (-1, wide cells).
  const aspect = rect.width / Math.max(1e-6, rect.height);
  const verticalWeight = Math.pow(aspect, 1.6) * Math.exp(splitBias * 2.2);
  const horizontalWeight = Math.exp(-splitBias * 2.2);
  return ctx.rng() * (verticalWeight + horizontalWeight) < verticalWeight
    ? "vertical"
    : "horizontal";
}

function split(rect: Rect, depth: number, ctx: SplitContext): void {
  const { density, maxCell, minCell, snap, varianceX, varianceY } = ctx.layout;
  const canVertical = rect.width >= minCell * 2;
  const canHorizontal = rect.height >= minCell * 2;
  const mustSplit = rect.width > maxCell || rect.height > maxCell;

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
        ? resolveSplitPosition(rect.x, rect.width, fraction, minCell, snap, ctx.origin.x)
        : resolveSplitPosition(rect.y, rect.height, fraction, minCell, snap, ctx.origin.y);
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

export function tessellate(root: Rect, layout: LayoutParams, tileSeed: number = layout.seed): Rect[] {
  const cells: Rect[] = [];
  if (!(root.width > 0 && root.height > 0)) return cells;
  split(root, 0, {
    cells,
    layout,
    origin: { x: root.x, y: root.y },
    rng: createRng(hashInts(tileSeed, 0x7e55e11a)),
  });
  return cells;
}

/** Seed for an Infinity-mode neighbor tile; tile (0, 0) is the artboard itself. */
export function tileSeed(seed: number, column: number, row: number): number {
  return column === 0 && row === 0 ? seed : hashInts(seed, column, row, 0x71e5);
}
