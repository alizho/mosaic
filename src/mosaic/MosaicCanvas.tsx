/**
 * Live product output. Sized by the runtime product scene frame (the artboard
 * rect in both canvas modes); backing pixels = CSS size × devicePixelRatio ×
 * Resolution scale. Redraws are coalesced into one animation frame.
 */

import * as React from "react";

import { getToolcraftTimelineLoopProgress } from "@/toolcraft/runtime";
import {
  useToolcraftDispatch,
  useToolcraftEvaluatedValues,
  useToolcraftProductSceneFrame,
  useToolcraftSelector,
  useToolcraftValue,
} from "@/toolcraft/runtime/react";

import styles from "./mosaic.module.css";
import { readMosaicParams } from "./params";
import { drawMosaic } from "./render-canvas";
import { buildMosaicScene } from "./scene";
import type { Rect } from "./tessellate";

export function readDevicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

export function useMosaicFrameInputs(bounded = true) {
  const values = useToolcraftEvaluatedValues();
  const timeSeconds = useToolcraftSelector((state) => state.timeline.currentTimeSeconds);
  const durationSeconds = useToolcraftSelector((state) => state.timeline.durationSeconds);
  const params = React.useMemo(() => readMosaicParams(values, { bounded }), [values, bounded]);
  const renderScaleValue = values["canvas.renderScale"];
  const renderScale = typeof renderScaleValue === "number" && renderScaleValue > 0 ? renderScaleValue : 2;
  const progress = getToolcraftTimelineLoopProgress({ currentTimeSeconds: timeSeconds, durationSeconds });
  return {
    params,
    progress,
    renderScale,
  };
}

const HIDDEN_FRAME_FALLBACK_MS = 120;

/**
 * Coalesce redraw requests into one pending frame that always runs the latest
 * draw. Re-renders never cancel the pending frame, so a stream of timeline
 * ticks cannot starve the canvas; a timeout backs up requestAnimationFrame,
 * which browsers pause for hidden documents.
 */
export function useFrameScheduler(draw: () => void): void {
  const latest = React.useRef(draw);
  const pending = React.useRef<{ frame: number; timeout: ReturnType<typeof setTimeout> } | null>(null);
  React.useLayoutEffect(() => {
    latest.current = draw;
    if (pending.current) return;
    const run = () => {
      const scheduled = pending.current;
      if (!scheduled) return;
      cancelAnimationFrame(scheduled.frame);
      clearTimeout(scheduled.timeout);
      pending.current = null;
      latest.current();
    };
    pending.current = { frame: requestAnimationFrame(run), timeout: setTimeout(run, HIDDEN_FRAME_FALLBACK_MS) };
  }, [draw]);
  React.useEffect(
    () => () => {
      if (!pending.current) return;
      cancelAnimationFrame(pending.current.frame);
      clearTimeout(pending.current.timeout);
      pending.current = null;
    },
    [],
  );
}

/**
 * Exploded gaps must read as transparent holes, not artboard fill: switching
 * Explode Edges on turns the runtime Background off, and switching it off
 * restores the Background only if this sync was what turned it off.
 */
function useExplodedGapsTransparent(): void {
  const dispatch = useToolcraftDispatch();
  const explode = useToolcraftValue("frame.explode") === true;
  const background = useToolcraftValue("export.includeBackground") !== false;
  const previous = React.useRef(explode);
  const disabledByExplode = React.useRef(false);
  React.useEffect(() => {
    if (explode && !previous.current && background) {
      disabledByExplode.current = true;
      dispatch({ label: "Explode Edges", target: "export.includeBackground", type: "controls.setValue", value: false });
    } else if (!explode && previous.current && disabledByExplode.current && !background) {
      dispatch({ label: "Explode Edges", target: "export.includeBackground", type: "controls.setValue", value: true });
    }
    if (!explode) disabledByExplode.current = false;
    previous.current = explode;
  }, [background, dispatch, explode]);
}

export function MosaicCanvas(): React.JSX.Element | null {
  useExplodedGapsTransparent();
  const frame = useToolcraftProductSceneFrame();
  const rect: Rect | null = frame.kind === "ready" ? frame.rect : null;
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const dpr = readDevicePixelRatio();
  const bounded = useToolcraftSelector((state) => state.canvas.mode !== "infinite");
  const { params, progress, renderScale } = useMosaicFrameInputs(bounded);

  const scale = dpr * renderScale;
  const backingWidth = rect ? Math.max(1, Math.round(rect.width * scale)) : 1;
  const backingHeight = rect ? Math.max(1, Math.round(rect.height * scale)) : 1;

  const draw = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !rect) return;
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    const sx = backingWidth / rect.width;
    const sy = backingHeight / rect.height;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, backingWidth, backingHeight);
    context.setTransform(sx, 0, 0, sy, -rect.x * sx, -rect.y * sy);
    drawMosaic(context, { pixelRatio: sx, progress, scene: buildMosaicScene(rect, params) });
  }, [rect, backingWidth, backingHeight, params, progress]);
  useFrameScheduler(draw);

  if (!rect) return null;
  return (
    <canvas
      aria-hidden="true"
      className={styles.productCanvas}
      data-mosaic-canvas="artboard"
      data-toolcraft-product-output=""
      height={backingHeight}
      ref={canvasRef}
      width={backingWidth}
    />
  );
}
