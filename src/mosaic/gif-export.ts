/**
 * GIF export (product-owned by explicit user override of the Toolcraft export
 * contract). Renders the saved artboard at the GIF frame rate across exactly
 * one timeline loop with the same `drawMosaic` used by preview and runtime
 * export, then encodes and downloads the file.
 */

import {
  evaluateToolcraftTimelineValues,
  getToolcraftFiniteArtboardRect,
  getToolcraftTimelineLoopProgress,
  type ToolcraftProductExportFrameContext,
} from "@/toolcraft/runtime";

import { encodeGif } from "./gif-encoder";
import { readMosaicParams } from "./params";
import { drawMosaic } from "./render-canvas";
import { buildMosaicScene } from "./scene";

export const GIF_EXPORT_ACTION = "mosaic.exportGif";
export const GIF_MAX_FRAMES = 900;

export type GifExportProgress = (progress: number) => void;
type ReadonlyToolcraftState = ToolcraftProductExportFrameContext["state"];

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function resolveGifPlan(state: ReadonlyToolcraftState) {
  const fps = Math.min(50, Math.max(1, Math.round(numberValue(state.values["gif.fps"], 15))));
  const width = Math.max(16, Math.round(Number(state.values["gif.width"] ?? 640) || 640));
  const frame = getToolcraftFiniteArtboardRect(state.canvas.size);
  const height = Math.max(16, Math.round((width * frame.height) / frame.width));
  const durationSeconds = Math.max(0.1, state.timeline.durationSeconds);
  const frameCount = Math.min(GIF_MAX_FRAMES, Math.max(1, Math.round(durationSeconds * fps)));
  return { durationSeconds, fps, frame, frameCount, height, width };
}

export async function renderGif(
  state: ReadonlyToolcraftState,
  reportProgress: GifExportProgress,
  signal?: AbortSignal,
): Promise<Blob> {
  const plan = resolveGifPlan(state);
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("GIF export requires a 2D canvas context.");

  const scale = plan.width / plan.frame.width;
  const frames: Uint8ClampedArray[] = [];
  // Frame times divide the loop evenly so the last frame stitches to the first.
  const effectiveFps = plan.frameCount / plan.durationSeconds;

  for (let index = 0; index < plan.frameCount; index += 1) {
    signal?.throwIfAborted();
    const timeSeconds = (index / plan.frameCount) * plan.durationSeconds;
    const values = evaluateToolcraftTimelineValues(state, timeSeconds);
    const params = readMosaicParams(values, { bounded: state.canvas.mode !== "infinite" });
    const progress = getToolcraftTimelineLoopProgress({ currentTimeSeconds: timeSeconds, durationSeconds: plan.durationSeconds });

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, plan.width, plan.height);
    // With Background on, flatten onto it; otherwise gaps (exploded edges)
    // become 1-bit transparent GIF pixels.
    if (values["export.includeBackground"] !== false) {
      context.fillStyle = typeof values["appearance.background"] === "string" ? values["appearance.background"] : "#FFFFFF";
      context.fillRect(0, 0, plan.width, plan.height);
    }
    context.setTransform(scale, 0, 0, scale, -plan.frame.x * scale, -plan.frame.y * scale);
    drawMosaic(context, {
      pixelRatio: scale,
      progress,
      scene: buildMosaicScene(plan.frame, params),
    });
    frames.push(context.getImageData(0, 0, plan.width, plan.height).data);
    reportProgress((0.5 * (index + 1)) / plan.frameCount);
    if (index % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const bytes = await encodeGif(
    { fps: effectiveFps, frames, height: plan.height, width: plan.width },
    { onProgress: (progress) => reportProgress(0.5 + progress * 0.5), signal },
  );
  return new Blob([bytes], { type: "image/gif" });
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
