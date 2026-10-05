/**
 * Gradient and dither cells with integrated grain, rendered in one WebGL2
 * pass. Grain is not a layer on top: it screens the cell's own ink choice, so
 * texture follows the color transition. Solid cells never reach this pass.
 */

import type { CellFrame } from "./cells";
import type { DitherMask } from "./dither";
import type { GrainParams } from "./params";
import type { Rect } from "./tessellate";

export type FillDraw = Readonly<{ drawRect: Rect; frame: CellFrame; mask?: DitherMask }>;

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
// quantized particles). Gradient cells screen their tone; dither cells screen
// a blend of their dot mask and tone, so grain erodes and sprinkles the dots
// while preserving average coverage.
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_scene;
out vec4 outColor;
uniform int u_mode;       // 0 gradient, 1 dither
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

void main() {
  float t = warp(gradientParam(v_scene), u_mid);
  float ink;
  if (u_mode == 1) {
    ivec2 dotCell = clamp(ivec2(floor((v_scene - u_maskOrigin) / u_dotSize)), ivec2(0), u_maskDims - 1);
    float mask = float(texelFetch(u_mask, dotCell, 0).r);
    ink = u_amount > 0.0 ? screen(mix(mask, t, u_amount)) : mask;
  } else {
    ink = u_amount > 0.0 ? mix(t, screen(t), u_amount) : t;
  }
  outColor = vec4(mix(u_colorA, u_colorB, ink) / 255.0, 1.0);
}`;

type GlState = {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
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
    "u_discreteness", "u_grainSize", "u_cycles", "u_progress", "u_mask", "u_maskOrigin", "u_dotSize", "u_maskDims",
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
  glState = { canvas, gl, maxSize, program, texture, uniforms };
  return glState;
}

export function isFillGlAvailable(): boolean {
  return getGl() !== null;
}

/**
 * Render gradient and dither cells into the visible device-space region of `root` and
 * composite them onto `ctx` (which carries a scale+translate scene transform).
 * Returns false when WebGL2 is unavailable so the caller can fall back.
 */
export function drawFillCells(
  ctx: CanvasRenderingContext2D,
  root: Rect,
  draws: readonly FillDraw[],
  grain: GrainParams,
  dotSize: number,
  progress: number,
): boolean {
  if (draws.length === 0) return true;
  const state = getGl();
  if (!state) return false;
  const { canvas, gl, uniforms } = state;

  const m = ctx.getTransform();
  const left = Math.max(0, Math.floor(m.a * root.x + m.e));
  const top = Math.max(0, Math.floor(m.d * root.y + m.f));
  const right = Math.min(ctx.canvas.width, Math.ceil(m.a * (root.x + root.width) + m.e));
  const bottom = Math.min(ctx.canvas.height, Math.ceil(m.d * (root.y + root.height) + m.f));
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
  gl.uniform1f(uniforms.u_dotSize!, dotSize);
  gl.uniform1i(uniforms.u_mask!, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.texture);
  // Integer textures need a bound level even for gradient draws.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array([0]));

  for (const { drawRect, frame, mask } of draws) {
    const g = frame.gradient;
    const dither = frame.fill === "dither" && mask !== undefined;
    gl.uniform1i(uniforms.u_mode!, dither ? 1 : 0);
    gl.uniform1f(uniforms.u_amount!, (dither ? grain.onDither : grain.onGradient) ? grain.amount : 0);
    if (dither) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, mask.columns, mask.rows, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, mask.data);
      gl.uniform2f(uniforms.u_maskOrigin!, frame.rect.x, frame.rect.y);
      gl.uniform2i(uniforms.u_maskDims!, mask.columns, mask.rows);
    }
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
