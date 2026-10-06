import { describe, expect, it } from "vitest";

import { createCellStyles, evaluateCell, gradientParam, isCellPruned, touchesFrame, unwarpParam, warpParam } from "./cells";
import { isCellExploded, visibleCells } from "./framing";
import { BAYER_MATRIX, computeDitherMask } from "./dither";
import { encodeGif } from "./gif-encoder";
import { readMosaicParams } from "./params";
import { scanlineStrokes } from "./pattern-texture";
import { buildMosaicScene } from "./scene";
import { isFeasibleLength, tessellate, type Rect } from "./tessellate";

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
      "layout.cellHeight": [100, 500],
      "layout.cellWidth": [100, 500],
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
    const params = readMosaicParams({ "layout.cellHeight": [80, 300], "layout.cellWidth": [80, 300], "layout.density": 0, "layout.seed": 5 });
    for (const cell of tessellate(ROOT, params.layout)) {
      expect(cell.width <= 300 || cell.width < 160).toBe(true);
      expect(cell.height <= 300 || cell.height < 160).toBe(true);
    }
  });

  it("snaps internal cuts to the module grid", () => {
    const params = readMosaicParams({ "layout.cellHeight": [120, 480], "layout.cellWidth": [120, 480], "layout.seed": 9, "layout.snap": 120 });
    for (const cell of tessellate(ROOT, params.layout)) {
      expect(((cell.x - ROOT.x) / 120) % 1).toBeCloseTo(0, 9);
      expect(((cell.y - ROOT.y) / 120) % 1).toBeCloseTo(0, 9);
    }
  });

  function expectTiling(cells: readonly Rect[], root: Rect) {
    const area = cells.reduce((sum, cell) => sum + cell.width * cell.height, 0);
    expect(area).toBeCloseTo(root.width * root.height, 4);
    for (let i = 0; i < cells.length; i += 1) {
      for (let j = i + 1; j < cells.length; j += 1) expect(overlapArea(cells[i]!, cells[j]!)).toBeLessThan(1e-6);
    }
  }

  it.each([1, 2, 3, 4, 5, 6])("keeps independent width and height limits on every cell (seed %i)", (seed) => {
    const params = readMosaicParams({
      "layout.cellHeight": [150, 260],
      "layout.cellWidth": [100, 300],
      "layout.density": 0.8,
      "layout.seed": seed,
    });
    const cells = tessellate(ROOT, params.layout);
    expectTiling(cells, ROOT);
    for (const cell of cells) {
      expect(cell.width).toBeGreaterThanOrEqual(100 - 1e-6);
      expect(cell.width).toBeLessThanOrEqual(300 + 1e-6);
      expect(cell.height).toBeGreaterThanOrEqual(150 - 1e-6);
      expect(cell.height).toBeLessThanOrEqual(260 + 1e-6);
    }
  });

  it("forces elongated horizontal strips from a narrow height and wide width range", () => {
    const portrait: Rect = { height: 1920, width: 1080, x: -540, y: -960 };
    const params = readMosaicParams({ "layout.cellHeight": [40, 120], "layout.cellWidth": [500, 1080], "layout.seed": 4 });
    const cells = tessellate(portrait, params.layout);
    expectTiling(cells, portrait);
    for (const cell of cells) {
      expect(cell.height).toBeLessThanOrEqual(120 + 1e-6);
      expect(cell.width).toBeGreaterThanOrEqual(500 - 1e-6);
      expect(cell.width / cell.height).toBeGreaterThan(4);
    }
  });

  it("detects lengths no whole number of pieces can fill", () => {
    expect(isFeasibleLength(1920, { hi: 600, lo: 500 })).toBe(false);
    expect(isFeasibleLength(1800, { hi: 600, lo: 500 })).toBe(true);
    expect(isFeasibleLength(5000, { hi: 120, lo: 100 })).toBe(true);
  });

  it("falls back to minimum-only cuts when the artboard cannot satisfy the limits", () => {
    const params = readMosaicParams({ "layout.cellHeight": [500, 600], "layout.cellWidth": [500, 600], "layout.seed": 2 });
    const cells = tessellate({ height: 1920, width: 1920, x: 0, y: 0 }, params.layout);
    expectTiling(cells, { height: 1920, width: 1920, x: 0, y: 0 });
    for (const cell of cells) expect(Math.min(cell.width, cell.height)).toBeGreaterThanOrEqual(500 - 1e-6);
  });

  it.each([0, 0.5, 1])("packs strictly square cells with the 1:1 lock (density %d)", (density) => {
    const params = readMosaicParams({
      "layout.cellHeight": [16, 1600],
      "layout.cellWidth": [120, 480],
      "layout.density": density,
      "layout.square": true,
      "layout.seed": 13,
    });
    expect(params.layout.minHeight).toBe(120);
    expect(params.layout.maxHeight).toBe(480);
    const cells = tessellate(ROOT, params.layout);
    expectTiling(cells, ROOT);
    for (const cell of cells) {
      expect(cell.width).toBeCloseTo(cell.height, 6);
      expect(cell.width).toBeGreaterThanOrEqual(120 - 1e-6);
      expect(cell.width).toBeLessThanOrEqual(480 + 1e-6);
    }
    if (density === 0) expect(cells.some((cell) => cell.width > 120 + 1e-6)).toBe(true);
  });

  it("chooses an exact square module when the minimum does not divide the artboard", () => {
    const portrait: Rect = { height: 1920, width: 1080, x: -540, y: -960 };
    const params = readMosaicParams({ "layout.cellWidth": [111, 794], "layout.square": true });
    const cells = tessellate(portrait, params.layout);
    expectTiling(cells, portrait);
    for (const cell of cells) {
      expect(cell.width).toBeCloseTo(cell.height, 6);
      expect(cell.width).toBeGreaterThanOrEqual(111);
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

describe("erosion", () => {
  const params = readMosaicParams({ "frame.edgeRemoval": 60, "frame.mode": "erosion" });
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
    expect(visibleCells(scene).length).toBe(scene.cells.length - pruned(0.6).filter(Boolean).length);
  });

  it("is disabled unless the mode is selected and the canvas is bounded", () => {
    expect(params.frame.edgeRemoval).toBeCloseTo(0.6);
    expect(readMosaicParams({ "frame.edgeRemoval": 60, "frame.mode": "none" }).frame.edgeRemoval).toBe(0);
    expect(readMosaicParams({ "frame.edgeRemoval": 60, "frame.mode": "explosion" }).frame.edgeRemoval).toBe(0);
    expect(readMosaicParams({ "frame.edgeRemoval": 60, "frame.mode": "erosion" }, { bounded: false }).frame.mode).toBe("none");
  });
});

describe("explosion", () => {
  const explode = (amount: number) =>
    buildMosaicScene(ROOT, readMosaicParams({ "frame.explosionAmount": amount, "frame.mode": "explosion", "layout.seed": 31 }));

  it("deletes random cells anywhere, monotonically in the amount, without moving the rest", () => {
    const scene = explode(40);
    const deleted = (amount: number) => scene.cells.map((_, index) => isCellExploded(scene.seed, index, amount));
    const low = deleted(0.2);
    const high = deleted(0.6);
    low.forEach((gone, index) => {
      if (gone) expect(high[index]).toBe(true);
    });
    expect(deleted(0).some(Boolean)).toBe(false);
    expect(deleted(1).every(Boolean)).toBe(true);
    // Interior cells are eligible, unlike Erosion.
    expect(scene.cells.some((rect, index) => high[index] && !touchesFrame(rect, ROOT))).toBe(true);

    const visible = visibleCells(scene);
    expect(visible.length).toBe(deleted(0.4).filter((gone) => !gone).length);
    expect(visible.length).toBeLessThan(scene.cells.length);
    expect(scene.cells).toEqual(explode(0).cells);
  });

  it("is off outside Explosion mode and on unbounded canvases", () => {
    expect(readMosaicParams({ "frame.explosionAmount": 50, "frame.mode": "erosion" }).frame.explosionAmount).toBe(0);
    expect(readMosaicParams({ "frame.explosionAmount": 50, "frame.mode": "explosion" }, { bounded: false }).frame.explosionAmount).toBe(0);
    expect(readMosaicParams({ "frame.explosionAmount": 50, "frame.mode": "explosion" }).frame.edgeRemoval).toBe(0);
  });
});

describe("pattern fills", () => {
  it("assigns scanline and dot cells only when enabled, with per-cell axes in mixed mode", () => {
    const off = buildMosaicScene(ROOT, readMosaicParams({}));
    expect(off.styles.some((style) => style.fill === "scanlines" || style.fill === "dots")).toBe(false);
    const params = readMosaicParams({
      "fill.dither": false,
      "fill.dots": true,
      "fill.gradient": false,
      "fill.scanlineDirection": "mixed",
      "fill.scanlines": true,
      "fill.solid": false,
      "layout.cellHeight": [80, 200],
      "layout.cellWidth": [80, 200],
    });
    const scene = buildMosaicScene(ROOT, params);
    expect(new Set(scene.styles.map((style) => style.fill))).toEqual(new Set(["scanlines", "dots"]));
    expect(new Set(scene.styles.map((style) => style.lineAxis))).toEqual(new Set(["horizontal", "vertical"]));
  });

  it("gives pattern cells one ink that stands out from the Background", () => {
    const values = {
      "fill.ascii": true,
      "fill.dither": false,
      "fill.dots": true,
      "fill.gradient": false,
      "fill.scanlines": true,
      "fill.solid": false,
      "layout.cellHeight": [80, 200],
      "layout.cellWidth": [80, 200],
      "palette.colors": ["#FFFFFF", "#0000FF", "#FFFFFE", "#000000"],
    };
    const onWhite = buildMosaicScene(ROOT, readMosaicParams({ ...values, "appearance.background": "#FFFFFF" }));
    expect(new Set(onWhite.styles.map((style) => style.fill))).toEqual(new Set(["scanlines", "dots", "ascii"]));
    expect(new Set(onWhite.styles.map((style) => style.colorInk))).toEqual(new Set([1, 3]));
    onWhite.styles.forEach((style) => {
      if (style.colorA === 1 || style.colorA === 3) expect(style.colorInk).toBe(style.colorA);
    });
    // Without a visible Background any palette color may ink.
    const transparent = buildMosaicScene(ROOT, readMosaicParams({ ...values, "export.includeBackground": false }));
    transparent.styles.forEach((style) => expect(style.colorInk).toBe(style.colorA));
  });

  it("reads one ASCII character, keeping whole graphemes", () => {
    expect(readMosaicParams({ "fill.asciiChar": "#abc" }).fill.asciiChar).toBe("#");
    expect(readMosaicParams({ "fill.asciiChar": "  " }).fill.asciiChar).toBe("*");
    expect(readMosaicParams({ "fill.asciiChar": "👍🏽x" }).fill.asciiChar).toBe("👍🏽");
  });

  it("textures scanline strokes in thickness and opacity, and stays flat at zero texture", () => {
    const cell: Rect = { height: 300, width: 600, x: 0, y: 0 };
    const widths = (stroke: { points: readonly (readonly [number, number])[] }) => {
      const half = stroke.points.length / 2;
      return stroke.points.slice(0, half).map(([, y], i) => stroke.points[stroke.points.length - 1 - i]![1] - y);
    };
    const flat = scanlineStrokes(cell, cell, false, 0, { scanlineSpacing: 12, scanlineTexture: 0, scanlineThickness: 0.5 });
    for (const stroke of flat) {
      expect(stroke.opacity).toBe(1);
      for (const width of widths(stroke)) expect(width).toBeCloseTo(6, 9);
    }
    // Strokes cover the whole cell height.
    expect(flat.length).toBeGreaterThanOrEqual(300 / 12);

    const organic = scanlineStrokes(cell, cell, false, 0, { scanlineSpacing: 12, scanlineTexture: 1, scanlineThickness: 0.5 });
    const along = widths(organic[5]!);
    expect(Math.max(...along) - Math.min(...along)).toBeGreaterThan(1);
    const opacities = organic.map((stroke) => stroke.opacity);
    expect(Math.max(...opacities) - Math.min(...opacities)).toBeGreaterThan(0.05);
    expect(Math.min(...opacities)).toBeGreaterThanOrEqual(0.4);
  });

  it("keeps grain on gradients only", () => {
    const params = readMosaicParams({ "grain.dither": true, "grain.gradient": false });
    expect(params.grain).not.toHaveProperty("onDither");
    expect(params.grain.enabled).toBe(false);
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
      "layout.cellHeight": [300, 600],
      "layout.cellWidth": [300, 600],
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
