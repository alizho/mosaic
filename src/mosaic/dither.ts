/**
 * Two-ink dithering of a cell's gradient tone on a grid of square dots.
 * Bayer (ordered 8×8), Floyd–Steinberg (serpentine error diffusion) and
 * Random (white-noise threshold). The mask is shared by the WebGL renderer,
 * the Canvas 2D fallback and SVG export.
 */

import { gradientParam, warpParam, type CellFrame } from "./cells";
import type { DitherPatternId } from "./params";
import { hashInts } from "./rng";
import type { Rect } from "./tessellate";

export type DitherMatrix = Readonly<{
  height: number;
  /** Row-major ranks 0..levels-1; a dot is "on" when tone > (rank + 0.5) / levels. */
  ranks: readonly number[];
  width: number;
}>;

function bayer(size: number): DitherMatrix {
  let ranks = [0];
  let current = 1;
  while (current < size) {
    const next = current * 2;
    const grown = new Array<number>(next * next);
    for (let y = 0; y < current; y += 1) {
      for (let x = 0; x < current; x += 1) {
        const value = ranks[y * current + x]! * 4;
        grown[y * next + x] = value;
        grown[y * next + x + current] = value + 2;
        grown[(y + current) * next + x] = value + 3;
        grown[(y + current) * next + x + current] = value + 1;
      }
    }
    ranks = grown;
    current = next;
  }
  return { height: size, ranks, width: size };
}

export const BAYER_MATRIX: DitherMatrix = bayer(8);

export function ditherThreshold(matrix: DitherMatrix, rank: number): number {
  return (rank + 0.5) / matrix.ranks.length;
}

/** Horizontal lattice shift (in dots) for Bayer scrolling; loops every 8 dots. */
export function bayerScrollOffset(scroll: number): number {
  return Math.floor(scroll * BAYER_MATRIX.width + 1e-9);
}

export type DitherMask = Readonly<{
  columns: number;
  /** 1 where ink B prints, 0 for ink A; row-major `columns × rows`. */
  data: Uint8Array;
  rows: number;
}>;

export function computeDitherMask(frame: CellFrame, dotSize: number, area: Rect): DitherMask {
  const { rect } = frame;
  const columns = Math.max(1, Math.ceil(area.width / dotSize));
  const rows = Math.max(1, Math.ceil(area.height / dotSize));
  const data = new Uint8Array(columns * rows);
  const tone = (column: number, row: number) =>
    warpParam(gradientParam(frame.gradient, rect.x + (column + 0.5) * dotSize, rect.y + (row + 0.5) * dotSize), frame.mid);

  const pattern: DitherPatternId = frame.pattern;
  if (pattern === "bayer") {
    const offset = bayerScrollOffset(frame.scroll);
    for (let row = 0; row < rows; row += 1) {
      const matrixRow = row % BAYER_MATRIX.height;
      for (let column = 0; column < columns; column += 1) {
        const rank = BAYER_MATRIX.ranks[matrixRow * BAYER_MATRIX.width + ((column + offset) % BAYER_MATRIX.width)]!;
        data[row * columns + column] = tone(column, row) > ditherThreshold(BAYER_MATRIX, rank) ? 1 : 0;
      }
    }
    return { columns, data, rows };
  }

  if (pattern === "random") {
    // Scrolling wraps within the cell (period = columns) so loops stay seamless.
    const offset = Math.floor(frame.scroll * columns + 1e-9);
    const salt = hashInts(Math.round(rect.x), Math.round(rect.y), 0xd17e);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const threshold = hashInts(salt, (column + offset) % columns, row) / 4294967296;
        data[row * columns + column] = tone(column, row) > threshold ? 1 : 0;
      }
    }
    return { columns, data, rows };
  }

  // Floyd–Steinberg, serpentine scan to avoid directional worms.
  let current = new Float32Array(columns + 2);
  let next = new Float32Array(columns + 2);
  for (let row = 0; row < rows; row += 1) {
    const forward = row % 2 === 0;
    for (let step = 0; step < columns; step += 1) {
      const column = forward ? step : columns - 1 - step;
      const value = tone(column, row) + current[column + 1]!;
      const on = value >= 0.5 ? 1 : 0;
      data[row * columns + column] = on;
      const error = value - on;
      const ahead = forward ? 1 : -1;
      current[column + 1 + ahead] += (error * 7) / 16;
      next[column + 1 - ahead] += (error * 3) / 16;
      next[column + 1] += (error * 5) / 16;
      next[column + 1 + ahead] += error / 16;
    }
    [current, next] = [next, current];
    next.fill(0);
  }
  return { columns, data, rows };
}
