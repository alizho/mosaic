import {
  defineToolcraft,
  imageExportModule,
  svgExportModule,
  timelineModule,
  videoExportModule,
} from "@/toolcraft/runtime";

import { mosaicSections } from "../mosaic/schema-sections";
import appDefaults from "./app-defaults.json" with { type: "json" };
import { appIdentity } from "./app-identity";

export const MOSAIC_LOOP_SECONDS = 6;

export const appSchema = defineToolcraft({
  defaults: appDefaults,
  base: {
    canvas: {
      enabled: true,
      renderScale: true,
      sizing: { mode: "editable-output" },
      upload: false,
    },
    identity: appIdentity,
    panels: {
      controls: {
        sections: mosaicSections,
        title: "Mosaic",
      },
    },
    toolbar: {
      history: true,
      radar: true,
      theme: true,
      zoom: true,
    },
  },
  modules: [
    timelineModule({ defaultDurationSeconds: MOSAIC_LOOP_SECONDS, mode: "playback" }),
    imageExportModule(),
    svgExportModule(),
    videoExportModule(),
  ],
});
