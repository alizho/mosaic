/**
 * Mosaic cells rendered in one ordered WebGL2 pass: solids, gradients (with
 * integrated grain), dither, and the pattern fills — scanlines, dots and
 * ASCII glyphs — whose ink sits on an empty, transparent ground. Grain is not
 * a layer on top: it screens the gradient's own ink choice, so texture
 * follows the color transition; dither and pattern inks stay clean.
 */

import type { CellFrame } from "./cells";
import type { DitherMask } from "./dither";
import type { FillParams, GrainParams } from "./params";
import { ASCII_FONT_STACK, asciiPitch, SCANLINE_TEXTURE_GLSL } from "./pattern-texture";
import type { Rect } from "./tessellate";

export type FillDraw = Readonly<{ drawRect: Rect; frame: CellFrame; mask?: DitherMask }>;

export type FillPassOptions = Readonly<{
  fill: FillParams;
  grain: GrainParams;
  progress: number;
}>;

const VERTEX = `#version 300 es
in vec2 a_unit;
uniform vec4 u_rect;      // scene x, y, w, h
uniform vec4 u_view;      // scene->region pixels: sx, sy, tx, ty
uniform vec2 u_size;      // region size in pixels
out vec2 v_scene;
void main() {
  v_scene = u_rect.xy + a_unit * u_rect.zw;
  vec2 px = v_scene * u_view.xy + u_view.zw;
  vec2 clip = px / u_size * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

// Grain is a stochastic screen built from a per-speck threshold field. Each
// speck's threshold moves on a triangle wave (uniformity-preserving) with an
// integer number of cycles per loop, plus coarse "ink clumping". Discreteness
// blends the field from a smooth, interpolated version with a wide transition
// (soft mottled blend) to the raw per-speck field with a hard step (crisp
// quantized particles). Only gradient cells screen their tone with it.
// Patterns are analytic lattices anchored at the cell origin and box-filtered
// over one device pixel, so edges stay clean at any zoom: coverage × opacity
// becomes the ink's alpha (premultiplied), and the gaps stay fully transparent.
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_scene;
out vec4 outColor;
uniform int u_mode;       // 0 gradient, 1 dither, 2 scanlines, 3 dots, 4 solid, 5 ascii
uniform vec3 u_colorInk;
uniform sampler2D u_glyph;
uniform float u_texture;  // scanline print texture 0..1
uniform int u_kind;       // 0 linear, 1 radial
uniform vec4 u_geom;      // linear: x0 y0 x1 y1 | radial: cx cy r -
uniform float u_mid;
uniform vec3 u_colorA;
uniform vec3 u_colorB;
uniform float u_amount;
uniform float u_discreteness;
uniform float u_grainSize;
uniform float u_cycles;
uniform float u_progress;
uniform highp usampler2D u_mask;
uniform vec2 u_maskOrigin;
uniform float u_dotSize;
uniform ivec2 u_maskDims;
uniform vec4 u_lattice;   // spacing (ascii: row pitch), ink fraction, scroll periods, axis/stagger flag

uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float hash(ivec2 c, uint salt) {
  return float(pcg(uint(c.x) * 1597334677u ^ pcg(uint(c.y) ^ salt))) / 4294967295.0;
}
float valueNoise(vec2 p, uint salt) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  return mix(mix(hash(c, salt), hash(c + ivec2(1, 0), salt), f.x),
             mix(hash(c + ivec2(0, 1), salt), hash(c + ivec2(1, 1), salt), f.x), f.y);
}
float threshold(ivec2 cell) {
  return abs(2.0 * fract(hash(cell, 7u) + u_cycles * u_progress) - 1.0);
}
float softThreshold(vec2 grain) {
  vec2 p = grain - 0.5;
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  return mix(mix(threshold(c), threshold(c + ivec2(1, 0)), f.x),
             mix(threshold(c + ivec2(0, 1)), threshold(c + ivec2(1, 1)), f.x), f.y);
}
float screen(float value) {
  vec2 grain = v_scene / u_grainSize;
  float crisp = threshold(ivec2(floor(grain)));
  // Crisp end: raw per-speck thresholds with ink clumping (wrap keeps them uniform).
  float crispField = fract(crisp + 0.3 * valueNoise(grain * 0.18, 91u));
  // Soft end: two octaves of thresholds interpolated over coarser lattices ->
  // a continuous, blurred mottle with no hard edges.
  float softField = 0.6 * softThreshold(grain * 0.25) + 0.4 * softThreshold(grain * 0.5 + 17.3);
  softField = 0.5 + (softField - 0.5) * 1.6;
  float field = mix(softField, crispField, u_discreteness);
  float width = max(mix(0.5, 0.0, u_discreteness), 0.002);
  return smoothstep(field - width, field + width, value);
}

float gradientParam(vec2 p) {
  if (u_kind == 1) return clamp(length(p - u_geom.xy) / u_geom.z, 0.0, 1.0);
  vec2 v = u_geom.zw - u_geom.xy;
  return clamp(dot(p - u_geom.xy, v) / max(dot(v, v), 1e-6), 0.0, 1.0);
}

float warp(float t, float mid) {
  return t <= mid ? t / max(mid, 1e-6) * 0.5 : 0.5 + (t - mid) / max(1.0 - mid, 1e-6) * 0.5;
}

${SCANLINE_TEXTURE_GLSL}

/** Fraction of a pixel-wide footprint inside a band of half-width h around 0. */
float band(float distance, float h, float pixel) {
  return clamp((h - distance) / max(pixel, 1e-6) + 0.5, 0.0, 1.0);
}

vec3 gradientColor() {
  float t = warp(gradientParam(v_scene), u_mid);
  float ink = u_amount > 0.0 ? mix(t, screen(t), u_amount) : t;
  return mix(u_colorA, u_colorB, ink);
}

void main() {
  vec2 local = v_scene - u_maskOrigin;
  float pixel = max(fwidth(v_scene.x), fwidth(v_scene.y));
  if (u_mode == 0 || u_mode == 1 || u_mode == 4) {
    vec3 color = u_colorA;
    if (u_mode == 0) {
      color = gradientColor();
    } else if (u_mode == 1) {
      ivec2 dotCell = clamp(ivec2(floor(local / u_dotSize)), ivec2(0), u_maskDims - 1);
      color = mix(u_colorA, u_colorB, float(texelFetch(u_mask, dotCell, 0).r));
    }
    outColor = vec4(color / 255.0, 1.0);
    return;
  }

  float cover = 0.0;
  if (u_mode == 2) {
    // Lines are centered in each period; the axis flag picks rows (0) or columns (1).
    // The print texture is keyed to unscrolled cell space so loops stay seamless.
    float spacing = u_lattice.x;
    bool vertical = u_lattice.w > 0.5;
    float u = vertical ? local.x : local.y;
    float w = vertical ? local.y : local.x;
    float coord = u / spacing - u_lattice.z;
    float lineCenter = (floor(coord) + 0.5 + u_lattice.z) * spacing;
    float distance = abs(fract(coord) - 0.5) * spacing;
    float half_ = scanlineHalfWidth(lineCenter, w, spacing, u_lattice.y, u_texture);
    float speck = 1.0 - u_texture * 0.3 * hash(ivec2(floor(local / max(spacing * 0.12, 1.0))), 53u);
    cover = band(distance, half_, pixel) * scanlineOpacity(lineCenter, w, spacing, u_texture) * speck;
  } else if (u_mode == 3) {
    float spacing = u_lattice.x;
    vec2 q = local / spacing;
    q.x -= u_lattice.z;
    if (u_lattice.w > 0.5 && mod(floor(q.y), 2.0) > 0.5) q.x += 0.5;
    float distance = length(fract(q) - 0.5) * spacing;
    cover = band(distance, u_lattice.y * spacing * 0.5, pixel);
  } else if (u_mode == 5) {
    vec2 pitch = vec2(u_lattice.x * 0.6, u_lattice.x);
    vec2 q = local / pitch;
    q.x -= u_lattice.z;
    // Gradients from the continuous coordinate keep mip selection seam-free at tile edges.
    cover = textureGrad(u_glyph, fract(q), dFdx(q), dFdy(q)).a;
  }
  outColor = vec4(u_colorInk / 255.0 * cover, cover);
}`;

type GlState = {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  glyph: { char: string; texture: WebGLTexture | null } ;
  maxSize: number;
  program: WebGLProgram;
  texture: WebGLTexture | null;
  uniforms: Record<string, WebGLUniformLocation | null>;
};

let glState: GlState | null | undefined;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  console.warn("[mosaic] shader compile failed", gl.getShaderInfoLog(shader));
  return null;
}

function getGl(): GlState | null {
  if (glState !== undefined) return glState;
  glState = null;
  if (typeof OffscreenCanvas === "undefined") return glState;
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: true });
  if (!gl) return glState;
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return glState;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.bindAttribLocation(program, 0, "a_unit");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return glState;

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const names = [
    "u_rect", "u_view", "u_size", "u_mode", "u_kind", "u_geom", "u_mid", "u_colorA", "u_colorB", "u_amount",
    "u_discreteness", "u_grainSize", "u_cycles", "u_progress", "u_mask", "u_maskOrigin", "u_dotSize", "u_maskDims", "u_lattice",
    "u_colorInk", "u_glyph", "u_texture",
  ];
  const uniforms = Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
  const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  const maxSize = Math.min(dims[0] ?? 4096, dims[1] ?? 4096, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  glState = { canvas, gl, glyph: { char: "", texture: gl.createTexture() }, maxSize, program, texture, uniforms };
  return glState;
}

const GLYPH_HEIGHT = 128;

/**
 * Alpha mask of one glyph centered in a monospace cell (advance 0.6 em,
 * 1 em rows). Glyphs wider than the advance (CJK, emoji) are scaled to fit.
 */
export function renderGlyphMask(char: string, height: number): OffscreenCanvas | null {
  const [width] = asciiPitch(height);
  const canvas = new OffscreenCanvas(Math.round(width), height);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.font = `${height * 0.8}px ${ASCII_FONT_STACK}`;
  const metrics = context.measureText(char);
  const glyphWidth = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
  const glyphHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
  const scale = Math.min(1, (canvas.width * 0.92) / Math.max(glyphWidth, 1e-3), (height * 0.92) / Math.max(glyphHeight, 1e-3));
  context.translate(canvas.width / 2, height / 2);
  context.scale(scale, scale);
  context.fillStyle = "#fff";
  context.fillText(
    char,
    (metrics.actualBoundingBoxLeft - metrics.actualBoundingBoxRight) / 2,
    (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2,
  );
  return canvas;
}

function bindGlyph(state: GlState, char: string): void {
  const { gl } = state;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, state.glyph.texture);
  if (state.glyph.char === char) return;
  const mask = renderGlyphMask(char, GLYPH_HEIGHT);
  if (!mask) return;
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  state.glyph.char = char;
}

export function isFillGlAvailable(): boolean {
  return getGl() !== null;
}

const MODE = { ascii: 5, dither: 1, dots: 3, gradient: 0, scanlines: 2, solid: 4 } as const;

/** Device-space bounds of every draw, clipped to the target canvas. */
function deviceRegion(ctx: CanvasRenderingContext2D, draws: readonly FillDraw[]) {
  const m = ctx.getTransform();
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const { drawRect: r } of draws) {
    const x0 = m.a * r.x + m.e;
    const y0 = m.d * r.y + m.f;
    const x1 = x0 + m.a * r.width;
    const y1 = y0 + m.d * r.height;
    left = Math.min(left, x0, x1);
    top = Math.min(top, y0, y1);
    right = Math.max(right, x0, x1);
    bottom = Math.max(bottom, y0, y1);
  }
  return {
    bottom: Math.min(ctx.canvas.height, Math.ceil(bottom)),
    left: Math.max(0, Math.floor(left)),
    m,
    right: Math.min(ctx.canvas.width, Math.ceil(right)),
    top: Math.max(0, Math.floor(top)),
  };
}

/**
 * Render cells, in order, into the visible device-space region they
 * cover and composite them onto `ctx` (which carries a scale+translate scene
 * transform). Returns false when WebGL2 is unavailable so the caller can fall back.
 */
export function drawFillCells(ctx: CanvasRenderingContext2D, draws: readonly FillDraw[], options: FillPassOptions): boolean {
  if (draws.length === 0) return true;
  const state = getGl();
  if (!state) return false;
  const { canvas, gl, uniforms } = state;
  const { fill, grain, progress } = options;

  const { bottom, left, m, right, top } = deviceRegion(ctx, draws);
  const regionWidth = right - left;
  const regionHeight = bottom - top;
  if (regionWidth <= 0 || regionHeight <= 0) return true;

  // Very large exports render at the GPU limit and are upscaled on composite.
  const fit = Math.min(1, state.maxSize / regionWidth, state.maxSize / regionHeight);
  const width = Math.max(1, Math.floor(regionWidth * fit));
  const height = Math.max(1, Math.floor(regionHeight * fit));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(state.program);
  gl.uniform4f(uniforms.u_view!, m.a * fit, m.d * fit, (m.e - left) * fit, (m.f - top) * fit);
  gl.uniform2f(uniforms.u_size!, width, height);
  gl.uniform1f(uniforms.u_cycles!, grain.speed);
  gl.uniform1f(uniforms.u_progress!, progress);
  gl.uniform1f(uniforms.u_discreteness!, grain.discreteness);
  gl.uniform1f(uniforms.u_grainSize!, grain.size);
  gl.uniform1f(uniforms.u_amount!, grain.enabled ? grain.amount : 0);
  gl.uniform1f(uniforms.u_dotSize!, fill.ditherScale);
  gl.uniform1f(uniforms.u_texture!, fill.scanlineTexture);
  gl.uniform1i(uniforms.u_mask!, 0);
  gl.uniform1i(uniforms.u_glyph!, 1);
  bindGlyph(state, fill.asciiChar);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.texture);
  // Integer textures need a bound level even for non-dither draws.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array([0]));

  for (const { drawRect, frame, mask } of draws) {
    const g = frame.gradient;
    const mode = frame.fill === "dither" && !mask ? MODE.solid : MODE[frame.fill];
    gl.uniform1i(uniforms.u_mode!, mode);
    gl.uniform2f(uniforms.u_maskOrigin!, frame.rect.x, frame.rect.y);
    if (mode === MODE.dither && mask) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, mask.columns, mask.rows, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, mask.data);
      gl.uniform2i(uniforms.u_maskDims!, mask.columns, mask.rows);
    } else if (mode === MODE.scanlines) {
      gl.uniform4f(uniforms.u_lattice!, fill.scanlineSpacing, fill.scanlineThickness, frame.scroll, frame.lineAxis === "vertical" ? 1 : 0);
    } else if (mode === MODE.dots) {
      gl.uniform4f(uniforms.u_lattice!, fill.dotSpacing, fill.dotSize, frame.scroll, fill.dotGrid === "staggered" ? 1 : 0);
    } else if (mode === MODE.ascii) {
      gl.uniform4f(uniforms.u_lattice!, fill.asciiSize, 0, frame.scroll, 0);
    }
    gl.uniform3f(uniforms.u_colorInk!, frame.ink[0], frame.ink[1], frame.ink[2]);
    gl.uniform4f(uniforms.u_rect!, drawRect.x, drawRect.y, drawRect.width, drawRect.height);
    gl.uniform1i(uniforms.u_kind!, g.kind === "radial" ? 1 : 0);
    if (g.kind === "radial") gl.uniform4f(uniforms.u_geom!, g.cx, g.cy, g.radius, 0);
    else gl.uniform4f(uniforms.u_geom!, g.x0, g.y0, g.x1, g.y1);
    gl.uniform1f(uniforms.u_mid!, frame.mid);
    gl.uniform3f(uniforms.u_colorA!, frame.a[0], frame.a[1], frame.a[2]);
    gl.uniform3f(uniforms.u_colorB!, frame.b[0], frame.b[1], frame.b[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Keep specks hard-edged; only smooth when the GPU limit forced an upscale.
  ctx.imageSmoothingEnabled = fit < 1;
  ctx.drawImage(canvas, 0, 0, width, height, left, top, regionWidth, regionHeight);
  ctx.restore();
  return true;
}
