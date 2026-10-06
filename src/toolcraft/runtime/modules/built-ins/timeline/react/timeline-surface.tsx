"use client";
import * as React from "react";
import { TimelinePanel } from "../../../../react/timeline/timeline-panel";

/** Mosaic override: the timeline always shows its full (extended) panel; there is no compact toggle. */
export function TimelineSurface(): React.JSX.Element {
  return <TimelinePanel panelPlacement="floating" variant="extended" />;
}
