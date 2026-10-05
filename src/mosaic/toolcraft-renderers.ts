/** Toolcraft scene ports: product bounds plus raster and vector export frames. */

import {
  evaluateToolcraftTimelineValues,
  getToolcraftFiniteArtboardRect,
  getToolcraftTimelineLoopProgress,
  type ToolcraftProductExportFrameContext,
  type ToolcraftProductExportRenderer,
  type ToolcraftProductSceneBoundsProvider,
  type ToolcraftProductSvgExportRenderer,
} from "@/toolcraft/runtime";

import { readMosaicParams } from "./params";
import { drawMosaic } from "./render-canvas";
import { appendMosaicSvg } from "./render-svg";
import { buildMosaicScene } from "./scene";
import type { Rect } from "./tessellate";

type State = ToolcraftProductExportFrameContext["state"];

/** The mosaic always partitions exactly the artboard rect, in both canvas modes. */
export const mosaicSceneBounds: ToolcraftProductSceneBoundsProvider = ({ state }) => [
  getToolcraftFiniteArtboardRect(state.canvas.size),
];

export function resolveMosaicFrame(state: State, frame: Rect, timeSeconds: number) {
  const params = readMosaicParams(evaluateToolcraftTimelineValues(state, timeSeconds), {
    bounded: state.canvas.mode !== "infinite",
  });
  const { durationSeconds } = state.timeline;
  const progress = getToolcraftTimelineLoopProgress({ currentTimeSeconds: timeSeconds, durationSeconds });
  return {
    progress,
    scene: buildMosaicScene(frame, params),
  };
}

export const mosaicRasterRenderer: ToolcraftProductExportRenderer = {
  baseFileName: "mosaic",
  renderFrame: ({ context, frame, pixelRatio, signal, state, timeSeconds }) => {
    signal.throwIfAborted();
    drawMosaic(context, { ...resolveMosaicFrame(state, frame, timeSeconds), pixelRatio });
  },
};

export const mosaicVectorRenderer: ToolcraftProductSvgExportRenderer = {
  baseFileName: "mosaic",
  renderFrame: ({ container, frame, signal, state, timeSeconds }) => {
    signal.throwIfAborted();
    const { progress, scene } = resolveMosaicFrame(state, frame, timeSeconds);
    appendMosaicSvg(container, scene, progress);
  },
};
