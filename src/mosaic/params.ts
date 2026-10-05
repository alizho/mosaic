/** Typed view over runtime values. Pure: shared by preview, export, SVG and GIF. */

import { resolvePalette, type Rgb } from "./palettes";

export type GradientKind = "linear" | "radial";
export type GradientTypeSetting = GradientKind | "mixed";
export type DitherPatternId = "bayer" | "fs" | "random";

export type LayoutParams = Readonly<{
  density: number;
  maxCell: number;
  minCell: number;
  seed: number;
  snap: number;
  splitBias: number;
  varianceX: number;
  varianceY: number;
}>;

export type FillParams = Readonly<{
  ditherPattern: DitherPatternId;
  ditherScale: number;
  ditherWeight: number;
  gradientType: GradientTypeSetting;
  gradientWeight: number;
  solidWeight: number;
}>;

export type MotionParams = Readonly<{
  /** How far gradient stop colors breathe toward their target hues (0..1). */
  colorBreath: number;
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
  /** Which fill modes receive grain. */
  onDither: boolean;
  onGradient: boolean;
  size: number;
  /** Whole twinkle cycles per loop for each grain speck (integer keeps loops seamless). */
  speed: number;
}>;

export type FrameParams = Readonly<{
  /** Fraction (0..1) of perimeter cells pruned; 0 when not exploding or unbounded. */
  edgeRemoval: number;
}>;

export type MosaicParams = Readonly<{
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

function stringList(value: ValueInput): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export type MosaicReadOptions = Readonly<{
  /** False in Infinity mode, where the field is unbounded and edges never explode. */
  bounded?: boolean;
}>;

export function readMosaicParams(
  runtimeValues: Readonly<Record<string, unknown>>,
  options: MosaicReadOptions = {},
): MosaicParams {
  const values = runtimeValues as Values;
  const [minCell, maxCell] = range(values["layout.cellSize"], [160, 720]);
  const solid = bool(values["fill.solid"], true);
  const gradient = bool(values["fill.gradient"], true);
  const dither = bool(values["fill.dither"], true);
  const anyFill = solid || gradient || dither;

  return {
    fill: {
      ditherPattern: choice(values["fill.ditherPattern"], ["bayer", "fs", "random"], "bayer"),
      ditherScale: num(values["fill.ditherScale"], 4, 1, 64),
      ditherWeight: dither ? num(values["fill.ditherWeight"], 0.6, 0, 10) : 0,
      gradientType: choice(values["fill.gradientType"], ["linear", "radial", "mixed"], "mixed"),
      gradientWeight: gradient ? num(values["fill.gradientWeight"], 4, 0, 10) : 0,
      // With every mode switched off, fall back to solids instead of an empty mosaic.
      solidWeight: solid ? num(values["fill.solidWeight"], 1, 0, 10) : anyFill ? 0 : 1,
    },
    frame: {
      edgeRemoval:
        (options.bounded ?? true) && bool(values["frame.explode"], false)
          ? num(values["frame.edgeRemoval"], 40, 0, 100) / 100
          : 0,
    },
    grain: {
      amount: num(values["grain.amount"], 0.5, 0, 1),
      discreteness: num(values["grain.discreteness"], 0.85, 0, 1),
      onDither: bool(values["grain.dither"], true),
      onGradient: bool(values["grain.gradient"], true),
      size: num(values["grain.size"], 1, 0.25, 32),
      speed: Math.round(num(values["grain.speed"], 2, 0, 12)),
    },
    layout: {
      density: num(values["layout.density"], 0.6, 0, 1),
      maxCell,
      minCell,
      seed: Math.round(num(values["layout.seed"], 7, 0, 1e9)),
      snap: num(values["layout.snap"], 0, 0, 2000),
      splitBias: num(values["layout.splitBias"], 0, -1, 1),
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
