/** Non-runtime product actions: layout shuffle and GIF export. */

import type { ToolcraftPanelActionHandler } from "@/toolcraft/runtime/react";

import { downloadBlob, GIF_EXPORT_ACTION, renderGif } from "./gif-export";
import { SHUFFLE_ACTION } from "./schema-sections";

export const handleMosaicPanelAction: ToolcraftPanelActionHandler = ({ action, dispatch, reportFeedback, reportProgress, state }) => {
  if (action.value === SHUFFLE_ACTION) {
    const current = typeof state.values["layout.seed"] === "number" ? state.values["layout.seed"] : 0;
    let next = Math.floor(Math.random() * 1000);
    if (next === current) next = (next + 1) % 1000;
    dispatch({ label: "Shuffle layout", target: "layout.seed", type: "controls.setValue", value: next });
    return;
  }

  if (action.value === GIF_EXPORT_ACTION) {
    return renderGif(state, reportProgress)
      .then((blob) => downloadBlob(blob, "mosaic.gif"))
      .catch((error: unknown) => {
        reportFeedback({
          code: "gif-export-failed",
          message: error instanceof Error ? error.message : "GIF export failed.",
        });
      });
  }
};
