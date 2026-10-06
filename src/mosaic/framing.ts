/**
 * Framing modes resolved into the cells actually drawn, shared by the raster,
 * SVG and GIF renderers. Both modes delete cells into transparent gaps using
 * a fixed seeded roll per cell, so raising the amount only ever removes more
 * of the same cells.
 *
 * - Erosion removes cells touching the outer frame (see `isCellPruned`).
 * - Explosion removes cells anywhere in the grid.
 */

import { isCellPruned } from "./cells";
import { hashInts } from "./rng";
import type { MosaicScene } from "./scene";

/** Explosion: any cell whose roll falls under the amount is deleted. */
export function isCellExploded(seed: number, index: number, amount: number): boolean {
  return amount > 0 && hashInts(seed, index, 0xe8b1) / 4294967296 < amount;
}

/** Indices of the cells to draw, in draw order. */
export function visibleCells(scene: MosaicScene): number[] {
  const { cells, params, root, seed } = scene;
  const { edgeRemoval, explosionAmount } = params.frame;
  const visible: number[] = [];
  cells.forEach((rect, index) => {
    if (isCellPruned(rect, root, seed, index, edgeRemoval) || isCellExploded(seed, index, explosionAmount)) return;
    visible.push(index);
  });
  return visible;
}
