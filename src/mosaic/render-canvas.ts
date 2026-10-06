/**
 * Mosaic renderer. The caller supplies a 2D context already transformed to
 * scene coordinates; the same function draws live preview, runtime image/video
 * export frames, Infinity neighbor tiles and GIF frames. Framed cells render
 * through one WebGL pass, with a Canvas 2D fallback.
 */

import { evaluateCell, isPatternFill, type CellFrame } from "./cells";
import { computeDitherMask, type DitherMask } from "./dither";
import { drawFillCells, type FillDraw } from "./fill-gl";
import { visibleCells } from "./framing";
import { mixRgb, rgbToCss } from "./palettes";
import type { FillParams } from "./params";
import { ASCII_FONT_STACK, asciiPitch, scanlineStrokes } from "./pattern-texture";
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

/** Canvas 2D fallback for dither cells when WebGL2 is unavailable. */
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

/** Canvas 2D fallback for pattern cells: ink only, on a transparent ground. */
function drawPatternCell(ctx: CanvasRenderingContext2D, frame: CellFrame, fill: FillParams, drawRect: Rect): void {
  const { rect } = frame;
  ctx.save();
  ctx.beginPath();
  ctx.rect(drawRect.x, drawRect.y, drawRect.width, drawRect.height);
  ctx.clip();
  ctx.fillStyle = rgbToCss(frame.ink);
  const shiftOf = (spacing: number) => (((frame.scroll % 1) + 1) % 1) * spacing;

  if (frame.fill === "scanlines") {
    for (const stroke of scanlineStrokes(rect, drawRect, frame.lineAxis === "vertical", frame.scroll, fill)) {
      ctx.globalAlpha = stroke.opacity;
      ctx.beginPath();
      stroke.points.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      ctx.fill();
    }
  } else if (frame.fill === "dots") {
    const spacing = fill.dotSpacing;
    const radius = (spacing * fill.dotSize) / 2;
    const shift = shiftOf(spacing);
    ctx.beginPath();
    for (let row = 0; row * spacing < drawRect.height; row += 1) {
      const stagger = fill.dotGrid === "staggered" && row % 2 === 1 ? -spacing / 2 : 0;
      for (let x = shift + stagger - spacing; x < drawRect.width + spacing; x += spacing) {
        const cx = rect.x + x + spacing / 2;
        const cy = rect.y + row * spacing + spacing / 2;
        ctx.moveTo(cx + radius, cy);
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  } else {
    const [pitchX, pitchY] = asciiPitch(fill.asciiSize);
    const shift = shiftOf(pitchX);
    ctx.font = `${fill.asciiSize * 0.8}px ${ASCII_FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let y = 0; y < drawRect.height; y += pitchY) {
      for (let x = shift - pitchX; x < drawRect.width + pitchX; x += pitchX) {
        ctx.fillText(fill.asciiChar, rect.x + x + pitchX / 2, rect.y + y + pitchY / 2);
      }
    }
  }
  ctx.restore();
}

/** Draw one tile (the artboard or an Infinity neighbor) in scene coordinates. */
export function drawMosaic(ctx: CanvasRenderingContext2D, options: MosaicDrawOptions): void {
  const { pixelRatio, progress, scene } = options;
  const { params, root } = scene;
  // Overlap shared edges by under one device pixel so anti-aliasing never
  // leaves hairline seams; outer edges stay flush.
  const seam = 0.75 / Math.max(pixelRatio, 1e-3);
  const dotSize = params.fill.ditherScale;

  const opaque: FillDraw[] = [];
  const patterns: FillDraw[] = [];
  for (const index of visibleCells(scene)) {
    const rect = scene.cells[index]!;
    const style = scene.styles[index];
    if (!style) continue;
    const frame = evaluateCell(rect, style, params, progress);
    // Pattern cells keep their exact bounds and draw last, so their empty
    // ground never overwrites a neighbor's seam overlap.
    if (isPatternFill(frame.fill)) {
      patterns.push({ drawRect: rect, frame });
      continue;
    }
    const drawRect: Rect = {
      height: rect.height + (rect.y + rect.height < root.y + root.height - 1e-6 ? seam : 0),
      width: rect.width + (rect.x + rect.width < root.x + root.width - 1e-6 ? seam : 0),
      x: rect.x,
      y: rect.y,
    };
    opaque.push({ drawRect, frame, ...(frame.fill === "dither" ? { mask: computeDitherMask(frame, dotSize, drawRect) } : {}) });
  }
  const draws = [...opaque, ...patterns];

  if (drawFillCells(ctx, draws, { fill: params.fill, grain: params.grain, progress })) return;

  for (const { drawRect, frame, mask } of draws) {
    if (frame.fill === "dither" && mask) {
      drawDitherCell(ctx, frame, mask, dotSize, drawRect);
    } else if (isPatternFill(frame.fill)) {
      drawPatternCell(ctx, frame, params.fill, drawRect);
    } else {
      if (frame.fill === "gradient") applyGradientStyle(ctx, frame);
      else ctx.fillStyle = rgbToCss(frame.a);
      ctx.fillRect(drawRect.x, drawRect.y, drawRect.width, drawRect.height);
    }
  }
}
