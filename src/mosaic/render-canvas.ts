/**
 * Mosaic renderer. The caller supplies a 2D context already transformed to
 * scene coordinates; the same function draws live preview, runtime image/video
 * export frames, Infinity neighbor tiles and GIF frames. Gradient and dither
 * cells (with their integrated grain) render through WebGL; solids in 2D.
 */

import { evaluateCell, isCellPruned, type CellFrame } from "./cells";
import { computeDitherMask, type DitherMask } from "./dither";
import { drawFillCells, type FillDraw } from "./fill-gl";
import { mixRgb, rgbToCss } from "./palettes";
import type { MosaicScene } from "./scene";
import type { Rect } from "./tessellate";

export type MosaicDrawOptions = Readonly<{
  /** Device pixels per scene unit, used to hide anti-aliasing seams. */
  pixelRatio: number;
  progress: number;
  scene: MosaicScene;
}>;

type ScratchCanvas = OffscreenCanvas;
type Scratch2D = OffscreenCanvasRenderingContext2D;

function createScratchCanvas(width: number, height: number): ScratchCanvas {
  return new OffscreenCanvas(width, height);
}

let ditherScratch: { canvas: ScratchCanvas; context: Scratch2D } | null = null;

function getDitherScratch(width: number, height: number): { canvas: ScratchCanvas; context: Scratch2D } | null {
  if (!ditherScratch || ditherScratch.canvas.width < width || ditherScratch.canvas.height < height) {
    const canvas = createScratchCanvas(
      Math.max(width, ditherScratch?.canvas.width ?? 0),
      Math.max(height, ditherScratch?.canvas.height ?? 0),
    );
    const context = canvas.getContext("2d");
    if (!context) return null;
    ditherScratch = { canvas, context };
  }
  return ditherScratch;
}

function applyGradientStyle(ctx: CanvasRenderingContext2D, frame: CellFrame): void {
  const { gradient } = frame;
  const style =
    gradient.kind === "radial"
      ? ctx.createRadialGradient(gradient.cx, gradient.cy, 0, gradient.cx, gradient.cy, gradient.radius)
      : ctx.createLinearGradient(gradient.x0, gradient.y0, gradient.x1, gradient.y1);
  style.addColorStop(0, rgbToCss(frame.a));
  style.addColorStop(Math.min(0.999, Math.max(0.001, frame.mid)), rgbToCss(mixRgb(frame.a, frame.b, 0.5)));
  style.addColorStop(1, rgbToCss(frame.b));
  ctx.fillStyle = style;
}

/** Canvas 2D fallback for dither cells when WebGL2 is unavailable (no grain). */
function drawDitherCell(ctx: CanvasRenderingContext2D, frame: CellFrame, mask: DitherMask, dotSize: number, drawRect: Rect): void {
  const { columns, rows } = mask;
  const scratch = getDitherScratch(columns, rows);
  if (!scratch) return;
  const image = scratch.context.createImageData(columns, rows);
  for (let index = 0; index < mask.data.length; index += 1) {
    const color = mask.data[index] ? frame.b : frame.a;
    image.data.set([color[0], color[1], color[2], 255], index * 4);
  }
  scratch.context.putImageData(image, 0, 0);
  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  ctx.beginPath();
  ctx.rect(drawRect.x, drawRect.y, drawRect.width, drawRect.height);
  ctx.clip();
  ctx.drawImage(scratch.canvas, 0, 0, columns, rows, frame.rect.x, frame.rect.y, columns * dotSize, rows * dotSize);
  ctx.restore();
  ctx.imageSmoothingEnabled = smoothing;
}

/** Draw one tile (the artboard or an Infinity neighbor) in scene coordinates. */
export function drawMosaic(ctx: CanvasRenderingContext2D, options: MosaicDrawOptions): void {
  const { pixelRatio, progress, scene } = options;
  const { params, root } = scene;
  // Overlap shared edges by under one device pixel so anti-aliasing never
  // leaves hairline seams; the root clip keeps the outer edges flush.
  const seam = 0.75 / Math.max(pixelRatio, 1e-3);
  const dotSize = params.fill.ditherScale;
  const fills: FillDraw[] = [];
  const solids: { drawRect: Rect; frame: CellFrame }[] = [];

  scene.cells.forEach((rect, index) => {
    const style = scene.styles[index];
    if (!style || isCellPruned(rect, root, scene.seed, index, params.frame.edgeRemoval)) return;
    const frame = evaluateCell(rect, style, params, progress);
    const drawRect: Rect = {
      height: rect.height + (rect.y + rect.height < root.y + root.height - 1e-6 ? seam : 0),
      width: rect.width + (rect.x + rect.width < root.x + root.width - 1e-6 ? seam : 0),
      x: rect.x,
      y: rect.y,
    };
    if (frame.fill === "solid") solids.push({ drawRect, frame });
    else fills.push({ drawRect, frame, ...(frame.fill === "dither" ? { mask: computeDitherMask(frame, dotSize, drawRect) } : {}) });
  });

  ctx.save();
  ctx.beginPath();
  ctx.rect(root.x, root.y, root.width, root.height);
  ctx.clip();

  // Gradient and dither cells carry the integrated grain (WebGL); solids stay clean.
  if (!drawFillCells(ctx, root, fills, params.grain, dotSize, progress)) {
    for (const { drawRect, frame, mask } of fills) {
      if (mask) {
        drawDitherCell(ctx, frame, mask, dotSize, drawRect);
        continue;
      }
      applyGradientStyle(ctx, frame);
      ctx.fillRect(drawRect.x, drawRect.y, drawRect.width, drawRect.height);
    }
  }

  for (const { drawRect, frame } of solids) {
    ctx.fillStyle = rgbToCss(frame.a);
    ctx.fillRect(drawRect.x, drawRect.y, drawRect.width, drawRect.height);
  }
  ctx.restore();
}
