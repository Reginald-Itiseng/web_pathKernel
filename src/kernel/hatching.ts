/**
 * Copper clearing (hatching): mills away copper OUTSIDE the isolation
 * keepout — everything isolation's thin channel doesn't already protect.
 * Port of reference/PathKernel/app/core/hatching.py `build_hatching_toolpath_layer`.
 */
import {
  clipOpenPathsOutside,
  differencePolygons,
  offsetPolygons,
  polysWithHoles,
  sweptOpenPaths,
} from './clip';
import { deriveIsolationToolGeometry } from './cncParams';
import { pathLength } from './geom2d';
import { hatchFillLines } from './hatchFill';
import { reorderForTravel, unitFromStrokes, type TravelUnit } from './pathOrder';
import type { HatchingParams, KernelOpResult, KPoint, Stroke } from './types';

const ORIGIN: KPoint = { x: 0, y: 0 };
/** Drop hatch segments shorter than this (matches the Python reference's 1e-6 mm). */
const MIN_LINE_LENGTH_MM = 1e-6;

export interface HatchingInput {
  id: string;
  layerId: string;
  label: string;
  toolNumber: number;
  copper: KPoint[][];
  /** Board cutout domain (ring soup: outer+holes together) — omit for a bbox+margin fallback. */
  boardDomainRings?: KPoint[][];
  /** Prior same-layer operations' preview polylines — kept as an additional keepout. */
  existingToolpathPreview?: KPoint[][];
  params: HatchingParams;
}

export function buildHatching(input: HatchingInput): KernelOpResult {
  const { copper, params } = input;
  if (copper.length === 0) {
    throw new Error('Could not derive copper geometry from this layer.');
  }

  // HatchingParams has no trace_margin_mm field in the Python reference
  // either — deriveIsolationToolGeometry is shared via a local adapter.
  const tool = deriveIsolationToolGeometry({ ...params, traceMarginMm: 0 });
  const effectiveRadius = tool.effectiveRadiusMm;
  const effectiveDiameter = tool.effectiveDiameterMm;
  const step = tool.hatchingMarginMm;
  const hatchAngle = params.hatchAngleDeg || 0;
  const copperKeepoutMargin = Math.max(0, params.copperKeepoutMarginMm || 0);
  const boundaryMargin = Math.max(0, params.boundaryMarginMm || 0);
  const safetyClearance = Math.max(0.005, effectiveRadius * 0.02);

  const warnings: string[] = [];

  const boardDomainProvided = (input.boardDomainRings?.length ?? 0) > 0;
  const clearDomain: KPoint[][] = boardDomainProvided
    ? input.boardDomainRings!
    : boundedBoxAround(copper, boundaryMargin);
  if (clearDomain.length === 0) {
    throw new Error('Could not derive a valid clearing domain for hatching.');
  }

  const copperKeepout = offsetPolygons(
    copper,
    effectiveRadius + copperKeepoutMargin + safetyClearance,
    params.joinStyle,
  );
  let clearRegion = differencePolygons(clearDomain, copperKeepout);
  if (clearRegion.length === 0) {
    throw new Error('No hatchable region remains after copper keepout.');
  }

  const existingPreview = input.existingToolpathPreview ?? [];
  if (existingPreview.length > 0) {
    const keepoutExpand = Math.max(0.001, effectiveRadius * 0.1);
    const swept = sweptOpenPaths(existingPreview, keepoutExpand);
    if (swept.length > 0) {
      clearRegion = differencePolygons(clearRegion, swept);
    }
    if (clearRegion.length === 0) {
      throw new Error('No hatchable region remains after existing toolpath keepout.');
    }
  }

  const polys = polysWithHoles(clearRegion);
  const rawLines = hatchFillLines(polys, step, hatchAngle);

  // Safety clip: re-clip against the SAME copper keepout with Clipper's own
  // (exact, no half-open edge case) engine — the real safety guarantee, not
  // hatchFillLines' own scanline boundary handling. See hatchFill.ts.
  const safeLines =
    copperKeepout.length > 0 ? clipOpenPathsOutside(rawLines, copperKeepout) : rawLines;

  const strokes: Stroke[] = [];
  const units: TravelUnit[] = [];
  for (const line of safeLines) {
    if (line.length < 2) continue;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      if (pathLength([a, b]) <= MIN_LINE_LENGTH_MM) continue;
      const stroke: Stroke = { type: 'line', start: a, end: b };
      units.push(unitFromStrokes([stroke]));
    }
  }
  if (units.length === 0) {
    throw new Error('No hatching toolpaths were generated with current parameters.');
  }

  // Nearest-neighbor sequencing across every hatch segment — pure row order
  // degrades badly once copper keepouts fragment a row into disconnected
  // pieces or split the clear area into several regions (common on a real
  // board); this handles that uniformly at near-zero extra cost.
  for (const s of reorderForTravel(units, ORIGIN)) strokes.push(s);

  const previewPolylines = strokes.map((s) => (s.type === 'line' ? [s.start, s.end] : []));
  let totalLength = 0;
  for (const line of previewPolylines) totalLength += pathLength(line);

  const meta: Record<string, string> = {
    kind: 'hatching',
    hatching_tool_profile: tool.profile,
    hatching_tool_diameter_mm: effectiveDiameter.toFixed(6),
    hatching_nominal_tool_diameter_mm: tool.nominalDiameterMm.toFixed(6),
    hatching_effective_radius_mm: effectiveRadius.toFixed(6),
    hatching_step_mm: step.toFixed(6),
    hatching_angle_deg: hatchAngle.toFixed(3),
    hatching_copper_keepout_margin_mm: copperKeepoutMargin.toFixed(6),
    hatching_safety_clearance_mm: safetyClearance.toFixed(6),
    hatching_boundary_margin_mm: boundaryMargin.toFixed(6),
    hatching_buffer_join_style: params.joinStyle,
    hatching_board_cutout_awareness: String(boardDomainProvided),
  };

  return {
    id: input.id,
    kind: 'hatching',
    layerId: input.layerId,
    label: input.label,
    toolNumber: input.toolNumber,
    effectiveToolDiameterMm: effectiveDiameter,
    strokes,
    previewPolylines,
    warnings,
    meta,
    stats: {
      pathLengthMm: totalLength,
      strokeCount: strokes.length,
    },
  };
}

/** Bounding box of a ring soup, expanded by `marginMm` — the no-board-outline fallback. */
function boundedBoxAround(rings: KPoint[][], marginMm: number): KPoint[][] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return [];
  return [
    [
      { x: minX - marginMm, y: minY - marginMm },
      { x: maxX + marginMm, y: minY - marginMm },
      { x: maxX + marginMm, y: maxY + marginMm },
      { x: minX - marginMm, y: maxY + marginMm },
    ],
  ];
}
