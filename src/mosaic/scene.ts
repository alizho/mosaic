/**
 * Scene assembly: tessellation + cell styles for one root rectangle, cached by
 * the inputs that change structure. Timeline playback reuses the cached scene;
 * only layout, fill-mode weights, palette size or the root rect rebuild it.
 */

import { createCellStyles, type CellStyle } from "./cells";
import type { MosaicParams } from "./params";
import { tessellate, tileSeed, type Rect } from "./tessellate";

export type MosaicScene = Readonly<{
  cells: readonly Rect[];
  params: MosaicParams;
  root: Rect;
  seed: number;
  styles: readonly CellStyle[];
}>;

type CachedStructure = Readonly<{ cells: readonly Rect[]; styles: readonly CellStyle[] }>;

const CACHE_LIMIT = 96;
const structureCache = new Map<string, CachedStructure>();

function structureKey(root: Rect, seed: number, params: MosaicParams): string {
  const { fill, layout } = params;
  return JSON.stringify([
    root.x, root.y, root.width, root.height, seed,
    layout.density, layout.minWidth, layout.maxWidth, layout.minHeight, layout.maxHeight,
    layout.square, layout.snap, layout.splitBias, layout.varianceX, layout.varianceY,
    fill.solidWeight, fill.gradientWeight, fill.ditherWeight, fill.scanlinesWeight, fill.dotsWeight, fill.asciiWeight,
    fill.gradientType, fill.scanlineDirection,
    params.palette.map((color) => color.join(",")).join(";"),
    params.background?.join(",") ?? "none",
  ]);
}

export function buildMosaicScene(root: Rect, params: MosaicParams, seed: number = params.layout.seed): MosaicScene {
  const key = structureKey(root, seed, params);
  let structure = structureCache.get(key);
  if (structure) {
    structureCache.delete(key);
  } else {
    const cells = tessellate(root, params.layout, seed);
    structure = { cells, styles: createCellStyles(cells, seed, params.fill, params.palette, params.background) };
    if (structureCache.size >= CACHE_LIMIT) {
      const oldest = structureCache.keys().next().value;
      if (oldest !== undefined) structureCache.delete(oldest);
    }
  }
  structureCache.set(key, structure);
  return { ...structure, params, root, seed };
}

/** Infinity neighbor tile: same size as the artboard, offset by whole tiles. */
export function buildTileScene(artboard: Rect, params: MosaicParams, column: number, row: number): MosaicScene {
  return buildMosaicScene(
    {
      height: artboard.height,
      width: artboard.width,
      x: artboard.x + column * artboard.width,
      y: artboard.y + row * artboard.height,
    },
    params,
    tileSeed(params.layout.seed, column, row),
  );
}
