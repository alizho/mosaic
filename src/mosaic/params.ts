/** Typed view over runtime values. Pure: shared by preview, export, SVG and GIF. */

import { parseHex, resolvePalette, type Rgb } from "./palettes";

export type GradientKind = "linear" | "radial";
export type GradientTypeSetting = GradientKind | "mixed";
export type DitherPatternId = "bayer" | "fs" | "random";
export type LineAxis = "horizontal" | "vertical";
export type ScanlineDirection = LineAxis | "mixed";
export type DotGrid = "square" | "staggered";
export type FrameMode = "none" | "erosion" | "explosion";

export type LayoutParams = Readonly<{
  density: number;
  /** Cell height limits in canvas pixels (ignored when `square`). */
  maxHeight: number;
  maxWidth: number;
  minHeight: number;
  minWidth: number;
  seed: number;
  snap: number;
  splitBias: number;
  /** 1:1 aspect lock: every cell is a square sized by the width limits. */
  square: boolean;
  varianceX: number;
  varianceY: number;
}>;

export type FillParams = Readonly<{
  /** Glyph tiled by ASCII cells (one character). */
  asciiChar: string;
  /** Monospace glyph size (font size and row pitch) in canvas pixels. */
  asciiSize: number;
  asciiWeight: number;
  ditherPattern: DitherPatternId;
  ditherScale: number;
  ditherWeight: number;
  /** Dot diameter as a fraction of the dot spacing. */
  dotSize: number;
  dotSpacing: number;
  dotGrid: DotGrid;
  dotsWeight: number;
  gradientType: GradientTypeSetting;
  gradientWeight: number;
  scanlineDirection: ScanlineDirection;
  scanlineSpacing: number;
  /** 0 = flat digital stripes; 1 = strongly varied print texture (thickness, opacity, ragged edges). */
  scanlineTexture: number;
  /** Line thickness as a fraction of the line period. */
  scanlineThickness: number;
  scanlinesWeight: number;
  solidWeight: number;
}>;

export type MotionParams = Readonly<{
  /** How far gradient stop colors breathe toward their target hues (0..1). */
  colorBreath: number;
  /** Whole pattern periods dither, scanline and dot lattices shift per loop. */
  ditherScroll: number;
  drift: number;
  /** Palette hues each gradient stop visits per loop. */
  hueSteps: number;
}>;

/** Grain integrated into gradient cells only. */
export type GrainParams = Readonly<{
  amount: number;
  /** 0 = soft, blurred mottling; 1 = crisp, quantized particle screen. */
  discreteness: number;
  enabled: boolean;
  size: number;
  /** Whole twinkle cycles per loop for each grain speck (integer keeps loops seamless). */
  speed: number;
}>;

export type FrameParams = Readonly<{
  /** Erosion: fraction (0..1) of perimeter cells pruned. */
  edgeRemoval: number;
  /** Explosion: fraction (0..1) of cells anywhere in the grid deleted. */
  explosionAmount: number;
  /** Always "none" in Infinity mode, where the field is unbounded. */
  mode: FrameMode;
}>;

export type MosaicParams = Readonly<{
  /** Background color showing through empty pattern ground; null when Background is off. */
  background: Rgb | null;
  fill: FillParams;
  frame: FrameParams;
  grain: GrainParams;
  layout: LayoutParams;
  motion: MotionParams;
  palette: readonly Rgb[];
}>;

/** Canonical runtime values this product reads: scalars and scalar lists. */
type ValueInput = string | number | boolean | null | undefined | readonly (string | number)[];
type Values = Readonly<Record<string, ValueInput>>;

function num(value: ValueInput, fallback: number, min = -Infinity, max = Infinity): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(value: ValueInput, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function choice<T extends string>(value: ValueInput, options: readonly T[], fallback: T): T {
  const text = typeof value === "string" ? value : "";
  return options.find((option) => option === text) ?? fallback;
}

function range(value: ValueInput, fallback: readonly [number, number]): [number, number] {
  if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number") {
    const low = Math.max(4, Math.min(value[0], value[1]));
    const high = Math.max(low, value[0], value[1]);
    return [low, high];
  }
  return [fallback[0], fallback[1]];
}

/** First visible character (whole grapheme, so emoji and accents survive); fallback when blank. */
function firstCharacter(value: ValueInput, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) return segment;
  return fallback;
}

function stringList(value: ValueInput): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export type MosaicReadOptions = Readonly<{
  /** False in Infinity mode, where the field is unbounded and framing modes are off. */
  bounded?: boolean;
}>;

export function readMosaicParams(
  runtimeValues: Readonly<Record<string, unknown>>,
  options: MosaicReadOptions = {},
): MosaicParams {
  const values = runtimeValues as Values;
  // `layout.cellSize` is the pre-split shared range; it seeds both axes for old states.
  const legacySize = values["layout.cellSize"];
  const square = bool(values["layout.square"], false);
  const [minWidth, maxWidth] = range(values["layout.cellWidth"] ?? legacySize, [160, 720]);
  const [minHeight, maxHeight] = square ? [minWidth, maxWidth] : range(values["layout.cellHeight"] ?? legacySize, [160, 720]);
  const solid = bool(values["fill.solid"], true);
  const gradient = bool(values["fill.gradient"], true);
  const dither = bool(values["fill.dither"], true);
  const scanlines = bool(values["fill.scanlines"], false);
  const dots = bool(values["fill.dots"], false);
  const ascii = bool(values["fill.ascii"], false);
  const anyFill = solid || gradient || dither || scanlines || dots || ascii;
  const bounded = options.bounded ?? true;
  const frameMode = bounded ? choice<FrameMode>(values["frame.mode"], ["none", "erosion", "explosion"], "none") : "none";

  return {
    background:
      values["export.includeBackground"] === false
        ? null
        : parseHex(typeof values["appearance.background"] === "string" ? values["appearance.background"] : "#FFFFFF"),
    fill: {
      asciiChar: firstCharacter(values["fill.asciiChar"], "*"),
      asciiSize: num(values["fill.asciiSize"], 24, 4, 400),
      asciiWeight: ascii ? num(values["fill.asciiWeight"], 1, 0, 10) : 0,
      ditherPattern: choice(values["fill.ditherPattern"], ["bayer", "fs", "random"], "bayer"),
      ditherScale: num(values["fill.ditherScale"], 4, 1, 64),
      ditherWeight: dither ? num(values["fill.ditherWeight"], 0.6, 0, 10) : 0,
      dotGrid: choice(values["fill.dotGrid"], ["square", "staggered"], "square"),
      dotSize: num(values["fill.dotSize"], 60, 5, 100) / 100,
      dotSpacing: num(values["fill.dotSpacing"], 16, 2, 400),
      dotsWeight: dots ? num(values["fill.dotsWeight"], 1, 0, 10) : 0,
      gradientType: choice(values["fill.gradientType"], ["linear", "radial", "mixed"], "mixed"),
      gradientWeight: gradient ? num(values["fill.gradientWeight"], 4, 0, 10) : 0,
      scanlineDirection: choice(values["fill.scanlineDirection"], ["horizontal", "vertical", "mixed"], "horizontal"),
      scanlineSpacing: num(values["fill.scanlineSpacing"], 12, 2, 400),
      scanlineTexture: num(values["fill.scanlineTexture"], 60, 0, 100) / 100,
      scanlineThickness: num(values["fill.scanlineThickness"], 50, 5, 95) / 100,
      scanlinesWeight: scanlines ? num(values["fill.scanlinesWeight"], 1, 0, 10) : 0,
      // With every mode switched off, fall back to solids instead of an empty mosaic.
      solidWeight: solid ? num(values["fill.solidWeight"], 1, 0, 10) : anyFill ? 0 : 1,
    },
    frame: {
      edgeRemoval: frameMode === "erosion" ? num(values["frame.edgeRemoval"], 40, 0, 100) / 100 : 0,
      explosionAmount: frameMode === "explosion" ? num(values["frame.explosionAmount"], 25, 0, 100) / 100 : 0,
      mode: frameMode,
    },
    grain: {
      amount: num(values["grain.amount"], 0.5, 0, 1),
      discreteness: num(values["grain.discreteness"], 0.85, 0, 1),
      enabled: bool(values["grain.gradient"], true),
      size: num(values["grain.size"], 1, 0.25, 32),
      speed: Math.round(num(values["grain.speed"], 2, 0, 12)),
    },
    layout: {
      density: num(values["layout.density"], 0.6, 0, 1),
      maxHeight,
      maxWidth,
      minHeight,
      minWidth,
      seed: Math.round(num(values["layout.seed"], 7, 0, 1e9)),
      snap: num(values["layout.snap"], 0, 0, 2000),
      splitBias: num(values["layout.splitBias"], 0, -1, 1),
      square,
      varianceX: num(values["layout.varianceX"], 0.6, 0, 1),
      varianceY: num(values["layout.varianceY"], 0.6, 0, 1),
    },
    motion: {
      ditherScroll: Math.round(num(values["motion.ditherScroll"], 1, -16, 16)),
      drift: num(values["motion.drift"], 0.5, 0, 1),
      colorBreath: num(values["motion.colorBreath"], 0.6, 0, 1),
      hueSteps: Math.round(num(values["motion.hueSteps"], 1, 1, 6)),
    },
    palette: resolvePalette(stringList(values["palette.colors"])),
  };
}
