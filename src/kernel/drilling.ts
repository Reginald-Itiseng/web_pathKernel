/**
 * Drill toolpath generation — strategy A single-tool boring.
 * Port of reference/PathKernel/app/core/drilling.py `build_drill_toolpath_layer`.
 *
 * Semantics: always plunge at hole center (encoded as an epsilon-length line so
 * HPGL export emits an explicit pen-down), then if the hole is larger than the
 * tool, bore concentric full-circle passes at the radial stepover.
 */
import { flattenArc, pathLength } from './geom2d';
import type { DrillFeature, DrillParams, KernelOpResult, KPoint, Stroke } from './types';

export interface DrillInput {
  id: string;
  layerId: string;
  label: string;
  toolNumber: number;
  holes: DrillFeature[];
  params: DrillParams;
}

const EPSILON_PLUNGE = 1e-4;

/**
 * Strategy-A machining of a single hole: explicit center plunge (ε-line so
 * HPGL emits a pen-down) plus concentric CCW boring arcs when the hole is
 * larger than the tool. Shared by drilling and centering-holes ops.
 */
export function boreHole(
  x: number,
  y: number,
  holeDiameter: number,
  toolDia: number,
  stepoverMm: number,
): { strokes: Stroke[]; polylines: KPoint[][]; borePasses: number } {
  const strokes: Stroke[] = [];
  const polylines: KPoint[][] = [];

  const start: KPoint = { x, y };
  const plungeEnd: KPoint = { x: x + EPSILON_PLUNGE, y };
  strokes.push({ type: 'line', start, end: plungeEnd });
  polylines.push([start, plungeEnd]);

  const orbitRadius = Math.max(0, (holeDiameter - toolDia) / 2);
  let borePasses = 0;
  if (orbitRadius > 0.0005) {
    const passes = Math.max(1, Math.ceil(orbitRadius / stepoverMm));
    for (let passIdx = 1; passIdx <= passes; passIdx++) {
      const passRadius = orbitRadius * (passIdx / passes);
      const arcStart: KPoint = { x: x + passRadius, y };
      strokes.push({ type: 'arc', start: arcStart, end: arcStart, center: { x, y }, ccw: true });
      polylines.push(flattenArc(arcStart, arcStart, { x, y }, true));
      borePasses++;
    }
  }
  return { strokes, polylines, borePasses };
}

export function buildDrillToolpaths(input: DrillInput): KernelOpResult {
  const { holes, params } = input;
  if (holes.length === 0) {
    throw new Error('No drill holes found in selected layer.');
  }

  const toolDia = Math.max(0.001, params.toolDiameterMm);
  const stepoverPct = Math.max(1, Math.min(100, params.lateralStepoverPct));
  const stepoverMm = Math.max(0.0005, (toolDia / 2) * (stepoverPct / 100));

  const strokes: Stroke[] = [];
  const previewPolylines: KPoint[][] = [];
  const warnings: string[] = [];

  let plungeCount = 0;
  let boreHoleCount = 0;
  let borePassCount = 0;
  let skippedSmallHoles = 0;
  let oversizedHoles = 0;
  let slotCount = 0;

  for (const hole of holes) {
    if (hole.type === 'slot') {
      if (hole.width < toolDia - 0.0005 && !params.allowOversizeForSmallHoles) {
        skippedSmallHoles++;
        continue;
      }
      if (hole.width < toolDia - 0.0005) oversizedHoles++;

      const start = hole.segments[0].start;
      const plungeEnd: KPoint = { x: start.x + EPSILON_PLUNGE, y: start.y };
      strokes.push({ type: 'line', start, end: plungeEnd });
      previewPolylines.push([start, plungeEnd]);
      for (const segment of hole.segments) {
        if (segment.type === 'line') {
          strokes.push(segment);
          previewPolylines.push([segment.start, segment.end]);
        } else {
          strokes.push({ type: 'arc', start: segment.start, end: segment.end, center: segment.center, ccw: segment.ccw });
          previewPolylines.push(flattenArc(segment.start, segment.end, segment.center, segment.ccw));
        }
      }
      plungeCount++;
      slotCount++;
      continue;
    }
    if (hole.diameter <= 0) continue;

    if (hole.diameter < toolDia - 0.0005) {
      if (!params.allowOversizeForSmallHoles) {
        skippedSmallHoles++;
        continue;
      }
      oversizedHoles++;
    }

    const bored = boreHole(hole.x, hole.y, hole.diameter, toolDia, stepoverMm);
    strokes.push(...bored.strokes);
    previewPolylines.push(...bored.polylines);
    plungeCount++;
    if (bored.borePasses > 0) {
      boreHoleCount++;
      borePassCount += bored.borePasses;
    }
  }

  if (strokes.length === 0) {
    throw new Error(
      'Drill toolpath generation produced no commands. Tool may be too large for all holes.',
    );
  }
  if (skippedSmallHoles > 0) {
    warnings.push(
      `${skippedSmallHoles} hole(s) smaller than the ${toolDia.toFixed(3)}mm tool were skipped.`,
    );
  }
  if (oversizedHoles > 0) {
    warnings.push(
      `${oversizedHoles} hole(s) smaller than the tool will be drilled oversize at ${toolDia.toFixed(3)}mm.`,
    );
  }

  let totalLength = 0;
  for (const line of previewPolylines) totalLength += pathLength(line);

  return {
    id: input.id,
    kind: 'drill',
    layerId: input.layerId,
    label: input.label,
    toolNumber: input.toolNumber,
    effectiveToolDiameterMm: toolDia,
    strokes,
    previewPolylines,
    warnings,
    meta: {
      kind: 'drill_toolpath',
      drill_strategy: 'A',
      drill_tool_diameter_mm: toolDia.toFixed(6),
      drill_lateral_stepover_pct: stepoverPct.toFixed(3),
      drill_lateral_stepover_mm: stepoverMm.toFixed(6),
      drill_hole_count: String(holes.length),
      drill_slot_count: String(slotCount),
      drill_plunge_count: String(plungeCount),
      drill_bore_hole_count: String(boreHoleCount),
      drill_bore_pass_count: String(borePassCount),
      drill_skipped_small_holes: String(skippedSmallHoles),
      drill_oversize_small_holes: String(oversizedHoles),
      drill_allow_oversize_tool_for_small_holes: String(params.allowOversizeForSmallHoles),
    },
    stats: {
      pathLengthMm: totalLength,
      strokeCount: strokes.length,
      plungeCount,
      boreHoleCount,
      borePassCount,
      skippedSmallHoles,
      oversizedHoles,
    },
  };
}
