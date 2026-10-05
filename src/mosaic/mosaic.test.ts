import { describe, expect, it } from "vitest";

import { createCellStyles, evaluateCell, gradientParam, isCellPruned, touchesFrame, unwarpParam, warpParam } from "./cells";
import { BAYER_MATRIX, computeDitherMask } from "./dither";
import { encodeGif } from "./gif-encoder";
import { readMosaicParams } from "./params";
import { buildMosaicScene } from "./scene";
import { tessellate, type Rect } from "./tessellate";

const ROOT: Rect = { height: 1080, width: 1920, x: -960, y: -540 };

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

describe("tessellate", () => {
  const cases = [
    { seed: 7 },
    { seed: 744, snap: 120 },
    { density: 1, seed: 3, splitBias: 1 },
    { density: 0.2, seed: 11, splitBias: -1, varianceX: 0, varianceY: 1 },
  ];

  it.each(cases)("tiles the root with zero gaps, no overlap and flush edges (%o)", (overrides) => {
    const params = readMosaicParams({
      "layout.cellSize": [100, 500],
      "layout.density": overrides.density ?? 0.6,
      "layout.seed": overrides.seed,
      "layout.snap": overrides.snap ?? 0,
      "layout.splitBias": overrides.splitBias ?? 0,
      "layout.varianceX": overrides.varianceX ?? 0.6,
      "layout.varianceY": overrides.varianceY ?? 0.6,
    });
    const cells = tessellate(ROOT, params.layout);
    const area = cells.reduce((sum, cell) => sum + cell.width * cell.height, 0);
    expect(area).toBeCloseTo(ROOT.width * ROOT.height, 6);
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i]!;
      expect(cell.x).toBeGreaterThanOrEqual(ROOT.x);
      expect(cell.y).toBeGreaterThanOrEqual(ROOT.y);
      expect(cell.x + cell.width).toBeLessThanOrEqual(ROOT.x + ROOT.width + 1e-9);
      expect(cell.y + cell.height).toBeLessThanOrEqual(ROOT.y + ROOT.height + 1e-9);
      expect(Math.min(cell.width, cell.height)).toBeGreaterThanOrEqual(100 - 1e-9);
      for (let j = i + 1; j < cells.length; j += 1) expect(overlapArea(cell, cells[j]!)).toBe(0);
    }
  });

  it("splits every cell larger than the maximum size", () => {
    const params = readMosaicParams({ "layout.cellSize": [80, 300], "layout.density": 0, "layout.seed": 5 });
    for (const cell of tessellate(ROOT, params.layout)) {
      expect(cell.width <= 300 || cell.width < 160).toBe(true);
      expect(cell.height <= 300 || cell.height < 160).toBe(true);
    }
  });

  it("snaps internal cuts to the module grid", () => {
    const params = readMosaicParams({ "layout.cellSize": [120, 480], "layout.seed": 9, "layout.snap": 120 });
    for (const cell of tessellate(ROOT, params.layout)) {
      expect(((cell.x - ROOT.x) / 120) % 1).toBeCloseTo(0, 9);
      expect(((cell.y - ROOT.y) / 120) % 1).toBeCloseTo(0, 9);
    }
  });

  it("is deterministic per seed and varies across seeds", () => {
    const params = readMosaicParams({});
    expect(tessellate(ROOT, params.layout, 21)).toEqual(tessellate(ROOT, params.layout, 21));
    expect(tessellate(ROOT, params.layout, 21)).not.toEqual(tessellate(ROOT, params.layout, 22));
  });
});

describe("cell substrates", () => {
  it("loops seamlessly: progress 0 and 1 evaluate identically", () => {
    const params = readMosaicParams({ "motion.colorBreath": 1, "motion.ditherScroll": 3, "motion.drift": 1, "motion.hueSteps": 3 });
    const scene = buildMosaicScene(ROOT, params);
    scene.cells.forEach((rect, index) => {
      const start = evaluateCell(rect, scene.styles[index]!, params, 0);
      const end = evaluateCell(rect, scene.styles[index]!, params, 1);
      expect(end.a.map((v, c) => v - start.a[c]!).every((d) => Math.abs(d) < 1e-6)).toBe(true);
      expect(end.b.map((v, c) => v - start.b[c]!).every((d) => Math.abs(d) < 1e-6)).toBe(true);
      expect(end.mid).toBeCloseTo(start.mid, 9);
      if (start.gradient.kind === "linear" && end.gradient.kind === "linear") {
        expect(end.gradient.x0).toBeCloseTo(start.gradient.x0, 6);
        expect(end.gradient.y1).toBeCloseTo(start.gradient.y1, 6);
      }
    });
  });

  it("breathes gradient colors continuously without snaps, and never rotates", () => {
    const params = readMosaicParams({ "fill.dither": false, "fill.solid": false, "motion.colorBreath": 1, "motion.hueSteps": 4 });
    const scene = buildMosaicScene(ROOT, params);
    const rect = scene.cells[0]!;
    const style = scene.styles[0]!;
    let maxStep = 0;
    let previous = evaluateCell(rect, style, params, 0);
    for (let i = 1; i <= 2000; i += 1) {
      const frame = evaluateCell(rect, style, params, i / 2000);
      maxStep = Math.max(maxStep, ...frame.a.map((v, c) => Math.abs(v - previous.a[c]!)));
      if (frame.gradient.kind === "linear" && previous.gradient.kind === "linear") {
        const angle = (g: typeof frame.gradient & { kind: "linear" }) => Math.atan2(g.y1 - g.y0, g.x1 - g.x0);
        expect(angle(frame.gradient)).toBeCloseTo(angle(previous.gradient), 9);
      }
      previous = frame;
    }
    // A 2000-step tour through 5 hues moves under ~3/255 per step: no hard cuts.
    expect(maxStep).toBeLessThan(3);
  });

  it("keeps solid and dither colors static", () => {
    const params = readMosaicParams({ "fill.gradient": false, "motion.colorBreath": 1 });
    const scene = buildMosaicScene(ROOT, params);
    scene.cells.forEach((rect, index) => {
      expect(evaluateCell(rect, scene.styles[index]!, params, 0.31).a).toEqual(evaluateCell(rect, scene.styles[index]!, params, 0).a);
    });
  });

  it("only uses enabled fill modes", () => {
    const params = readMosaicParams({ "fill.dither": false, "fill.gradient": false });
    const cells = tessellate(ROOT, params.layout);
    const styles = createCellStyles(cells, 1, params.fill, params.palette);
    expect(new Set(styles.map((style) => style.fill))).toEqual(new Set(["solid"]));
  });

  it("falls back to solids when every fill mode is off", () => {
    const params = readMosaicParams({ "fill.dither": false, "fill.gradient": false, "fill.solid": false });
    expect(params.fill.solidWeight).toBeGreaterThan(0);
  });

  it("inverts the midpoint warp", () => {
    for (const mid of [0.2, 0.5, 0.83]) {
      for (const t of [0, 0.1, 0.5, 0.77, 1]) expect(unwarpParam(warpParam(t, mid), mid)).toBeCloseTo(t, 9);
    }
  });
});

describe("explode edges", () => {
  const params = readMosaicParams({ "frame.edgeRemoval": 60, "frame.explode": true });
  const scene = buildMosaicScene(ROOT, params);
  const pruned = (amount: number) =>
    scene.cells.map((rect, index) => isCellPruned(rect, ROOT, scene.seed, index, amount));

  it("only ever prunes perimeter cells, monotonically in the amount", () => {
    const low = pruned(0.3);
    const high = pruned(0.8);
    scene.cells.forEach((rect, index) => {
      if (!touchesFrame(rect, ROOT)) expect(high[index]).toBe(false);
      if (low[index]) expect(high[index]).toBe(true);
    });
    expect(pruned(0).some(Boolean)).toBe(false);
    const perimeter = scene.cells.filter((rect) => touchesFrame(rect, ROOT)).length;
    expect(pruned(1).filter(Boolean).length).toBe(perimeter);
  });

  it("is disabled unless the toggle is on and the canvas is bounded", () => {
    expect(params.frame.edgeRemoval).toBeCloseTo(0.6);
    expect(readMosaicParams({ "frame.edgeRemoval": 60, "frame.explode": false }).frame.edgeRemoval).toBe(0);
    expect(readMosaicParams({ "frame.edgeRemoval": 60, "frame.explode": true }, { bounded: false }).frame.edgeRemoval).toBe(0);
  });
});

describe("dither modes", () => {
  it("uses a permutation for the 8x8 Bayer ranks", () => {
    expect([...BAYER_MATRIX.ranks].sort((a, b) => a - b)).toEqual(BAYER_MATRIX.ranks.map((_, index) => index));
    expect(BAYER_MATRIX.ranks.length).toBe(64);
  });

  const ditherScene = (pattern: string, scroll = 2) => {
    const params = readMosaicParams({
      "fill.ditherPattern": pattern,
      "fill.gradient": false,
      "fill.solid": false,
      "layout.cellSize": [300, 600],
      "motion.ditherScroll": scroll,
    });
    return { params, scene: buildMosaicScene(ROOT, params) };
  };

  it.each(["bayer", "fs", "random"])("%s preserves average tone and loops seamlessly", (pattern) => {
    const { params, scene } = ditherScene(pattern);
    const rect = scene.cells[0]!;
    const start = evaluateCell(rect, scene.styles[0]!, params, 0);
    const mask = computeDitherMask(start, 4, rect);
    const coverage = mask.data.reduce((sum, value) => sum + value, 0) / mask.data.length;
    // Mean warped tone over the dot centers.
    let tone = 0;
    for (let row = 0; row < mask.rows; row += 1) {
      for (let column = 0; column < mask.columns; column += 1) {
        tone += warpParam(gradientParam(start.gradient, rect.x + (column + 0.5) * 4, rect.y + (row + 0.5) * 4), start.mid);
      }
    }
    expect(coverage).toBeCloseTo(tone / mask.data.length, 1);
    const end = evaluateCell(rect, scene.styles[0]!, params, 1);
    expect(computeDitherMask(end, 4, rect).data).toEqual(mask.data);
  });
});

/** Minimal GIF LZW decoder for round-trip verification. */
function decodeFirstFrameIndices(bytes: Uint8Array, pixelCount: number): number[] {
  let offset = 13 + 256 * 3;
  while (bytes[offset] === 0x21) {
    offset += 2;
    while (bytes[offset]! > 0) offset += bytes[offset]! + 1;
    offset += 1;
  }
  expect(bytes[offset]).toBe(0x2c);
  offset += 10;
  const minCodeSize = bytes[offset++]!;
  const data: number[] = [];
  while (bytes[offset]! > 0) {
    const size = bytes[offset++]!;
    data.push(...bytes.slice(offset, offset + size));
    offset += size;
  }
  const clear = 1 << minCodeSize;
  let codeSize = minCodeSize + 1;
  let dictionary: number[][] = [];
  const reset = () => {
    dictionary = Array.from({ length: clear + 2 }, (_, index) => [index]);
    codeSize = minCodeSize + 1;
  };
  reset();
  const output: number[] = [];
  let bit = 0;
  let previous: number[] | null = null;
  while (output.length < pixelCount) {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1, bit += 1) code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << i;
    if (code === clear) {
      reset();
      previous = null;
      continue;
    }
    if (code === clear + 1) break;
    const entry: number[] = dictionary[code] ?? [...previous!, previous![0]!];
    output.push(...entry);
    if (previous) dictionary.push([...previous, entry[0]!]);
    if (dictionary.length === 1 << codeSize && codeSize < 12) codeSize += 1;
    previous = entry;
  }
  return output;
}

describe("gif encoder", () => {
  it("writes a looping GIF89a whose LZW stream round-trips", async () => {
    const width = 37;
    const height = 23;
    const frame = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      frame[pixel * 4] = (pixel * 37) % 256;
      frame[pixel * 4 + 1] = (pixel * 11) % 256;
      frame[pixel * 4 + 2] = pixel % 7 === 0 ? 255 : 0;
      frame[pixel * 4 + 3] = 255;
    }
    const bytes = await encodeGif({ fps: 12, frames: [frame, frame], height, width });
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe("GIF89a");
    expect(bytes[bytes.length - 1]).toBe(0x3b);
    expect(new TextDecoder().decode(bytes.slice(13 + 768 + 3, 13 + 768 + 14))).toBe("NETSCAPE2.0");

    const indices = decodeFirstFrameIndices(bytes, width * height);
    expect(indices).toHaveLength(width * height);
    const palette = bytes.slice(13, 13 + 768);
    // Every decoded pixel maps back to a palette color near its source.
    indices.forEach((index, pixel) => {
      expect(Math.abs(palette[index * 3]! - frame[pixel * 4]!)).toBeLessThan(48);
    });
  });

  it("maps transparent pixels to a reserved transparent index", async () => {
    const width = 8;
    const height = 4;
    const frame = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const opaque = pixel % 2 === 0;
      frame.set(opaque ? [200, 30, 90, 255] : [0, 0, 0, 0], pixel * 4);
    }
    const bytes = await encodeGif({ fps: 10, frames: [frame], height, width });
    const gce = bytes.indexOf(0xf9, 13 + 768);
    expect(bytes[gce + 2]! & 1).toBe(1);
    expect(bytes[gce + 5]).toBe(255);
    const indices = decodeFirstFrameIndices(bytes, width * height);
    indices.forEach((index, pixel) => expect(index === 255).toBe(pixel % 2 === 1));
  });
});
