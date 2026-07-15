# PathKernel (Python) → web_pathKernel: Gap Analysis

Analysis of the reference Python kernel at `reference/PathKernel` (git-ignored) to decide
what to port, improve, or drop for the web version. Written 2026-07-14.

## 1. What the Python kernel is

PySide6 desktop CAM app for PCB milling. The valuable, portable part is `app/core/`:

| Module | Role | Verdict |
|---|---|---|
| `io.py` | Gerber/Excellon parsing via pcb-tools + gerbonara backends, normalized into simple primitive dataclasses (`Line`, `Arc`, `Circle`, `Drill`, `Region`, `AMGroup`, obround, roundrect) with `level_polarity` (dark/clear) and `flashed` flags | **Port the principle**: parse to primitives, not to SVG |
| `cnc_params.py` | V-bit effective-width math (CopperCAM-style) | **Port verbatim** (trivial, high value) |
| `isolation.py` | True isolation routing on a real copper polygon | **Port — this is the crown jewel** |
| `hatching.py` | Copper clearing constrained by board domain + keepouts | **Port** |
| `cutout.py` | Board outline loops with snapping, compensation, holding tabs | **Port** |
| `drilling.py` | Single-tool boring strategy (plunge + concentric arcs) | **Port** |
| `hpgl.py` | HPGL/HPGL2 export incl. Bungard dialect, PD batching, speeds | **Port incrementally** |
| `camlib.py` | Vendored FlatCAM reference (imports PyQt6/appCommon that don't exist here — not wired in) | **Ignore; reference reading only** |
| `surfacing.py`, `centering_holes.py` | Bed surfacing, centering-hole wizard | Later / optional |

`tests/` covers cutout, drilling, hatching, HPGL arc export, surfacing — good spec source.
`Projects/*.plt` are real exported HPGL outputs usable as golden benchmark files.

## 2. Core algorithms worth stealing

### 2.1 Copper geometry derivation (`isolation._build_copper_geometry`)
Primitives → polygons → `union(dark) − union(clear)`. Everything downstream operates on
this **true copper polygon**, not on drawing artifacts. This is the single biggest
architectural difference from the web version.

### 2.2 V-bit effective diameter (`cnc_params.calculate_coppercam_params`)
```
effective_radius = tip_dia/2 + depth · tan(angle/2)
step-over (hatching margin) = effective_radius   # 50% overlap
trace_compensation = effective_radius
```
Feeds isolation offset, pass spacing, and clearing step-over for conical tools.

### 2.3 Isolation routing (`isolation.build_isolation_layer`)
- Pass *i* offset = `trace_compensation + trace_margin + i·step`; geometry =
  `copper.buffer(±offset).boundary` (exterior / interior / both).
- **Min copper gap detection**: pairwise polygon distance with bbox lower-bound pruning
  and check budget (250k) → warn when `D_eff > gap`; optional *skip tight clearance
  passes* (skip pass when `2·offset > min_gap`).
- **Extra pad contours**: extra rings around flashed pads only (circle/obround/
  roundrect/AMGroup), subtracting the **swept area** (paths buffered by tool radius,
  shrunk ~2% to avoid float-tolerance clipping) of already-generated paths as keepout,
  and staying clear of non-pad copper.
- Output: line primitives + rich metadata (every derived parameter recorded on the layer).

### 2.4 Copper clearing (`hatching.build_hatching_toolpath_layer`)
- Clear domain = board cutout loops (or copper bbox + margin fallback).
- Forbidden = copper ∪ selected keepout layers, buffered by
  `tool_radius + keepout_margin + safety_clearance` (safety = max(5 µm, 2% of radius)).
- Serpentine scanlines at arbitrary angle (rotate region −θ, horizontal probes every
  step, alternate row direction, rotate back +θ).
- Already-cut toolpath layers become keepouts → no recutting.
- Double filter: drop lines whose swept area intersects copper; else clip via
  `line.difference(forbidden)`.

### 2.5 Cutout (`cutout.py`)
- Extracts closed loops from outline **centerline segments** with adaptive endpoint
  snapping (cluster endpoints, tolerance estimated from geometry) — handles the
  real-world "outline is a bag of unordered segments" problem.
- Even-odd nesting rule (`_loops_to_domain`): loop at even containment depth adds,
  odd depth subtracts → correct multi-board/window domains.
- Per-loop compensation (outside/inside/onpath by tool radius) + **holding tabs**
  (split path into N gaps of given width by arc-length).

### 2.6 Drilling (`drilling.py`)
Strategy A, single tool: always plunge at center (encoded as an ε-length line so HPGL
export emits an explicit plunge), then if hole > tool, concentric full-circle boring
passes at radial stepover = `tool_radius · stepover%`. Skip or oversize-drill
smaller-than-tool holes (configurable). Rich counters in metadata.

### 2.7 HPGL export (`hpgl.py`)
40 units/mm, polyline stitching with tolerance, arcs flattened at 0.05 mm chord,
PD batching (12 pairs/line), per-layer tool number + speed (`VS`) changes, optional
normalize-to-origin, Bungard dialect. Golden outputs in `Projects/*.plt`.

### 2.8 Cross-cutting principles
- Uniform layer transform pipeline: **mirror → rotate → translate**, applied
  identically in isolation/hatching/cutout/drilling/export.
- Derived layers carry complete provenance metadata (every parameter as a string).
- Arc flattening everywhere at 0.05 mm chord, 12–720 segment clamp.
- Polygon repair: `make_valid` → fallback `buffer(0)`.

## 3. Where the web version stands

Parsing is `gerber-to-svg` (tracespace v4) → **SVG string**, and all geometry is scraped
back out of the SVG DOM (`geometryUtils.ts`): pad defs from `<defs>`, pad instances from
`<use>`, "traces" from `stroke-width` classes. CAM ops (`camUtils.ts`) extract path
centerlines from the SVG — the "isolation" op is **trace centerlines, not isolation
offsets**. No polygon booleans, no offsetting, no clearing, no cutout compensation,
no tabs, no V-bit math. HPGL export is basic PU/PD.

What the web version has that the Python one lacks (keep and build on):
- Import report + confidence scoring, validation rule set (min trace/drill/annular
  ring), pad↔hole matching with ambiguity detection.
- Click-to-edit pads/traces in the 2D preview; 3D viewport.
- Zero-install browser UX.

## 4. The enabling decision: a real geometry engine

Everything in §2 assumes Shapely-style polygon booleans + buffering. The web equivalent:

- **Clipper2 (WASM/JS)** — `clipper2-js` or similar: robust booleans + offsetting
  (round/miter/bevel joins map to Shapely join styles). Recommended.
- For parsing: move from `gerber-to-svg` to **`@tracespace/parser` + `@tracespace/plotter`**
  (tracespace v5) which yield a geometry tree directly — the JS analogue of
  pcb-tools primitives — instead of scraping SVG. SVG stays as the *render* of the
  geometry, not the source of truth.
- Heavy ops (union of thousands of pads, min-gap scan) belong in a **Web Worker**.

## 5. Proposed porting order

1. **Geometry core**: primitive model + Clipper2 wrapper (union/difference/offset,
   join styles, polygon repair) in a worker. Port `_build_copper_geometry`.
2. **`cnc_params`** V-bit math (direct port + unit tests from Python tests).
3. **Isolation**: multi-pass offsets, min-gap warning, skip-tight-clearance,
   extra pad contours with swept keepout.
4. **HPGL export parity**: stitching, arc chords, PD batching — validate against
   `reference/PathKernel/Projects/*.plt` goldens.
5. **Cutout**: loop extraction w/ endpoint snapping, compensation, holding tabs.
6. **Drilling**: strategy A boring.
7. **Hatching**: board-domain-constrained clearing with keepouts.
8. Benchmarks: run Python kernel on `test_gerbers/motor_driver`, compare path length,
   runtime, and output geometry vs web implementation.

## 6. Benchmark assets

- Web repo: `test_gerbers/motor_driver` (KiCad: F_Cu, B_Cu, Edge_Cuts, .drl, .gbrjob).
- Python repo: `tests/` (behavioral specs), `Projects/*.plt` (golden HPGL),
  `tmp_test_project.pkproj` (sample project).
- Python env: Python 3.11+, `pip install -e reference/PathKernel` (PySide6 heavy;
  core modules import shapely only, so headless benchmarking of `app.core.*` is
  possible without Qt).
