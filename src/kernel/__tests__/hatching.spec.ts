/**
 * buildHatching: copper-clearing acceptance tests, ported from
 * reference/PathKernel/tests/test_hatching_toolpath.py.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initClipper, intersectPolygons, polygonSetArea, sweptOpenPaths } from '../clip';
import { extractCutoutLoops, loopsToDomain } from '../cutout';
import { buildHatching } from '../hatching';
import type { HatchingParams, KPoint, KPrimitive, Stroke } from '../types';

beforeAll(async () => {
  await initClipper();
});

const DEFAULT_PARAMS: HatchingParams = {
  toolDiameterMm: 0.5,
  toolProfile: 'cylindrical',
  tipDiameterMm: 0,
  toolAngleDeg: 0,
  cuttingDepthMm: 0,
  overlap: 0.5,
  hatchingMarginMm: 0.5,
  hatchAngleDeg: 0,
  copperKeepoutMarginMm: 0,
  boundaryMarginMm: 3,
  joinStyle: 'round',
};

function circlePad(cx: number, cy: number, r: number, segments = 48): KPoint[] {
  const pts: KPoint[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function traceRect(x0: number, y0: number, x1: number, y1: number): KPoint[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

function rectPrimitive(x0: number, y0: number, x1: number, y1: number): KPrimitive {
  return { type: 'polygon', points: traceRect(x0, y0, x1, y1), polarity: 'dark', flashed: false };
}

function stroketoSegment(s: Stroke): [KPoint, KPoint] {
  if (s.type === 'line') return [s.start, s.end];
  if (s.type === 'polyline') return [s.points[0], s.points[s.points.length - 1]];
  return [s.start, s.end];
}

describe('buildHatching', () => {
  it('generates a copper-clearing toolpath around a round pad', () => {
    const copper: KPoint[][] = [circlePad(5, 5, 1)];
    const op = buildHatching({
      id: 'hatch-1',
      layerId: 'top',
      label: 'Hatching',
      toolNumber: 2,
      copper,
      params: DEFAULT_PARAMS,
    });

    expect(op.kind).toBe('hatching');
    expect(op.strokes.length).toBeGreaterThan(0);
    expect(op.meta.hatching_step_mm).toBe('0.500000');
  });

  it('swept hatch toolpath never overlaps the copper it clears around', () => {
    // A trace across the middle of a 10x10 clearing area.
    const copper: KPoint[][] = [traceRect(2, 4.75, 8, 5.25)];
    const op = buildHatching({
      id: 'hatch-2',
      layerId: 'top',
      label: 'Hatching',
      toolNumber: 2,
      copper,
      params: { ...DEFAULT_PARAMS, hatchingMarginMm: 0.4, boundaryMarginMm: 2 },
    });

    const toolRadius = op.effectiveToolDiameterMm / 2;
    const swept = sweptOpenPaths(op.previewPolylines, toolRadius);
    const overlapArea = Math.abs(polygonSetArea(intersectPolygons(swept, copper)));
    expect(overlapArea).toBeLessThanOrEqual(1e-6);
  });

  it('respects a complex (rounded) pad shape — hatch never enters the pad boundary', () => {
    const copper: KPoint[][] = [circlePad(5, 5, 1.5, 64)];
    const op = buildHatching({
      id: 'hatch-3',
      layerId: 'top',
      label: 'Hatching',
      toolNumber: 2,
      copper,
      params: { ...DEFAULT_PARAMS, hatchingMarginMm: 0.3, boundaryMarginMm: 3 },
    });

    const toolRadius = op.effectiveToolDiameterMm / 2;
    const swept = sweptOpenPaths(op.previewPolylines, toolRadius);
    const overlapArea = Math.abs(polygonSetArea(intersectPolygons(swept, copper)));
    expect(overlapArea).toBeLessThanOrEqual(1e-6);
  });

  it('board-domain-constrained clearing ignores an unselected second board', () => {
    // Two 10x10 boards side by side (0..10 and 20..30); only the left one's
    // cutout loop is passed as the board domain — hatching for the left
    // board's trace must not spill past x=10 into the right board's space.
    const selectedBoardLoop = extractCutoutLoops([rectPrimitive(0, 0, 10, 10)]);
    const domain = loopsToDomain(selectedBoardLoop);
    const boardDomainRings = domain.flatMap((p) => [p.outer, ...p.holes]);

    const copper: KPoint[][] = [traceRect(2, 4.75, 8, 5.25)];
    const op = buildHatching({
      id: 'hatch-4',
      layerId: 'top',
      label: 'Hatching',
      toolNumber: 2,
      copper,
      boardDomainRings,
      params: { ...DEFAULT_PARAMS, copperKeepoutMarginMm: 0 },
    });

    for (const s of op.strokes) {
      const [a, b] = stroketoSegment(s);
      expect(a.x).toBeLessThanOrEqual(10 + 1e-6);
      expect(b.x).toBeLessThanOrEqual(10 + 1e-6);
    }
  });

  it('subtracts an existing (isolation) toolpath keepout on the same layer', () => {
    const copper: KPoint[][] = [circlePad(5, 5, 1)];
    const isolationRing = circlePad(5, 5, 1.35, 64); // isolation channel just outside the pad
    const withoutKeepout = buildHatching({
      id: 'hatch-5a',
      layerId: 'top',
      label: 'Hatching',
      toolNumber: 2,
      copper,
      params: DEFAULT_PARAMS,
    });
    const withKeepout = buildHatching({
      id: 'hatch-5b',
      layerId: 'top',
      label: 'Hatching',
      toolNumber: 2,
      copper,
      existingToolpathPreview: [isolationRing],
      params: DEFAULT_PARAMS,
    });

    // Keeping off the isolation channel too can only remove hatch length,
    // never add any (same clear domain, strictly more keepout).
    expect(withKeepout.stats.pathLengthMm).toBeLessThanOrEqual(withoutKeepout.stats.pathLengthMm + 1e-6);
  });

  it('falls back to a bbox+boundaryMargin domain when no board outline is given', () => {
    const copper: KPoint[][] = [circlePad(5, 5, 1)];
    const op = buildHatching({
      id: 'hatch-6',
      layerId: 'top',
      label: 'Hatching',
      toolNumber: 2,
      copper,
      params: { ...DEFAULT_PARAMS, boundaryMarginMm: 1 },
    });
    for (const s of op.strokes) {
      const [a, b] = stroketoSegment(s);
      // Copper bbox is [4,6]x[4,6] (r=1 circle at (5,5)); +1mm boundary margin.
      expect(a.x).toBeGreaterThanOrEqual(4 - 1 - 1e-3);
      expect(a.x).toBeLessThanOrEqual(6 + 1 + 1e-3);
      expect(b.y).toBeGreaterThanOrEqual(4 - 1 - 1e-3);
      expect(b.y).toBeLessThanOrEqual(6 + 1 + 1e-3);
    }
  });

  it('throws when there is no copper to clear around', () => {
    expect(() =>
      buildHatching({
        id: 'hatch-7',
        layerId: 'top',
        label: 'Hatching',
        toolNumber: 2,
        copper: [],
        params: DEFAULT_PARAMS,
      }),
    ).toThrow();
  });
});
