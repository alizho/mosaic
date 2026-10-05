# Toolcraft App Agent Worklog

## Status

Mode: product

Active change: mosaic-palette-dither-ui

## Decision Trail

### mosaic-initial

- Change ID: mosaic-initial
- Request: Build a generative tool for animated "Rectilinear Mosaics" — zero-gap rectilinear partition (BSP/treemap slicing) with full-bleed or fixed-aspect bounds, min/max cell size and independent X/Y aspect variance; curated + custom palettes; concurrent weighted Solid / Gradient / Dither fill modes; grain boil; animated substrates (drifting stops, rotating gradients, palette shifts, dither phase) with seamless loops; PNG/SVG, GIF and WebM export.
- Task type: first product delivery (new multi-capability product, custom Canvas 2D renderer).
- User-visible result: Mosaic canvas tiling the artboard (finite) or an endless seeded field (Infinity), Grid / Palette / Fills / Motion / Grain / GIF Export sections, playback timeline, sticky Export GIF + Export PNG/JPG/SVG + Export MP4/WebM.
- Source/reference checked: One static reference image of a magenta/violet color-field grid (composition and palette only).
- Reference inputs: None (the static image is not a motion reference; `referenceInputs: []`).
- Docs/contracts read: AGENTS.md, workflow.md, core/runtime-boundary.md, assembly-workflow.md, core/control-selection.md, core/layout.md, core/setup-export.md, core/timeline-animation.md, core/performance.md, schema-reference.md, component-rules.md, renderer-technique.md, acceptance-testing.md.
- Contract rules applied: runtime shell via `composeToolcraftApp`; product output only in `scene.canvasContent`; `sceneBoundsProvider` = artboard rect in both modes; Infinity full-bleed via preview-only `scene.infiniteCanvasContent`; runtime-owned Setup sizing/aspect presets, Background pair, render scale; runtime image/SVG/video export through `rasterFrameRenderer`/`vectorFrameRenderer`; playback timeline with `getToolcraftTimelineLoopProgress`.
- Contract exception (owner-approved): animated GIF is not a runtime artifact type. The owner explicitly approved breaking the export contract and integrity checks for GIF and removing the instruction from AGENTS.md. `src/mosaic/gif-export.ts` renders frames, `src/mosaic/gif-encoder.ts` encodes GIF89a, and a sticky `panelActions` action downloads the file. AGENTS.md carries the scoped exception.
- View interaction intent: non-spatial — flat 2D composition, no 3D scene or model.
- Interaction ownership: none — every operation is a panel property edit; the canvas has no editing handles.
- Decision: Canvas 2D renderer with a cached guillotine BSP structure and per-frame substrate evaluation; SVG decomposes ordered dither exactly per threshold rank into pattern lattices clipped to half-planes/circle complements.
- Alternatives rejected: WebGL/WebGPU (cells are few large rects; Canvas 2D gradients plus low-resolution dither blits measure ~5 ms per 7680×4320 frame); raster-in-SVG (forbidden; dither is reproduced as real vectors instead); MediaRecorder for GIF (no GIF support; custom encoder instead).
- State/output mapping: `layout.*` → tessellation (cached by structural key) → preview canvas, Infinity tiles, PNG/JPG/MP4/WebM frames, SVG rects and GIF frames; `palette.*` and `fill.*` → per-cell colors/modes; `motion.*` × timeline loop progress → gradient angle, mid-stop, radial center, palette index, dither lattice offset; `grain.*` × loop progress → stepped noise frame (raster outputs only); `gif.*` + timeline duration → GIF frame count/size; `appearance.background`/`export.includeBackground` → runtime background (GIF always flattens onto it).
- Verification: Unit tests (`src/mosaic/mosaic.test.ts`, 16 passing) prove exact zero-gap coverage, no overlap, min/max limits, module snapping, seeded determinism, seamless loop at progress 0/1, enabled-fill filtering, dither rank permutations and GIF LZW round-trip. Product schema tests (`src/app/app-schema.test.ts`) pass. Manual in-app browser checks: live render, Shuffle, Infinity tiling, SVG-vs-raster parity, GIF decode (20 frames, 100 ms, looping). Protected `verify:delivery` was not run: acceptance rows for each control are not authored yet and the integrity check fails on the approved AGENTS.md edit and pre-existing `.claude/skills` symlinks.
- Risks: see Risks.

### mosaic-grain-motion-edges

- Entry type: focused
- Change ID: mosaic-grain-motion-edges
- Request: Restrict grain to gradient cells and integrate it into the gradient interpolant with continuous (simplex) temporal flow; remove rotation animation; replace stepped palette cycling with smooth breathing toward palette hues; add bounded-mode "Explode Edges" toggle and "Edge Removal Amount" slider that randomly prunes perimeter cells.
- Changed owner: `src/mosaic/gradient-gl.ts` (new WebGL2 gradient pass: 4D simplex noise sampled at (x, y, r·cos 2πp, r·sin 2πp) perturbs the warped gradient parameter), `src/mosaic/render-canvas.ts` (global grain pass removed; gradients via GL with Canvas-gradient fallback), `src/mosaic/cells.ts` (no angle animation; OKLab hue tour per gradient stop; perimeter pruning), `src/mosaic/palettes.ts` (OKLab mix), `src/mosaic/params.ts`, `src/mosaic/schema-sections.ts` (Grain: Intensity/Grain size/Shimmer; Motion: Stop drift/Color breath/Hue steps/Dither scroll; new Edges section), `src/mosaic/render-svg.ts` (pruned cells omitted), `src/app/app-acceptance-data.ts` inventory, `src/app/app-defaults.json` (owner-saved defaults migrated: removed `motion.turns`, `motion.paletteCycles`, `grain.boilRate`; added new targets, owner values preserved).
- User-visible result: Solid and dither cells are noise-free; gradient grain flows smoothly and loops seamlessly; colors breathe continuously; Edges section appears only when Infinity canvas is off and prunes frame-touching cells into raw gaps (also in PNG/SVG/video/GIF).
- Verification: `src/mosaic/mosaic.test.ts` 20 passing (adds continuity/no-rotation, static solids/dithers, monotone perimeter-only pruning, bounded gating); schema tests pass; tsc passes. Browser: Explode Edges hides in Infinity and returns in bounded mode; gradient grain crops at t=0/0.15 inspected; 7.6 ms per 7680×4320 frame; GIF and SVG regenerate.
- Risks: The acceptance validator rejects `canvas.infinity` as an applicability predicate target ("does not exist") although the runtime panel resolves it correctly; kept because the request scopes the controls to bounded mode. WebGL2 unavailable → gradients fall back to grain-free canvas gradients.

### mosaic-riso-settings

- Entry type: focused
- Change ID: mosaic-riso-settings
- Request: Remove Toolcraft validator and acceptance tests; move Explode Edges into Settings; exploded gaps must be transparent; replace muddy cloud grain with sharp risograph grain on gradients.
- Changed owner: deleted `src/app/acceptance`, `src/app/app-acceptance*`, `src/app/app-performance*`, `src/app/test-evidence`, `e2e/`, `playwright.config.ts`, verification scripts (kept the 12 scripts + 2 declarations needed by dev/build); `package.json` scripts trimmed. Runtime patch: `schema/runtime-setup-section.ts` + `schema/panels-schema-normalization.ts` accept product controls tagged `semanticGroup: "settings-product"`. `src/mosaic/gradient-gl.ts` grain is now a stochastic riso screen (per-speck threshold, triangle-wave twinkle with integer cycles per loop, coarse ink clumping, nearest-neighbour composite). `MosaicCanvas.tsx` turns Background off when Explode Edges turns on (and back if it did so). GIF encoder supports 1-bit transparency.
- Verification: 26 unit tests pass (adds GIF transparency); tsc passes; browser: Explode Edges in Settings, Background auto-off, transparent gaps, crisp grain close-ups, transparent GIF decode.
- Risks: Backup of the pre-removal tree is at the session scratchpad `mosaic-pre-validator-removal.tgz`.

### mosaic-palette-dither-ui

- Entry type: focused
- Change ID: mosaic-palette-dither-ui
- Request: Remove palette presets (custom editor only, default #0000FF #FFFFFF #FFFFFF #FFBCEE #CFFF54 #000000); dither modes Bayer 8x8 ("Bayer"), Floyd-Steinberg ("F-S"), Random; grain on Gradient and Dither cells with a Discreteness control; sharp 0px UI, #0000FF checked accent, always-white toggle knob.
- Changed owner: `palettes.ts`, `params.ts`, `dither.ts` (shared per-dot ink mask for all three modes), `fill-gl.ts` (renamed from gradient-gl; dither masks uploaded as R8UI textures; grain screen blends soft two-octave field ↔ crisp per-speck field), `render-canvas.ts`, `render-svg.ts` (F-S/Random as merged dot runs), `schema-sections.ts`, `app-defaults.json`, `src/styles.css` (global radius 0, checkbox/switch accent, white thumb).
- Verification: 26 unit tests (tone preservation + seamless loop for each dither mode); tsc; build; browser close-ups of the three dither modes and discreteness 0/0.5/1; SVG export valid for all modes; knob white in light and dark.
- Risks: F-S/Random SVG files are large (≈0.6–1 MB per frame) because every run of dots is a rect.

## Decisions

### Renderer

- Decision: Product-owned Canvas 2D renderer (`src/mosaic/render-canvas.ts`) shared by live preview, Infinity tiles, runtime raster export and GIF; SVG renderer (`src/mosaic/render-svg.ts`) for editable vectors.
- Reason: Output is a few dozen axis-aligned cells; native canvas gradients and nearest-neighbour dither blits are cheap, and one draw function guarantees preview/export parity.
- Evidence: Measured ~5.5 ms/frame at 7680×4320 after caching grain patterns per context (30 ms before).

### View Interaction

- Decision: non-spatial.
- Reason: Flat 2D color-field composition.
- Evidence: No 3D scene, model or orientation target exists.

### Interaction Ownership

- Decision: Panel only; no canvas handles.
- Reason: All parameters are global properties without spatial correspondence.
- Evidence: `interactionOwnership: []`.

### Timeline

- Decision: Playback timeline, default 6 s loop.
- Reason: The request asks for looping motion and video/GIF export; every motion completes integer cycles per loop so any duration is seamless.
- Evidence: Loop seam unit test at progress 0 and 1; GIF frame times divide the loop evenly.

### Layers

- Decision: No Layers module.
- Reason: No layer workflow was requested.
- Evidence: `panels.layers` is undefined.

### Controls

- Decision: Grid (seed, shuffle, cell size range, density, module snap, X/Y variance, aspect bias), Palette (preset + custom collection), Fills (three switches with conditional weights, gradient type, dither pattern, dot size), Motion (drift, gradient turns, palette cycles, dither scroll), Grain (intensity, size, boil rate), GIF Export (frame rate, width).
- Reason: Built-ins cover every value model: `rangeSlider` for min/max, `collectionActions` with `color` items for custom hex values, `switch` + conditional sliders for the weighted multi-select fill modes, discrete sliders for integer cycles.
- Evidence: `appControlSectionInventory` in `src/app/app-acceptance-data.ts`.

### Export

- Decision: Runtime PNG/JPG/SVG and MP4/WebM, plus the owner-approved product GIF export.
- Reason: SVG and WebM explicitly requested ("Static snapshot (PNG/SVG).", "Animated GIF / WebM recorder…"); grain is raster-only and omitted from SVG by owner decision.
- Evidence: SVG parity check against raster at the same timeline time; GIF decoded with ImageDecoder.

### Performance

- Decision: Functional delivery only; no measured performance or renderer pipeline registration yet.
- Reason: The workload envelope (cell count, dither area, GIF frames) and its pipeline/fixtures are part of the outstanding verification work.
- Evidence: `src/app/app-performance.ts` still declares the starter envelope; the performance gate reports unmapped workload controls `gif.fps`, `gif.width`, `export.image.resolution`.

## Evidence

- Source reviewed: Toolcraft runtime (`useToolcraftProductSceneFrame`, export frame renderers, panel actions, timeline loop helpers, canvas viewport world transform).
- Contract applied: see Decision Trail.

## Verification

- `npx tsc --noEmit`: passes.
- `npx vitest run src/mosaic src/app/app-schema.test.ts`: 21 passed.
- Protected `npm run test` / `npm run verify:delivery`: not passing (see Risks).

## Risks

- Risk: Acceptance rows and product browser scenarios (`e2e/product-*.spec.ts`) for every control, artifact, timeline, render scale and Infinity behavior are not authored, so the protected delivery gate cannot pass yet.
- Risk: Integrity check fails by design on the owner-approved AGENTS.md exception and on pre-existing `.claude/skills` symlinks.
- Risk: Code-health boundary flags the GIF encoder/download (approved exception) and SVG node creation; the latter also flags the framework's own documented SVG example, so it is a framework inconsistency rather than a product choice.
- Risk: Live preview backing follows CSS × DPR × Resolution scale; at DPR 2 and scale 2 a 1920×1080 artboard is 7680×4320, which is heavy on low-end GPUs.
