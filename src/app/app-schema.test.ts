import { describe, expect, it } from "vitest";

import { appSchema, MOSAIC_LOOP_SECONDS } from "./app-schema";

function productSection(id: string) {
  return appSchema.panels.controls?.sections.find((section) => section.id === id);
}

describe("appSchema", () => {
  it("assembles the Mosaic product on the Toolcraft runtime", () => {
    expect(appSchema.canvas.enabled).toBe(true);
    expect(appSchema.canvas.sizing).toMatchObject({ mode: "editable-output" });
    expect(appSchema.canvas.upload).toBe(false);
    expect(appSchema.canvas.renderScale.enabled).toBe(true);
    expect(appSchema.panels.layers).toBeUndefined();
    expect(appSchema.panels.timeline).toMatchObject({
      defaultDurationSeconds: MOSAIC_LOOP_SECONDS,
      enabled: true,
      mode: "playback",
    });
    expect(appSchema.modulePlan.modules.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["timeline", "image-export", "svg-export", "video-export"]),
    );
  });

  it("exposes the requested product sections in workflow order", () => {
    const titles = appSchema.panels.controls?.sections.map((section) => section.title) ?? [];
    const order = ["Settings", "Grid", "Palette", "Fills", "Motion", "Grain", "GIF Export", "Image Export", "Video Export"];
    const positions = order.map((title) => titles.indexOf(title));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("binds every Mosaic control to the targets the renderer reads", () => {
    const targets = (id: string) => Object.values(productSection(id)?.controls ?? {}).map((control) => control.target);
    expect(targets("grid")).toEqual(
      expect.arrayContaining(["layout.seed", "layout.square", "layout.cellWidth", "layout.cellHeight", "layout.density", "layout.snap", "layout.varianceX", "layout.varianceY", "layout.splitBias"]),
    );
    expect(targets("palette")).toEqual(["palette.colors"]);
    expect(targets("fills")).toEqual(expect.arrayContaining(["fill.solid", "fill.gradient", "fill.dither", "fill.ditherPattern", "fill.scanlines", "fill.scanlineDirection", "fill.dots", "fill.dotGrid"]));
    expect(targets("motion")).toEqual(["motion.drift", "motion.colorBreath", "motion.hueSteps", "motion.ditherScroll"]);
    expect(targets("runtime.setup")).toEqual(expect.arrayContaining(["frame.mode", "frame.edgeRemoval", "frame.explosionAmount", "export.includeBackground"]));
    expect(targets("grain")).toEqual(["grain.gradient", "grain.amount", "grain.discreteness", "grain.size", "grain.speed"]);
    expect(targets("gif-export")).toEqual(["gif.fps", "gif.width"]);
  });

  it("puts GIF export in the sticky footer beside runtime exports", () => {
    const footer = appSchema.panels.controls?.sections.find((section) => section.id === "runtime.export");
    const actions = Object.values(footer?.controls ?? {}).flatMap((control) => control.actions ?? []);
    expect(actions.map((action) => (typeof action === "string" ? action : action.value))).toEqual(
      expect.arrayContaining(["mosaic.exportGif"]),
    );
  });

  it("persists the workspace locally", () => {
    expect(appSchema.persistence.storage).toBe("localStorage");
  });
});
