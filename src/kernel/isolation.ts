/**
 * Isolation routing: multi-pass buffered offsets around true copper geometry.
 * Port of reference/PathKernel/app/core/isolation.py `build_isolation_layer`.
 */
import { offsetPolygons } from './clip';
import { deriveIsolationToolGeometry } from './cncParams';
import { minimumCopperGap } from './copper';
import { pathLength } from './geom2d';
import type { IsolationParams, KernelOpResult, KPoint, Stroke } from './types';

export interface IsolationInput {
  id: string;
  layerId: string;
  label: string;
  toolNumber: number;
  copper: KPoint[][];
  params: IsolationParams;
}

export function buildIsolation(input: IsolationInput): KernelOpResult {
  const { copper, params } = input;
  if (copper.length === 0) {
    throw new Error('Could not derive copper geometry from this layer.');
  }

  const tool = deriveIsolationToolGeometry(params);
  const effectiveRadius = tool.effectiveRadiusMm;
  const effectiveDiameter = tool.effectiveDiameterMm;
  const step = tool.hatchingMarginMm;
  const offsetStart = tool.traceCompensationMm;
  const passes = Math.max(1, Math.floor(params.passes));

  const warnings: string[] = [];
  const minGap = minimumCopperGap(copper);
  let clearanceWarning = '';
  if (minGap != null && effectiveDiameter > minGap + 1e-9) {
    clearanceWarning =
      'effective tool width exceeds minimum copper gap: ' +
      `D_eff=${effectiveDiameter.toFixed(4)}mm > gap=${minGap.toFixed(4)}mm`;
    warnings.push(clearanceWarning);
  }

  const strokes: Stroke[] = [];
  const previewPolylines: KPoint[][] = [];
  let skippedPasses = 0;

  for (let i = 0; i < passes; i++) {
    const offset = offsetStart + i * step;
    if (
      params.skipTightClearancePaths &&
      minGap != null &&
      2 * offset > minGap + 1e-9
    ) {
      skippedPasses++;
      warnings.push(
        `skipped pass ${i + 1}/${passes} due to tight clearance ` +
          `(offset=${offset.toFixed(4)}mm, min_gap=${minGap.toFixed(4)}mm)`,
      );
      continue;
    }
    const rings = isolationRings(copper, offset, params);
    for (const ring of rings) {
      if (ring.length < 3) continue;
      // Close the ring explicitly so exports and previews trace a full loop.
      const closed = [...ring, ring[0]];
      strokes.push({ type: 'polyline', points: closed });
      previewPolylines.push(closed);
    }
  }

  if (strokes.length === 0) {
    throw new Error('Isolation produced no geometry with current parameters.');
  }

  let totalLength = 0;
  for (const line of previewPolylines) totalLength += pathLength(line);

  const meta: Record<string, string> = {
    kind: 'isolation',
    isolation_tool_profile: tool.profile,
    isolation_tool_diameter_mm: effectiveDiameter.toFixed(6),
    isolation_nominal_tool_diameter_mm: tool.nominalDiameterMm.toFixed(6),
    isolation_effective_radius_mm: effectiveRadius.toFixed(6),
    isolation_hatching_margin_mm: step.toFixed(6),
    isolation_trace_compensation_mm: offsetStart.toFixed(6),
    isolation_tool_tip_diameter_mm: tool.tipDiameterMm.toFixed(6),
    isolation_tool_angle_deg: tool.angleDeg.toFixed(6),
    isolation_cutting_depth_mm: tool.cuttingDepthMm.toFixed(6),
    isolation_trace_margin_mm: tool.traceMarginMm.toFixed(6),
    isolation_buffer_join_style: params.joinStyle,
    isolation_passes: String(passes),
    isolation_overlap: params.overlap.toFixed(3),
    isolation_type: params.isoType,
  };
  if (minGap != null) meta.minimum_copper_gap_mm = minGap.toFixed(6);
  if (clearanceWarning) meta.tool_clearance_warning = clearanceWarning;

  return {
    id: input.id,
    kind: 'isolation',
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
      skippedPasses,
    },
  };
}

/**
 * Boundary rings of copper offset by ±offset, per iso type.
 * Port of Python `_isolation_geometry` — the offset polygon's rings ARE the
 * boundary loops shapely's `.boundary` would return.
 */
function isolationRings(
  copper: KPoint[][],
  offset: number,
  params: Pick<IsolationParams, 'isoType' | 'joinStyle'>,
): KPoint[][] {
  if (offset <= 0) return [];
  const out: KPoint[][] = [];
  if (params.isoType === 'exterior' || params.isoType === 'both') {
    out.push(...offsetPolygons(copper, offset, params.joinStyle));
  }
  if (params.isoType === 'interior' || params.isoType === 'both') {
    out.push(...offsetPolygons(copper, -offset, params.joinStyle));
  }
  return out;
}
