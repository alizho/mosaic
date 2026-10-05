/**
 * Minimal animated GIF89a encoder: one global 256-color palette (median cut
 * over a 15-bit histogram sampled from every frame), nearest-color lookup,
 * LZW compression and an infinite NETSCAPE loop.
 */

export type GifFrames = Readonly<{
  /** Per-frame RGBA pixels, `width * height * 4` bytes each. */
  frames: readonly Uint8ClampedArray[];
  fps: number;
  height: number;
  width: number;
}>;

type Box = { colors: number[]; count: number };

const CHANNEL = (color: number, shift: number) => (color >> shift) & 31;

function boxRange(box: Box): { channel: number; range: number } {
  let best = { channel: 10, range: -1 };
  for (const shift of [10, 5, 0]) {
    let min = 31;
    let max = 0;
    for (const color of box.colors) {
      const value = CHANNEL(color, shift);
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (max - min > best.range) best = { channel: shift, range: max - min };
  }
  return best;
}

function buildPalette(histogram: Uint32Array, maxColors: number): Uint8Array {
  const colors: number[] = [];
  let total = 0;
  for (let color = 0; color < histogram.length; color += 1) {
    if (histogram[color]! > 0) {
      colors.push(color);
      total += histogram[color]!;
    }
  }
  const boxes: Box[] = [{ colors, count: total }];

  while (boxes.length < maxColors) {
    let target = -1;
    let score = 0;
    boxes.forEach((box, index) => {
      if (box.colors.length < 2) return;
      const candidate = boxRange(box).range * Math.sqrt(box.count);
      if (candidate > score) {
        score = candidate;
        target = index;
      }
    });
    if (target < 0) break;
    const box = boxes[target]!;
    const { channel } = boxRange(box);
    box.colors.sort((left, right) => CHANNEL(left, channel) - CHANNEL(right, channel));
    let running = 0;
    let splitAt = 1;
    for (let index = 0; index < box.colors.length - 1; index += 1) {
      running += histogram[box.colors[index]!]!;
      splitAt = index + 1;
      if (running >= box.count / 2) break;
    }
    const left = box.colors.slice(0, splitAt);
    const right = box.colors.slice(splitAt);
    const count = (list: number[]) => list.reduce((sum, color) => sum + histogram[color]!, 0);
    boxes.splice(target, 1, { colors: left, count: count(left) }, { colors: right, count: count(right) });
  }

  const palette = new Uint8Array(256 * 3);
  boxes.forEach((box, index) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (const color of box.colors) {
      const n = histogram[color]!;
      r += CHANNEL(color, 10) * n;
      g += CHANNEL(color, 5) * n;
      b += CHANNEL(color, 0) * n;
      weight += n;
    }
    const scale = weight > 0 ? 255 / 31 / weight : 0;
    palette[index * 3] = Math.round(r * scale);
    palette[index * 3 + 1] = Math.round(g * scale);
    palette[index * 3 + 2] = Math.round(b * scale);
  });
  return palette;
}

function createLookup(palette: Uint8Array, colors: number): (color15: number) => number {
  const table = new Int16Array(32768).fill(-1);
  return (color15) => {
    const cached = table[color15]!;
    if (cached >= 0) return cached;
    const r = (CHANNEL(color15, 10) * 255) / 31;
    const g = (CHANNEL(color15, 5) * 255) / 31;
    const b = (CHANNEL(color15, 0) * 255) / 31;
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < colors; index += 1) {
      const dr = palette[index * 3]! - r;
      const dg = palette[index * 3 + 1]! - g;
      const db = palette[index * 3 + 2]! - b;
      const distance = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    table[color15] = best;
    return best;
  };
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private buffer = new Uint8Array(1 << 16);
  private length = 0;

  byte(value: number): void {
    if (this.length === this.buffer.length) this.flush();
    this.buffer[this.length++] = value & 255;
  }

  bytes(values: ArrayLike<number>): void {
    for (let index = 0; index < values.length; index += 1) this.byte(values[index]!);
  }

  word(value: number): void {
    this.byte(value);
    this.byte(value >> 8);
  }

  private flush(): void {
    this.chunks.push(this.buffer.slice(0, this.length));
    this.length = 0;
  }

  result(): Uint8Array<ArrayBuffer> {
    this.flush();
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

function writeLzw(writer: ByteWriter, indices: Uint8Array): void {
  const minCodeSize = 8;
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dictionary = new Map<number, number>();

  const block: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  const emit = (code: number) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      block.push(bitBuffer & 255);
      bitBuffer >>>= 8;
      bitCount -= 8;
      if (block.length === 255) {
        writer.byte(255);
        writer.bytes(block);
        block.length = 0;
      }
    }
  };

  writer.byte(minCodeSize);
  emit(clearCode);
  let prefix = indices[0] ?? 0;
  for (let index = 1; index < indices.length; index += 1) {
    const symbol = indices[index]!;
    const key = (prefix << 8) | symbol;
    const existing = dictionary.get(key);
    if (existing !== undefined) {
      prefix = existing;
      continue;
    }
    emit(prefix);
    if (nextCode < 4096) {
      dictionary.set(key, nextCode);
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
      nextCode += 1;
    } else {
      emit(clearCode);
      dictionary = new Map();
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
    }
    prefix = symbol;
  }
  emit(prefix);
  emit(endCode);
  if (bitCount > 0) block.push(bitBuffer & 255);
  if (block.length > 0) {
    writer.byte(block.length);
    writer.bytes(block);
  }
  writer.byte(0);
}

export async function encodeGif(
  { frames, fps, height, width }: GifFrames,
  options: Readonly<{ onProgress?: (progress: number) => void; signal?: AbortSignal }> = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const histogram = new Uint32Array(32768);
  const sampleStep = Math.max(1, Math.floor((width * height * frames.length) / 400_000));
  // Pixels under half alpha map to a reserved transparent index (255).
  const transparent = frames.some((frame) => {
    for (let offset = 3; offset < frame.length; offset += 4) if (frame[offset]! < 128) return true;
    return false;
  });
  frames.forEach((frame) => {
    for (let pixel = 0; pixel < width * height; pixel += sampleStep) {
      const offset = pixel * 4;
      if (frame[offset + 3]! < 128) continue;
      histogram[((frame[offset]! >> 3) << 10) | ((frame[offset + 1]! >> 3) << 5) | (frame[offset + 2]! >> 3)]! += 1;
    }
  });
  const colors = transparent ? 255 : 256;
  const palette = buildPalette(histogram, colors);
  const lookup = createLookup(palette, colors);

  const writer = new ByteWriter();
  writer.bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  writer.word(width);
  writer.word(height);
  writer.bytes([0xf7, 0, 0]);
  writer.bytes(palette);
  writer.bytes([0x21, 0xff, 0x0b, ...Array.from("NETSCAPE2.0", (char) => char.charCodeAt(0)), 0x03, 0x01, 0, 0, 0]);

  const indices = new Uint8Array(width * height);
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    options.signal?.throwIfAborted();
    const frame = frames[frameIndex]!;
    for (let pixel = 0; pixel < indices.length; pixel += 1) {
      const offset = pixel * 4;
      indices[pixel] = transparent && frame[offset + 3]! < 128 ? 255 : lookup(((frame[offset]! >> 3) << 10) | ((frame[offset + 1]! >> 3) << 5) | (frame[offset + 2]! >> 3));
    }
    // Centisecond delays distributed so the total matches the loop duration.
    const delay = Math.round(((frameIndex + 1) * 100) / fps) - Math.round((frameIndex * 100) / fps);
    // Disposal 2 (restore to background) stops earlier frames showing through
    // transparent pixels; flag bit 0 enables the transparent index.
    writer.bytes([0x21, 0xf9, 0x04, transparent ? 0x09 : 0x04]);
    writer.word(Math.max(2, delay));
    writer.bytes([transparent ? 255 : 0, 0]);
    writer.byte(0x2c);
    writer.word(0);
    writer.word(0);
    writer.word(width);
    writer.word(height);
    writer.byte(0);
    writeLzw(writer, indices);
    options.onProgress?.((frameIndex + 1) / frames.length);
    // Yield so the progress indicator and UI stay responsive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  writer.byte(0x3b);
  return writer.result();
}
