import { composeToolcraftApp } from "@/toolcraft/runtime/react";

import { InfiniteMosaic } from "../mosaic/InfiniteMosaic";
import { MosaicCanvas } from "../mosaic/MosaicCanvas";
import { handleMosaicPanelAction } from "../mosaic/panel-actions";
import {
  mosaicRasterRenderer,
  mosaicSceneBounds,
  mosaicVectorRenderer,
} from "../mosaic/toolcraft-renderers";
import { appSchema } from "./app-schema";

export const appComposition = composeToolcraftApp(appSchema, {
  actions: { onPanelAction: handleMosaicPanelAction },
  scene: {
    canvasContent: <MosaicCanvas />,
    infiniteCanvasContent: <InfiniteMosaic />,
    rasterFrameRenderer: mosaicRasterRenderer,
    sceneBoundsProvider: mosaicSceneBounds,
    vectorFrameRenderer: mosaicVectorRenderer,
  },
});
