/**
 * Infinity mode "full bleed": an editor-only viewport layer that keeps tiling
 * the world with artboard-sized neighbor mosaics (each seeded by its tile
 * coordinate) as you pan and zoom. The artboard tile itself is drawn by the
 * product canvas above, which is the only content that exports.
 */

import * as React from "react";

import { useToolcraftSelector } from "@/toolcraft/runtime/react";

import { readDevicePixelRatio, useFrameScheduler, useMosaicFrameInputs } from "./MosaicCanvas";
import styles from "./mosaic.module.css";
import { drawMosaic } from "./render-canvas";
import { buildTileScene } from "./scene";

const MAX_TILES = 121;

function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = React.useState({ height: 0, width: 0 });
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ height: entry.contentRect.height, width: entry.contentRect.width });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function InfiniteMosaic(): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const viewport = useElementSize(containerRef);
  const offsetX = useToolcraftSelector((state) => state.canvas.offset.x);
  const offsetY = useToolcraftSelector((state) => state.canvas.offset.y);
  const zoom = useToolcraftSelector((state) => state.canvas.zoom) / 100;
  const sizeWidth = useToolcraftSelector((state) => state.canvas.size.width);
  const sizeHeight = useToolcraftSelector((state) => state.canvas.size.height);
  const { params, progress } = useMosaicFrameInputs(false);
  const dpr = readDevicePixelRatio();

  const draw = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewport.width <= 0 || viewport.height <= 0 || zoom <= 0) return;
    const backingWidth = Math.round(viewport.width * dpr);
    const backingHeight = Math.round(viewport.height * dpr);
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, backingWidth, backingHeight);

    // Same world transform as the runtime canvas world: centered, offset, zoomed.
    const originX = viewport.width / 2 + offsetX;
    const originY = viewport.height / 2 + offsetY;
    const scale = dpr * zoom;
    context.setTransform(scale, 0, 0, scale, originX * dpr, originY * dpr);

    const artboard = { height: sizeHeight, width: sizeWidth, x: -sizeWidth / 2, y: -sizeHeight / 2 };
    const left = -originX / zoom;
    const top = -originY / zoom;
    const right = (viewport.width - originX) / zoom;
    const bottom = (viewport.height - originY) / zoom;
    const firstColumn = Math.floor((left - artboard.x) / artboard.width);
    const lastColumn = Math.floor((right - artboard.x) / artboard.width);
    const firstRow = Math.floor((top - artboard.y) / artboard.height);
    const lastRow = Math.floor((bottom - artboard.y) / artboard.height);
    if ((lastColumn - firstColumn + 1) * (lastRow - firstRow + 1) > MAX_TILES) return;

    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        if (row === 0 && column === 0) continue;
        drawMosaic(context, { pixelRatio: scale, progress, scene: buildTileScene(artboard, params, column, row) });
      }
    }
  }, [viewport, offsetX, offsetY, zoom, sizeWidth, sizeHeight, params, progress, dpr]);
  useFrameScheduler(draw);

  return (
    <div className={styles.infiniteLayer} ref={containerRef}>
      <canvas aria-hidden="true" className={styles.infiniteCanvas} data-mosaic-canvas="infinite" ref={canvasRef} />
    </div>
  );
}
