/**
 * Circular-arc re-fitting for Clipper-tessellated boundaries (arcFit.ts).
 * Pure geometry — no Clipper needed, except for the end-to-end wiring check.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ARC_FIT_OPTIONS, fitArcsToClosedRing, fitArcsToOpenPath } from '../arcFit';
import { initClipper } from '../clip';
import { buildCopperGeometry } from '../copper';
import { circlePoints, distance, flattenArc, roundedRectPoints } from '../geom2d';
import { buildIsolation } from '../isolation';
import type { IsolationParams, KPoint, KPrimitive } from '../types';

const TOL = DEFAULT_ARC_FIT_OPTIONS.toleranceMm;

describe('fitArcsToClosedRing', () => {
  it('reduces a plain circle ring to one full-circle arc piece', () => {
    const cx = 12.345;
    const cy = -7.89;
    const r = 1.234;
    const ring = circlePoints(cx, cy, r);

    const pieces = fitArcsToClosedRing(ring);
    expect(pieces).toHaveLength(1);
    const piece = pieces[0];
    if (piece.kind !== 'arc') throw new Error('expected an arc piece');

    expect(distance(piece.start, piece.end)).toBeLessThan(1e-9); // start === end (full circle)
    expect(distance(piece.center, { x: cx, y: cy })).toBeLessThan(TOL);
    expect(Math.abs(piece.radius - r)).toBeLessThan(TOL);
    expect(piece.ccw).toBe(true); // circlePoints sweeps increasing angle (CCW)

    // Round-trip fidelity: every original ring vertex sits within tolerance
    // of the fitted circle (re-derives the fit's own residual guarantee).
    for (const p of ring) {
      expect(Math.abs(distance(p, piece.center) - piece.radius)).toBeLessThanOrEqual(TOL);
    }
  });

  it('splits a rounded-rectangle ring into alternating line/arc pieces', () => {
    const cx = 0;
    const cy = 0;
    const w = 10;
    const h = 6;
    const r = 1.5;
    const ring = roundedRectPoints(cx, cy, w, h, r);

    const pieces = fitArcsToClosedRing(ring);
    expect(pieces).toHaveLength(8);

    const expectedCenters: KPoint[] = [
      { x: cx + w / 2 - r, y: cy - h / 2 + r },
      { x: cx + w / 2 - r, y: cy + h / 2 - r },
      { x: cx - w / 2 + r, y: cy + h / 2 - r },
      { x: cx - w / 2 + r, y: cy - h / 2 + r },
    ];
    const matchedCenters = new Set<number>();

    let arcCount = 0;
    let lineCount = 0;
    let reconstructedLength = 0;
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      // Pieces must alternate kind and each connect to the next.
      if (i > 0) {
        const prevEnd =
          pieces[i - 1].kind === 'arc'
            ? (pieces[i - 1] as { end: KPoint }).end
            : (pieces[i - 1] as { points: KPoint[] }).points.slice(-1)[0];
        const start = piece.kind === 'arc' ? piece.start : piece.points[0];
        expect(distance(prevEnd, start)).toBeLessThan(1e-6);
      }
      if (piece.kind === 'arc') {
        arcCount++;
        expect(Math.abs(piece.radius - r)).toBeLessThan(TOL);
        expect(piece.ccw).toBe(true);
        const matchIdx = expectedCenters.findIndex(
          (c, idx) => !matchedCenters.has(idx) && distance(c, piece.center) < TOL,
        );
        expect(matchIdx).toBeGreaterThanOrEqual(0);
        matchedCenters.add(matchIdx);
        reconstructedLength += flattenArc(piece.start, piece.end, piece.center, piece.ccw).reduce(
          (sum, p, idx, arr) => (idx === 0 ? 0 : sum + distance(arr[idx - 1], p)),
          0,
        );
      } else {
        lineCount++;
        expect(piece.points).toHaveLength(2);
        reconstructedLength += distance(piece.points[0], piece.points[1]);
      }
    }
    expect(arcCount).toBe(4);
    expect(lineCount).toBe(4);
    expect(matchedCenters.size).toBe(4);

    const expectedPerimeter = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;
    expect(Math.abs(reconstructedLength - expectedPerimeter) / expectedPerimeter).toBeLessThan(0.01);
  });

  it('leaves a sharp-cornered rectangle entirely as straight pieces (no false-positive circle)', () => {
    // A plain rectangle's 4 corners are always concyclic (they sit on one
    // circle, radius = half the diagonal) — this guards against that being
    // mistaken for a genuine round contour.
    const ring: KPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 0, y: 4 },
    ];
    const pieces = fitArcsToClosedRing(ring);
    for (const piece of pieces) {
      expect(piece.kind).toBe('line');
    }
  });
});

describe('fitArcsToOpenPath', () => {
  it('detects a CCW quarter-circle arc', () => {
    const center: KPoint = { x: 0, y: 0 };
    const start: KPoint = { x: 5, y: 0 };
    const end: KPoint = { x: 0, y: 5 };
    const path = flattenArc(start, end, center, true);

    const pieces = fitArcsToOpenPath(path);
    expect(pieces).toHaveLength(1);
    const piece = pieces[0];
    if (piece.kind !== 'arc') throw new Error('expected an arc piece');
    expect(piece.ccw).toBe(true);
    expect(distance(piece.center, center)).toBeLessThan(TOL);
    expect(Math.abs(piece.radius - 5)).toBeLessThan(TOL);
  });

  it('detects a CW quarter-circle arc', () => {
    const center: KPoint = { x: 0, y: 0 };
    const start: KPoint = { x: 0, y: 5 };
    const end: KPoint = { x: 5, y: 0 };
    const path = flattenArc(start, end, center, false);

    const pieces = fitArcsToOpenPath(path);
    expect(pieces).toHaveLength(1);
    const piece = pieces[0];
    if (piece.kind !== 'arc') throw new Error('expected an arc piece');
    expect(piece.ccw).toBe(false);
    expect(distance(piece.center, center)).toBeLessThan(TOL);
  });

  it('rejects a run perturbed beyond tolerance, falling back to line pieces', () => {
    // Exactly 5 points spanning a small arc, with the middle one perturbed
    // well beyond tolerance. minRunPoints=4 means any valid arc needs 4
    // consecutive good points — removing the bad one leaves at most 2 on
    // either side, so (unlike a long mostly-clean arc, where a robust fit
    // can legitimately route around one outlier) no valid run can exist
    // here without including the bad point.
    const r = 5;
    const angles = [0, 22.5, 45, 67.5, 90].map((d) => (d * Math.PI) / 180);
    const path: KPoint[] = angles.map((a) => ({ x: r * Math.cos(a), y: r * Math.sin(a) }));
    path[2] = { x: path[2].x + 0.5, y: path[2].y + 0.5 };

    const pieces = fitArcsToOpenPath(path);
    expect(pieces.some((p) => p.kind === 'arc')).toBe(false);
  });

  it('stitches a straight → arc → straight sequence in order', () => {
    const center: KPoint = { x: 10, y: 0 };
    const arcStart: KPoint = { x: 5, y: 0 };
    const arcEnd: KPoint = { x: 10, y: 5 };
    const lead: KPoint = { x: -5, y: 0 };
    const trail: KPoint = { x: 10, y: 15 };

    const path: KPoint[] = [
      lead,
      ...flattenArc(arcStart, arcEnd, center, true),
      trail,
    ];

    const pieces = fitArcsToOpenPath(path);
    expect(pieces.map((p) => p.kind)).toEqual(['line', 'arc', 'line']);
    const [first, arcPiece, last] = pieces;
    if (first.kind !== 'line' || arcPiece.kind !== 'arc' || last.kind !== 'line') {
      throw new Error('unexpected piece kinds');
    }
    expect(distance(first.points[0], lead)).toBeLessThan(1e-9);
    expect(distance(first.points[first.points.length - 1], arcStart)).toBeLessThan(1e-6);
    expect(distance(arcPiece.start, arcStart)).toBeLessThan(1e-6);
    expect(distance(arcPiece.end, arcEnd)).toBeLessThan(1e-6);
    expect(distance(last.points[0], arcEnd)).toBeLessThan(1e-6);
    expect(distance(last.points[last.points.length - 1], trail)).toBeLessThan(1e-9);
  });
});

describe('isolation integration', () => {
  beforeAll(async () => {
    await initClipper();
  });

  it('buildIsolation emits native arc strokes around an isolated round pad', () => {
    const primitive: KPrimitive = { type: 'circle', cx: 0, cy: 0, r: 1, polarity: 'dark', flashed: true };
    const copper = buildCopperGeometry([primitive]);
    const params: IsolationParams = {
      toolDiameterMm: 0.2,
      passes: 1,
      overlap: 0.5,
      isoType: 'exterior',
      toolProfile: 'cylindrical',
      tipDiameterMm: 0.1,
      toolAngleDeg: 30,
      cuttingDepthMm: 0.1,
      traceMarginMm: 0,
      hatchingMarginMm: 0,
      joinStyle: 'round',
      skipTightClearancePaths: false,
      extraPadContours: 0,
    };

    const result = buildIsolation({
      id: 'iso-round-pad',
      layerId: 'test',
      label: 'test',
      toolNumber: 1,
      copper,
      primitives: [primitive],
      params,
    });

    expect(result.strokes.some((s) => s.type === 'arc')).toBe(true);
    // The polygonal PD fallback shouldn't be needed at all for a single
    // isolated round pad — the whole ring should collapse to one arc.
    expect(result.strokes.filter((s) => s.type === 'arc')).toHaveLength(1);
  });
});
