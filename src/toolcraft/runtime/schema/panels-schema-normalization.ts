import {
  createToolcraftRuntimeSetupSection,
  toolcraftSettingsProductGroup,
} from "./runtime-setup-section";
import {
  createToolcraftRuntimeDefaultsSection,
  toolcraftRuntimeDefaultsSectionId,
} from "./runtime-defaults-section";
import { extractToolcraftRuntimeSetupBackground } from "./runtime-setup-background";
import { normalizeControlsPanelLayout } from "./controls-panel-normalization";
import { resolveToolcraftControlSectionId } from "./controls-panel-section-id";
import { resolveToolcraftTimelinePanel } from "./schema-resolvers";
import type {
  ResolvedToolcraftPanelsSchema,
  ResolvedToolcraftSettingsTransferSchema,
  ToolcraftPanelsSchema,
} from "./types";
import type { ResolvedToolcraftAppSchema } from "./resolved-app-schema";
export function normalizeToolcraftPanels({
  canvas,
  panels,
  settingsTransfer,
}: {
  canvas: ResolvedToolcraftAppSchema["canvas"];
  panels: ToolcraftPanelsSchema;
  settingsTransfer: ResolvedToolcraftSettingsTransferSchema;
}): ResolvedToolcraftPanelsSchema {
  const normalizedTimeline = resolveToolcraftTimelinePanel(panels.timeline);
  const normalizedPanels: ResolvedToolcraftPanelsSchema = {
    ...(panels.layers ? { layers: panels.layers } : {}),
    ...(normalizedTimeline ? { timeline: normalizedTimeline } : {}),
  };

  if (!panels.controls) {
    return normalizedPanels;
  }

  const controls = { ...panels.controls };
  // Product controls tagged for Settings join the runtime Setup section. They
  // are collected from every section (including an already-materialized
  // Setup) so repeated normalization stays idempotent.
  const productSetupControls = Object.fromEntries(
    controls.sections.flatMap((section) =>
      Object.entries(section.controls).filter(
        ([, control]) => control.semanticGroup === toolcraftSettingsProductGroup,
      ),
    ),
  );
  const backgroundExtraction = extractToolcraftRuntimeSetupBackground({
    sections: controls.sections,
  });
  const runtimeSetupSection = createToolcraftRuntimeSetupSection({
    background: backgroundExtraction.background,
    canvas,
    productControls: productSetupControls,
    hasOrientationGizmo: controls.sections.some((section) =>
      Object.values(section.controls).some(
        (control) => control.type === "orientationGizmo",
      ),
    ),
    settingsTransfer,
    timeline: normalizedTimeline,
  });
  const authoredSections = backgroundExtraction.sections.flatMap((section) => {
    const remaining = Object.entries(section.controls).filter(
      ([, control]) => control.semanticGroup !== toolcraftSettingsProductGroup,
    );
    if (remaining.length === Object.keys(section.controls).length) return [section];
    return remaining.length > 0 ? [{ ...section, controls: Object.fromEntries(remaining) }] : [];
  }).filter((section) => {
    if (
      section.id !== "runtime.setup" &&
      section.id !== toolcraftRuntimeDefaultsSectionId
    ) {
      return true;
    }

    // Internal normalization is idempotent for already-materialized runtime
    // sections: validate the existing section before rebuilding it.
    resolveToolcraftControlSectionId(section);
    return false;
  });

  return {
    ...normalizedPanels,
    controls: normalizeControlsPanelLayout({
      ...controls,
      sections: [
        createToolcraftRuntimeDefaultsSection(),
        runtimeSetupSection,
        ...authoredSections,
      ],
    }),
  };
}
