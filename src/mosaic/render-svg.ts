/**
 * Editable vector output. Solids are rects, gradients are native SVG gradients,
 * and ordered dither is decomposed exactly per threshold rank: the pixels of
 * rank k form a regular lattice (an SVG <pattern>) and are "on" wherever the
 * warped gradient exceeds that rank's threshold — a half-plane for linear and
 * the outside of a circle for radial gradients. Gradient grain is raster-only
 * and intentionally omitted; eroded and exploded cells are omitted as gaps.
 * Floyd–Steinberg and Random dither cells export as merged runs of dots.
 * Scanline, dot and ASCII cells are ink only on an empty ground (scanlines as
 * textured polygons, dots and glyphs as SVG patterns).
 */

import { evaluateCell, isPatternFill, unwarpParam, type CellFrame } from "./cells";
import { BAYER_MATRIX, bayerScrollOffset, computeDitherMask, ditherThreshold } from "./dither";
import { visibleCells } from "./framing";
import { mixRgb, rgbToHex } from "./palettes";
import type { FillParams } from "./params";
import { ASCII_FONT_STACK, asciiPitch, scanlineStrokes } from "./pattern-texture";
import type { MosaicScene } from "./scene";
import type { Rect } from "./tessellate";

const SVG_NS = "http://www.w3.org/2000/svg";

type Builder = Readonly<{
  defs: SVGDefsElement;
  doc: Document;
  nextId: (prefix: string) => string;
}>;

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function el<K extends keyof SVGElementTagNameMap>(
  builder: Builder,
  tag: K,
  attributes: Readonly<Record<string, string | number>>,
): SVGElementTagNameMap[K] {
  const node = builder.doc.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, typeof value === "number" ? fmt(value) : value);
  }
  return node;
}

function rectAttributes(rect: Rect): Record<string, number> {
  return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
}

function gradientFill(builder: Builder, frame: CellFrame): string {
  const id = builder.nextId("mosaic-gradient");
  const { gradient } = frame;
  const node =
    gradient.kind === "radial"
      ? el(builder, "radialGradient", { cx: gradient.cx, cy: gradient.cy, gradientUnits: "userSpaceOnUse", id, r: gradient.radius })
      : el(builder, "linearGradient", { gradientUnits: "userSpaceOnUse", id, x1: gradient.x0, x2: gradient.x1, y1: gradient.y0, y2: gradient.y1 });
  const stops: readonly (readonly [number, string])[] = [
    [0, rgbToHex(frame.a)],
    [Math.min(0.999, Math.max(0.001, frame.mid)), rgbToHex(mixRgb(frame.a, frame.b, 0.5))],
    [1, rgbToHex(frame.b)],
  ];
  for (const [offset, color] of stops) {
    node.append(el(builder, "stop", { offset, "stop-color": color }));
  }
  builder.defs.append(node);
  return `url(#${id})`;
}

type Point = readonly [number, number];

/** Clip a rectangle against the half-plane f(p) > 0 (Sutherland–Hodgman, one edge). */
function clipRectToHalfPlane(rect: Rect, f: (x: number, y: number) => number): Point[] {
  const corners: Point[] = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x + rect.width, rect.y + rect.height],
    [rect.x, rect.y + rect.height],
  ];
  const output: Point[] = [];
  corners.forEach((current, index) => {
    const previous = corners[(index + corners.length - 1) % corners.length]!;
    const fc = f(current[0], current[1]);
    const fp = f(previous[0], previous[1]);
    if (fc > 0 !== fp > 0) {
      const t = fp / (fp - fc);
      output.push([previous[0] + (current[0] - previous[0]) * t, previous[1] + (current[1] - previous[1]) * t]);
    }
    if (fc > 0) output.push(current);
  });
  return output;
}

function ditherRegion(builder: Builder, frame: CellFrame, threshold: number, fill: string): SVGElement | null {
  const { gradient, rect } = frame;
  const tau = unwarpParam(threshold, frame.mid);
  if (tau >= 1) return null;

  if (gradient.kind === "linear") {
    const vx = gradient.x1 - gradient.x0;
    const vy = gradient.y1 - gradient.y0;
    const lengthSq = vx * vx + vy * vy || 1;
    const polygon = clipRectToHalfPlane(rect, (x, y) => (x - gradient.x0) * vx + (y - gradient.y0) * vy - tau * lengthSq);
    if (polygon.length < 3) return null;
    return el(builder, "polygon", { fill, points: polygon.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ") });
  }

  const radius = Math.max(0, tau * gradient.radius);
  const r = fmt(radius);
  const d =
    `M${fmt(rect.x)} ${fmt(rect.y)}h${fmt(rect.width)}v${fmt(rect.height)}h${fmt(-rect.width)}Z` +
    (radius > 0
      ? `M${fmt(gradient.cx - radius)} ${fmt(gradient.cy)}a${r} ${r} 0 1 0 ${fmt(radius * 2)} 0a${r} ${r} 0 1 0 ${fmt(-radius * 2)} 0Z`
      : "");
  return el(builder, "path", { d, fill, "fill-rule": "evenodd" });
}

function appendDitherCell(builder: Builder, parent: SVGGElement, frame: CellFrame, ditherScale: number): void {
  const { rect } = frame;
  const matrix = BAYER_MATRIX;
  const clipId = builder.nextId("mosaic-clip");
  const clip = el(builder, "clipPath", { id: clipId });
  clip.append(el(builder, "rect", rectAttributes(rect)));
  builder.defs.append(clip);

  const group = el(builder, "g", { "clip-path": `url(#${clipId})`, "data-mosaic-fill": "dither" });
  group.append(el(builder, "rect", { ...rectAttributes(rect), fill: rgbToHex(frame.a) }));

  const colorB = rgbToHex(frame.b);
  if (frame.pattern !== "bayer") {
    // Error-diffused and random dots have no lattice: emit merged runs of ink B.
    const mask = computeDitherMask(frame, ditherScale, rect);
    for (let row = 0; row < mask.rows; row += 1) {
      let start = -1;
      for (let column = 0; column <= mask.columns; column += 1) {
        const on = column < mask.columns && mask.data[row * mask.columns + column] === 1;
        if (on && start < 0) start = column;
        if (!on && start >= 0) {
          group.append(el(builder, "rect", { fill: colorB, height: ditherScale, width: (column - start) * ditherScale, x: rect.x + start * ditherScale, y: rect.y + row * ditherScale }));
          start = -1;
        }
      }
    }
    parent.append(group);
    return;
  }

  const scrollX = bayerScrollOffset(frame.scroll);
  const scrollY = 0;
  const levels = matrix.ranks.length;
  for (let rank = 0; rank < levels; rank += 1) {
    const patternId = builder.nextId("mosaic-dither");
    const pattern = el(builder, "pattern", {
      height: matrix.height * ditherScale,
      id: patternId,
      patternUnits: "userSpaceOnUse",
      width: matrix.width * ditherScale,
      x: rect.x - scrollX * ditherScale,
      y: rect.y - scrollY * ditherScale,
    });
    matrix.ranks.forEach((value, index) => {
      if (value !== rank) return;
      const column = index % matrix.width;
      const row = Math.floor(index / matrix.width);
      pattern.append(el(builder, "rect", { fill: colorB, height: ditherScale, width: ditherScale, x: column * ditherScale, y: row * ditherScale }));
    });
    const region = ditherRegion(builder, frame, ditherThreshold(matrix, rank), `url(#${patternId})`);
    if (!region) continue;
    builder.defs.append(pattern);
    group.append(region);
  }
  parent.append(group);
}

/**
 * Pattern cell: ink only, on an empty ground.
 * Scanlines are polygons tracing their textured width with per-stroke
 * opacity; dots and ASCII glyphs are userSpace patterns anchored at the cell.
 */
function appendPatternCell(builder: Builder, parent: SVGGElement, frame: CellFrame, fill: FillParams): void {
  const { rect } = frame;
  const ink = rgbToHex(frame.ink);
  const clipId = builder.nextId("mosaic-clip");
  const clip = el(builder, "clipPath", { id: clipId });
  clip.append(el(builder, "rect", rectAttributes(rect)));
  builder.defs.append(clip);
  const group = el(builder, "g", { "clip-path": `url(#${clipId})`, "data-mosaic-fill": frame.fill });
  const shift = ((frame.scroll % 1) + 1) % 1;

  if (frame.fill === "scanlines") {
    const strokes = el(builder, "g", { fill: ink });
    for (const stroke of scanlineStrokes(rect, rect, frame.lineAxis === "vertical", frame.scroll, fill)) {
      strokes.append(el(builder, "polygon", {
        "fill-opacity": stroke.opacity,
        points: stroke.points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" "),
      }));
    }
    group.append(strokes);
  } else {
    const patternId = builder.nextId(`mosaic-${frame.fill}`);
    let pattern: SVGPatternElement;
    if (frame.fill === "dots") {
      const spacing = fill.dotSpacing;
      const radius = (spacing * fill.dotSize) / 2;
      const staggered = fill.dotGrid === "staggered";
      pattern = el(builder, "pattern", {
        height: spacing * (staggered ? 2 : 1),
        id: patternId,
        patternUnits: "userSpaceOnUse",
        width: spacing,
        x: rect.x + shift * spacing,
        y: rect.y,
      });
      pattern.append(el(builder, "circle", { cx: spacing / 2, cy: spacing / 2, fill: ink, r: radius }));
      if (staggered) {
        // Odd rows sit half a period left; draw both halves so the tile wraps.
        for (const cx of [0, spacing]) pattern.append(el(builder, "circle", { cx, cy: spacing * 1.5, fill: ink, r: radius }));
      }
    } else {
      const [pitchX, pitchY] = asciiPitch(fill.asciiSize);
      pattern = el(builder, "pattern", {
        height: pitchY,
        id: patternId,
        patternUnits: "userSpaceOnUse",
        width: pitchX,
        x: rect.x + shift * pitchX,
        y: rect.y,
      });
      const glyph = el(builder, "text", {
        "dominant-baseline": "central",
        fill: ink,
        "font-family": ASCII_FONT_STACK,
        "font-size": fill.asciiSize * 0.8,
        "text-anchor": "middle",
        x: pitchX / 2,
        y: pitchY / 2,
      });
      glyph.textContent = fill.asciiChar;
      pattern.append(glyph);
    }
    builder.defs.append(pattern);
    group.append(el(builder, "rect", { ...rectAttributes(rect), fill: `url(#${patternId})` }));
  }
  parent.append(group);
}

export function appendMosaicSvg(container: SVGGElement, scene: MosaicScene, progress: number): void {
  const doc = container.ownerDocument;
  const defs = doc.createElementNS(SVG_NS, "defs");
  let counter = 0;
  const builder: Builder = { defs, doc, nextId: (prefix) => `${prefix}-${(counter += 1)}` };
  const cellsGroup = el(builder, "g", { "data-mosaic-cells": "true" });
  container.append(defs, cellsGroup);
  const { fill } = scene.params;

  for (const index of visibleCells(scene)) {
    const rect = scene.cells[index]!;
    const style = scene.styles[index];
    if (!style) continue;
    const frame = evaluateCell(rect, style, scene.params, progress);
    if (frame.fill === "dither") {
      appendDitherCell(builder, cellsGroup, frame, fill.ditherScale);
    } else if (isPatternFill(frame.fill)) {
      appendPatternCell(builder, cellsGroup, frame, fill);
    } else {
      const paint = frame.fill === "gradient" ? gradientFill(builder, frame) : rgbToHex(frame.a);
      cellsGroup.append(el(builder, "rect", { ...rectAttributes(rect), "data-mosaic-fill": frame.fill, fill: paint }));
    }
  }
}
