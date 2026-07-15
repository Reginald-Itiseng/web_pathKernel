/**
 * HPGL / HPGL2 (Bungard dialect) export.
 * Port of reference/PathKernel/app/core/hpgl.py `export_to_bungard` and the
 * stroke stitching from `_layer_strokes`.
 *
 * Conventions (matching the Python kernel, deliberately unlike the old web
 * exporter): normalize-to-origin shift, NO Y inversion, 40 units/mm.
 */
import { flattenStroke, pointsClose } from './geom2d';
import { mirrorStroke } from './mirror';
import type { KernelOpResult, KPoint, MirrorAxis, Stroke } from './types';

const EPS = 1e-9;

export interface HpglOptions {
  unitsPerMm: number;
  normalizeToOrigin: boolean;
  /**
   * Machine origin as a point in circuit coordinates (e.g. the stock's
   * bottom-left corner). When set it overrides normalizeToOrigin: output
   * coordinates = circuit coordinates − this point.
   */
  absoluteOriginMm?: { x: number; y: number };
  /**
   * Flip axis for ops flagged `mirror` (bottom side / single-sided-from-back).
   * Applied here at export so GUI previews stay artwork-aligned.
   */
  mirrorAxis?: MirrorAxis | null;
  stitchToleranceMm: number;
  pdBatchPairs: number;
  /** Optional per-operation speeds keyed by operation id (mm/min). */
  speedsMmMin?: Record<string, number | undefined>;
  /** Optional slower speed used inside curved runs (mm/min), per op id. */
  roundedSpeedsMmMin?: Record<string, number | undefined>;
}

export const DEFAULT_HPGL_OPTIONS: HpglOptions = {
  unitsPerMm: 40,
  normalizeToOrigin: true,
  stitchToleranceMm: 1e-6,
  pdBatchPairs: 12,
};

export interface HpglExportResult {
  text: string;
  polylineCount: number;
  commandCount: number;
  offsetXMm: number;
  offsetYMm: number;
}

export function exportHpgl(
  operations: KernelOpResult[],
  options: Partial<HpglOptions> = {},
): HpglExportResult {
  const opts: HpglOptions = { ...DEFAULT_HPGL_OPTIONS, ...options };
  const scale = Math.max(1e-9, opts.unitsPerMm);
  const batchPairs = Math.max(1, Math.floor(opts.pdBatchPairs));

  let withStrokes = operations.filter((op) => op.strokes.length > 0);
  if (withStrokes.length === 0) {
    throw new Error('No toolpaths to export.');
  }

  // Export-time mirroring for flagged ops (previews stay artwork-aligned).
  const axis = opts.mirrorAxis;
  if (axis) {
    withStrokes = withStrokes.map((op) =>
      op.mirror ? { ...op, strokes: op.strokes.map((s) => mirrorStroke(s, axis)) } : op,
    );
  }

  // Global shift: explicit machine origin, or normalize-to-toolpath-minimum.
  let shiftX = 0;
  let shiftY = 0;
  if (opts.absoluteOriginMm) {
    shiftX = -opts.absoluteOriginMm.x;
    shiftY = -opts.absoluteOriginMm.y;
  } else if (opts.normalizeToOrigin) {
    let minX = Infinity;
    let minY = Infinity;
    for (const op of withStrokes) {
      for (const stroke of op.strokes) {
        for (const p of flattenStroke(stroke)) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
        }
      }
    }
    if (Number.isFinite(minX) && Number.isFinite(minY)) {
      shiftX = -minX;
      shiftY = -minY;
    }
  }
  const shift = (p: KPoint): KPoint => ({ x: p.x + shiftX, y: p.y + shiftY });
  const toUnits = (p: KPoint): [number, number] => [
    Math.round(p.x * scale),
    Math.round(p.y * scale),
  ];

  const out: string[] = ['IN;', 'PA;'];
  let currentTool: number | null = null;
  let currentVs: number | null = null;
  let currentPos: [number, number] | null = null;
  let penDown = false;
  let polylineCount = 0;

  const posEquals = (a: [number, number] | null, b: [number, number]): boolean =>
    a != null && a[0] === b[0] && a[1] === b[1];

  const emitVsIfChanged = (target: number): void => {
    if (currentVs == null || Math.abs(target - currentVs) > EPS) {
      out.push(`VS${formatHpglFloat(target)};`);
      currentVs = target;
    }
  };

  const appendPdBatch = (points: Array<[number, number]>): void => {
    if (points.length === 0) return;
    out.push(`PD${points.map(([x, y]) => `${x},${y}`).join(',')};`);
  };

  for (const op of withStrokes) {
    const toolNumber = Math.max(1, Math.floor(op.toolNumber));
    if (currentTool !== toolNumber) {
      if (penDown) {
        out.push('PU;');
        penDown = false;
      }
      out.push(`SP${toolNumber};`);
      currentTool = toolNumber;
    }

    const speedMmMin = opts.speedsMmMin?.[op.id];
    const roundedMmMin = opts.roundedSpeedsMmMin?.[op.id];
    let baseVs: number | null = null;
    let roundVs: number | null = null;
    if (speedMmMin != null && speedMmMin > 0) {
      baseVs = mmMinToCmS(speedMmMin);
      emitVsIfChanged(baseVs);
    }
    if (roundedMmMin != null && roundedMmMin > 0) {
      roundVs = mmMinToCmS(roundedMmMin);
      if (baseVs != null && roundVs <= baseVs) roundVs = null;
    }

    const strokes = stitchStrokes(op.strokes, opts.stitchToleranceMm);

    for (const stroke of strokes) {
      if (stroke.type === 'polyline') {
        const points = stroke.points.map(shift);
        if (points.length < 2) continue;
        polylineCount++;
        const startI = toUnits(points[0]);
        if (penDown || !posEquals(currentPos, startI)) {
          out.push(`PU${startI[0]},${startI[1]};`);
          penDown = false;
        }
        if (!penDown) {
          out.push('PD;');
          penDown = true;
        }
        const curvedFlags = polylineCurvedSegmentFlags(points);
        let pdBatch: Array<[number, number]> = [];
        let pdBatchVs: number | null = null;
        for (let segIdx = 0; segIdx < points.length - 1; segIdx++) {
          const target = points[segIdx + 1];
          const isCurved = curvedFlags[segIdx] === true;
          const targetVs = isCurved && roundVs != null ? roundVs : baseVs;
          const speedChanged =
            (targetVs == null) !== (pdBatchVs == null) ||
            (targetVs != null && pdBatchVs != null && Math.abs(targetVs - pdBatchVs) > EPS);
          if (pdBatch.length > 0 && speedChanged) {
            appendPdBatch(pdBatch);
            pdBatch = [];
            pdBatchVs = null;
          }
          if (targetVs != null) emitVsIfChanged(targetVs);
          if (pdBatch.length === 0) pdBatchVs = targetVs;
          const unit = toUnits(target);
          pdBatch.push(unit);
          if (pdBatch.length >= batchPairs) {
            appendPdBatch(pdBatch);
            pdBatch = [];
            pdBatchVs = null;
          }
          currentPos = unit;
        }
        appendPdBatch(pdBatch);
        continue;
      }

      if (stroke.type === 'line') {
        const start = shift(stroke.start);
        const end = shift(stroke.end);
        polylineCount++;
        const startI = toUnits(start);
        if (penDown || !posEquals(currentPos, startI)) {
          out.push(`PU${startI[0]},${startI[1]};`);
          penDown = false;
        }
        if (!penDown) {
          out.push('PD;');
          penDown = true;
        }
        if (baseVs != null) emitVsIfChanged(baseVs);
        const endI = toUnits(end);
        appendPdBatch([endI]);
        currentPos = endI;
        continue;
      }

      // Arc: absolute arc command AAcx,cy,sweepDeg
      const start = shift(stroke.start);
      const end = shift(stroke.end);
      const center = shift(stroke.center);
      const sweepDeg = arcSweepDegFrom(start, end, center, stroke.ccw);
      polylineCount++;
      const startI = toUnits(start);
      if (penDown || !posEquals(currentPos, startI)) {
        out.push(`PU${startI[0]},${startI[1]};`);
        penDown = false;
      }
      if (!penDown) {
        out.push('PD;');
        penDown = true;
      }
      const targetVs = roundVs ?? baseVs;
      if (targetVs != null) emitVsIfChanged(targetVs);
      const [cxI, cyI] = toUnits(center);
      out.push(`AA${cxI},${cyI},${formatHpglFloat(sweepDeg)};`);
      currentPos = toUnits(end);
    }
  }

  if (penDown) out.push('PU;');
  out.push('PU0,0;SP0;');

  return {
    text: out.join('\n') + '\n',
    polylineCount,
    commandCount: out.length,
    offsetXMm: shiftX,
    offsetYMm: shiftY,
  };
}

/**
 * Merge consecutive line/polyline strokes whose endpoints touch within the
 * tolerance (including reversed continuation); arcs pass through unmerged.
 * Port of Python `_layer_strokes` stitching behavior.
 */
export function stitchStrokes(strokes: Stroke[], tol: number): Stroke[] {
  const out: Stroke[] = [];
  let current: KPoint[] = [];

  const flush = (): void => {
    if (current.length >= 2) out.push({ type: 'polyline', points: current });
    current = [];
  };

  for (const stroke of strokes) {
    if (stroke.type === 'arc') {
      flush();
      out.push(stroke);
      continue;
    }
    const pts = stroke.type === 'line' ? [stroke.start, stroke.end] : stroke.points;
    if (pts.length < 2) continue;

    if (current.length === 0) {
      current = [...pts];
      continue;
    }
    if (pointsClose(current[current.length - 1], pts[0], tol)) {
      current.push(...pts.slice(1));
      continue;
    }
    if (pointsClose(current[current.length - 1], pts[pts.length - 1], tol)) {
      current.push(...[...pts].reverse().slice(1));
      continue;
    }
    flush();
    current = [...pts];
  }
  flush();
  return out;
}

/** Signed sweep in degrees for an AA command. */
export function arcSweepDegFrom(start: KPoint, end: KPoint, center: KPoint, ccw: boolean): number {
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  const twoPi = 2 * Math.PI;
  const ccwSweep = ((a1 - a0) % twoPi + twoPi) % twoPi;
  const cwSweep = ccwSweep - twoPi;
  let sweep: number;
  if (Math.abs(start.x - end.x) <= EPS && Math.abs(start.y - end.y) <= EPS) {
    sweep = ccw ? twoPi : -twoPi;
  } else {
    sweep = ccw ? ccwSweep : cwSweep;
  }
  return (sweep * 180) / Math.PI;
}

export function formatHpglFloat(value: number): string {
  let text = value.toFixed(6);
  text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text.length > 0 && text !== '-' ? text : '0';
}

function mmMinToCmS(mmMin: number): number {
  // CopperCAM reference: VS uses cm/s, from mm/min via /60 then /10.
  return mmMin / 600;
}

/**
 * Per-segment flags marking arc-like runs (gentle continuous turns), used to
 * switch to the rounded speed. Port of `_polyline_curved_segment_flags`.
 */
export function polylineCurvedSegmentFlags(points: KPoint[]): boolean[] {
  const segCount = Math.max(0, points.length - 1);
  if (segCount <= 1) return new Array(segCount).fill(false);

  const flags: boolean[] = new Array(segCount).fill(false);
  const minTurnDeg = 0.25;
  const maxTurnDeg = 35;

  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 <= 1e-12 || l2 <= 1e-12) continue;
    const crossV = v1x * v2y - v1y * v2x;
    const dotV = v1x * v2x + v1y * v2y;
    const turn = Math.abs((Math.atan2(Math.abs(crossV), dotV) * 180) / Math.PI);
    if (turn >= minTurnDeg && turn <= maxTurnDeg) flags[i] = true;
  }

  // Keep only runs of >= 2 consecutive flagged segments.
  let start = 0;
  while (start < segCount) {
    if (!flags[start]) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < segCount && flags[end]) end++;
    if (end - start < 2) {
      for (let j = start; j < end; j++) flags[j] = false;
    }
    start = end;
  }
  return flags;
}
