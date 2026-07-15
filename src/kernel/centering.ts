/**
 * Registration (centering) holes for double-sided milling.
 * Port of reference/PathKernel/app/core/centering_holes.py generalized to
 * 2–4 holes.
 *
 * Industry practice (pin registration): all holes lie ON the flip axis,
 * outside the board outline. Flipping the stock about the line through the
 * holes brings the second side into exact registration; extra holes (3–4) are
 * placed further out along the same axis for pin redundancy/rigidity.
 */
import { boreHole } from './drilling';
import { pathLength } from './geom2d';
import type {
  CenteringParams,
  KernelOpResult,
  KPoint,
  MirrorAxis,
  Stroke,
} from './types';

export interface CenteringInput {
  id: string;
  layerId: string;
  label: string;
  toolNumber: number;
  /** Board bounding box [minX, minY, maxX, maxY] in mm. */
  boardBounds: [number, number, number, number];
  params: CenteringParams;
}

/** Hole centers, all on the flip axis, outside the board bounds. */
export function centeringHoleCenters(
  boardBounds: [number, number, number, number],
  params: Pick<
    CenteringParams,
    'orientation' | 'holeCount' | 'outlineToHoleCenterMm' | 'holeSpacingMm'
  >,
): KPoint[] {
  const [minX, minY, maxX, maxY] = boardBounds;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const dist = Math.max(0, params.outlineToHoleCenterMm);
  const spacing = Math.max(1, params.holeSpacingMm);
  const count = Math.max(2, Math.min(4, Math.floor(params.holeCount)));

  const centers: KPoint[] = [];
  if (params.orientation === 'vertical') {
    // Axis = vertical centerline x = cx; holes below and above the board.
    centers.push({ x: cx, y: minY - dist }, { x: cx, y: maxY + dist });
    if (count >= 3) centers.push({ x: cx, y: maxY + dist + spacing });
    if (count >= 4) centers.push({ x: cx, y: minY - dist - spacing });
  } else {
    // Axis = horizontal centerline y = cy; holes left and right of the board.
    centers.push({ x: minX - dist, y: cy }, { x: maxX + dist, y: cy });
    if (count >= 3) centers.push({ x: maxX + dist + spacing, y: cy });
    if (count >= 4) centers.push({ x: minX - dist - spacing, y: cy });
  }
  return centers;
}

/**
 * The flip axis implied by the centering holes: the line THROUGH the holes.
 * Horizontal orientation → horizontal line y = cy (flip top↔bottom, mirror Y);
 * vertical orientation → vertical line x = cx (flip left↔right, mirror X).
 */
export function centeringMirrorAxis(
  boardBounds: [number, number, number, number],
  orientation: CenteringParams['orientation'],
): MirrorAxis {
  const [minX, minY, maxX, maxY] = boardBounds;
  return orientation === 'vertical'
    ? { axis: 'x', position: (minX + maxX) / 2 }
    : { axis: 'y', position: (minY + maxY) / 2 };
}

export function buildCenteringHoles(input: CenteringInput): KernelOpResult {
  const { params, boardBounds } = input;
  const [minX, minY, maxX, maxY] = boardBounds;
  if (maxX - minX <= 1e-9 || maxY - minY <= 1e-9) {
    throw new Error('Centering holes require a valid board bounding box.');
  }

  const holeDia = Math.max(0.001, params.holeDiameterMm);
  const toolDia = Math.max(0.001, params.toolDiameterMm);
  const stepoverPct = Math.max(1, Math.min(100, params.lateralStepoverPct));
  const stepoverMm = Math.max(0.0005, (toolDia / 2) * (stepoverPct / 100));

  const centers = centeringHoleCenters(boardBounds, params);

  const strokes: Stroke[] = [];
  const previewPolylines: KPoint[][] = [];
  let plungeCount = 0;
  let boreHoleCount = 0;
  let borePassCount = 0;

  for (const center of centers) {
    const bored = boreHole(center.x, center.y, holeDia, toolDia, stepoverMm);
    strokes.push(...bored.strokes);
    previewPolylines.push(...bored.polylines);
    plungeCount++;
    if (bored.borePasses > 0) {
      boreHoleCount++;
      borePassCount += bored.borePasses;
    }
  }

  const warnings: string[] = [];
  if (toolDia > holeDia + 1e-9) {
    warnings.push(
      `Centering tool (${toolDia.toFixed(3)}mm) is larger than the hole (${holeDia.toFixed(3)}mm) — holes will be oversize.`,
    );
  }

  let totalLength = 0;
  for (const line of previewPolylines) totalLength += pathLength(line);

  return {
    id: input.id,
    kind: 'centering',
    layerId: input.layerId,
    label: input.label,
    toolNumber: input.toolNumber,
    effectiveToolDiameterMm: toolDia,
    strokes,
    previewPolylines,
    warnings,
    meta: {
      kind: 'centering_holes_toolpath',
      centering_orientation: params.orientation,
      centering_outline_to_hole_center_mm: params.outlineToHoleCenterMm.toFixed(6),
      centering_hole_spacing_mm: params.holeSpacingMm.toFixed(6),
      centering_hole_diameter_mm: holeDia.toFixed(6),
      centering_tool_diameter_mm: toolDia.toFixed(6),
      centering_lateral_stepover_pct: stepoverPct.toFixed(3),
      centering_hole_count: String(centers.length),
      centering_bore_hole_count: String(boreHoleCount),
      centering_bore_pass_count: String(borePassCount),
    },
    stats: {
      pathLengthMm: totalLength,
      strokeCount: strokes.length,
      plungeCount,
      boreHoleCount,
      borePassCount,
    },
  };
}
