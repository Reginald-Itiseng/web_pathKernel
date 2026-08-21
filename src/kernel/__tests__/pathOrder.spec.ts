/**
 * Travel-time ordering (pathOrder.ts): greedy nearest-neighbor sequencing,
 * entry-point rotation for closed loops, direction reversal for open paths,
 * and the "never reverse" guarantee for physically-ordered sequences.
 */
import { describe, expect, it } from 'vitest';
import {
  centroidOfRing,
  chainInFixedOrder,
  fixedEntryUnit,
  nearestCentroidIndex,
  reorderForTravel,
  strokeEnd,
  strokeStart,
  unitFromStrokes,
} from '../pathOrder';
import type { KPoint, Stroke } from '../types';

function line(a: KPoint, b: KPoint): Stroke {
  return { type: 'line', start: a, end: b };
}

function square(cx: number, cy: number, half: number): Stroke[] {
  const a = { x: cx - half, y: cy - half };
  const b = { x: cx + half, y: cy - half };
  const c = { x: cx + half, y: cy + half };
  const d = { x: cx - half, y: cy + half };
  return [line(a, b), line(b, c), line(c, d), line(d, a)];
}

describe('unitFromStrokes', () => {
  it('detects a closed loop (last stroke end == first stroke start)', () => {
    const unit = unitFromStrokes(square(0, 0, 1));
    expect(unit.entry).toBe('closed');
  });

  it('detects an open path (endpoints do not coincide)', () => {
    const strokes = [line({ x: 0, y: 0 }, { x: 1, y: 0 }), line({ x: 1, y: 0 }, { x: 1, y: 1 })];
    const unit = unitFromStrokes(strokes);
    expect(unit.entry).toBe('open');
  });

  it('empty stroke list is a harmless open unit', () => {
    expect(unitFromStrokes([]).entry).toBe('open');
  });
});

describe('reorderForTravel', () => {
  it('visits units nearest-neighbor from the start position', () => {
    // Three single-point-like (fixed-entry) units — no entry-side ambiguity,
    // so this isolates pure unit-to-unit sequencing. Asymmetric spacing
    // avoids any near-tie in the greedy distance comparison.
    const atMinus5 = fixedEntryUnit([line({ x: -5, y: 0 }, { x: -5, y: 0.001 })]);
    const at10 = fixedEntryUnit([line({ x: 10, y: 0 }, { x: 10, y: 0.001 })]);
    const at20 = fixedEntryUnit([line({ x: 20, y: 0 }, { x: 20, y: 0.001 })]);
    // From x=12: nearest is 10, then from 10 nearest remaining is 20
    // (dist ~10) over -5 (dist ~15), then -5 last.
    const ordered = reorderForTravel([at20, atMinus5, at10], { x: 12, y: 0 });
    const xs = ordered.map((s) => strokeStart(s).x);
    expect(xs).toEqual([10, 20, -5]);
  });

  it('rotates a closed loop to enter at whichever piece boundary is nearest', () => {
    // Square centered at (10,10), half=1. Approaching from far in +x should
    // enter at the right-side vertex closest to the approach direction.
    const unit = unitFromStrokes(square(10, 10, 1));
    const ordered = reorderForTravel([unit], { x: 100, y: 10 });
    // The nearest vertex to (100,10) among the square's corners
    // (9,9)(11,9)(11,11)(9,11) is (11,9) or (11,11) — either is valid, but
    // it must NOT be the far corner (9,9) or (9,11).
    const entry = strokeStart(ordered[0]);
    expect(entry.x).toBe(11);
    // The stroke sequence must still be the same 4 edges, just rotated —
    // verify it's still a closed loop end-to-end.
    expect(strokeEnd(ordered[ordered.length - 1])).toEqual(strokeStart(ordered[0]));
    expect(ordered).toHaveLength(4);
  });

  it('reverses an open unit when the far end is closer to the current position', () => {
    const strokes = [line({ x: 0, y: 0 }, { x: 0, y: 5 }), line({ x: 0, y: 5 }, { x: 0, y: 10 })];
    const unit = unitFromStrokes(strokes);
    // Approaching from near y=10 — the far end (0,10) is much closer than
    // the natural start (0,0), so entry should reverse.
    const ordered = reorderForTravel([unit], { x: 0, y: 11 });
    expect(strokeStart(ordered[0])).toEqual({ x: 0, y: 10 });
    expect(strokeEnd(ordered[ordered.length - 1])).toEqual({ x: 0, y: 0 });
    // Reversing an arc-free line sequence: internal order must also flip.
    expect(ordered[0]).toEqual(line({ x: 0, y: 10 }, { x: 0, y: 5 }));
  });

  it('reverses an arc stroke correctly (swaps start/end, flips ccw)', () => {
    const arc: Stroke = {
      type: 'arc',
      start: { x: 5, y: 0 },
      end: { x: 0, y: 5 },
      center: { x: 0, y: 0 },
      ccw: true,
    };
    const trailing = line({ x: 0, y: 5 }, { x: 0, y: 10 });
    const unit = unitFromStrokes([arc, trailing]);
    const ordered = reorderForTravel([unit], { x: 0, y: 11 });
    // Entered from the far end → reversed: trailing line first (reversed),
    // then the arc (reversed: start/end swapped, ccw flipped).
    expect(ordered[0]).toEqual(line({ x: 0, y: 10 }, { x: 0, y: 5 }));
    expect(ordered[1]).toEqual({ type: 'arc', start: { x: 0, y: 5 }, end: { x: 5, y: 0 }, center: { x: 0, y: 0 }, ccw: false });
  });

  it('never reverses a fixedEntryUnit even when the far end is much closer', () => {
    // A "drill" style plunge (0,0)->(0,0.001) then a bore arc far from the
    // plunge point. Approaching from right next to the arc must still visit
    // the plunge line first (physical ordering constraint).
    const plunge = line({ x: 0, y: 0 }, { x: 0.001, y: 0 });
    const bore: Stroke = { type: 'arc', start: { x: 5, y: 0 }, end: { x: 5, y: 0 }, center: { x: 0, y: 0 }, ccw: true };
    const unit = fixedEntryUnit([plunge, bore]);
    const ordered = reorderForTravel([unit], { x: 5, y: 0.001 });
    expect(ordered[0]).toEqual(plunge);
    expect(ordered[1]).toEqual(bore);
  });

  it('skips units with no strokes without throwing', () => {
    const real = unitFromStrokes([line({ x: 0, y: 0 }, { x: 1, y: 0 })]);
    const empty = unitFromStrokes([]);
    const ordered = reorderForTravel([empty, real], { x: 0, y: 0 });
    expect(ordered).toHaveLength(1);
  });
});

describe('chainInFixedOrder', () => {
  it('preserves the given sub-unit order but optimizes each entry point', () => {
    // Two closed squares, given in a fixed order (outer, then inner). Even
    // though the inner square might be geometrically closer to the start
    // position, the sequence order must not change — only entry rotation.
    const outer = unitFromStrokes(square(0, 0, 5));
    const inner = unitFromStrokes(square(0, 0, 1));
    const chained = chainInFixedOrder([outer, inner], { x: 100, y: 0 });
    expect(chained.entry).toBe('fixed');
    // First 4 strokes = outer square (entered near x=5), next 4 = inner.
    expect(chained.strokes).toHaveLength(8);
    expect(strokeStart(chained.strokes[0]).x).toBe(5); // outer's near-side entry
    expect(strokeStart(chained.strokes[4]).x).toBeCloseTo(1, 5); // inner square, entered near where outer ended
  });

  it('the resulting fixed unit is never reversed by an outer reorder', () => {
    const a = unitFromStrokes(square(0, 0, 1));
    const b = unitFromStrokes(square(0, 0, 1));
    const chained = chainInFixedOrder([a, b], { x: 0, y: 0 });
    const startBefore = strokeStart(chained.strokes[0]);
    // Even approaching from a position where the chain's OWN far end is
    // closer, reorderForTravel must not reverse a 'fixed' unit.
    const ordered = reorderForTravel([chained], { x: -1000, y: 0 });
    expect(strokeStart(ordered[0])).toEqual(startBefore);
  });
});

describe('centroidOfRing / nearestCentroidIndex', () => {
  it('computes the simple point average', () => {
    const c = centroidOfRing([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
    expect(c).toEqual({ x: 5, y: 5 });
  });

  it('finds the nearest centroid by index', () => {
    const centroids = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 0 }];
    const idx = nearestCentroidIndex([{ x: 48, y: 1 }, { x: 52, y: -1 }], centroids);
    expect(idx).toBe(2);
  });
});
