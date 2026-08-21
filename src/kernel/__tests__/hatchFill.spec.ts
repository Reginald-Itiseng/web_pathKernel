/**
 * Scanline polygon fill (hatchFill.ts): row generation, hole handling,
 * serpentine ordering, and rotation. Pure geometry — no Clipper needed.
 * Test dimensions are deliberately non-aligned to the step spacing (see
 * hatchFill.ts's documented half-open boundary-crossing behavior).
 */
import { describe, expect, it } from 'vitest';
import { hatchFillLines } from '../hatchFill';
import { distance } from '../geom2d';
import type { KPoint, PolyWithHoles } from '../types';

function rect(x0: number, y0: number, x1: number, y1: number): KPoint[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

describe('hatchFillLines', () => {
  it('fills a plain rectangle with one full-width segment per row', () => {
    const polys: PolyWithHoles[] = [{ outer: rect(0, 0, 10, 5.3), holes: [] }];
    const lines = hatchFillLines(polys, 1, 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const [a, b] of lines) {
      expect(Math.abs(a.y - b.y)).toBeLessThan(1e-9); // horizontal row
      expect(distance(a, b)).toBeGreaterThan(9); // spans ~the full 10mm width
      expect(a.x).toBeGreaterThanOrEqual(-1e-6);
      expect(b.x).toBeLessThanOrEqual(10 + 1e-6);
    }
    // 5.3mm tall at 1mm step → rows at y=0,1,2,3,4,5 = 6 rows.
    expect(lines.length).toBe(6);
  });

  it('splits a row into two segments around a hole', () => {
    // Hole properly nested within the outer's extent (the only geometrically
    // valid case — Clipper never produces a hole poking outside its outer),
    // with non-integer boundaries so no row lands exactly on a hole edge
    // (see hatchFill.ts's documented half-open boundary behavior — this is
    // the realistic case: real Clipper output essentially never aligns
    // exactly with an arbitrary row spacing).
    const polys: PolyWithHoles[] = [
      { outer: rect(0, 0, 10, 5.3), holes: [rect(4.1, 1.2, 6.2, 3.9)] },
    ];
    const lines = hatchFillLines(polys, 1, 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const [a, b] of lines) {
      // Only rows whose y actually falls inside the hole's vertical span
      // [1.2, 3.9] can be affected by it — rows below/above (e.g. y=0, y=1,
      // y=4, y=5) legitimately span the full width. Direction may be
      // reversed by serpentine ordering, so compare min/max, not a/b.
      if (a.y <= 1.2 || a.y >= 3.9) continue;
      const crossesHole = Math.min(a.x, b.x) < 4.1 && Math.max(a.x, b.x) > 6.2;
      expect(crossesHole).toBe(false);
    }
    // Row y=2 is safely inside the hole's y-range [1.2,3.9) — must be split
    // into exactly two segments (left of the hole, right of it).
    const rowAt2 = lines.filter(([a]) => Math.abs(a.y - 2) < 1e-9);
    expect(rowAt2).toHaveLength(2);
  });

  it('alternates row direction (serpentine)', () => {
    const polys: PolyWithHoles[] = [{ outer: rect(0, 0, 10, 3.3), holes: [] }];
    const lines = hatchFillLines(polys, 1, 0);
    // Row 0 (y=0): low→high x. Row 1 (y=1): high→low x (reversed direction).
    expect(lines[0][0].x).toBeLessThan(lines[0][1].x);
    expect(lines[1][0].x).toBeGreaterThan(lines[1][1].x);
    expect(lines[2][0].x).toBeLessThan(lines[2][1].x);
  });

  it('fills an L-shape correctly (non-convex region)', () => {
    // L-shape: big square with the top-right quadrant notched out.
    const lShape: KPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 10 },
      { x: 0, y: 10 },
    ];
    const polys: PolyWithHoles[] = [{ outer: lShape, holes: [] }];
    const lines = hatchFillLines(polys, 1, 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const [a, b] of lines) {
      // Rows above y=5 must stay within x in [0,5] (the notch removed the
      // right half up there); rows at/below y=5 span the full width.
      if (a.y > 5 + 1e-6) {
        expect(Math.max(a.x, b.x)).toBeLessThanOrEqual(5 + 1e-6);
      }
    }
  });

  it('rotates the hatch pattern by the given angle', () => {
    const polys: PolyWithHoles[] = [{ outer: rect(0, 0, 10, 10), holes: [] }];
    const horizontal = hatchFillLines(polys, 2, 0);
    const rotated = hatchFillLines(polys, 2, 90);
    expect(horizontal.length).toBeGreaterThan(0);
    expect(rotated.length).toBeGreaterThan(0);
    // At 90°, rows (which were horizontal at 0°) become vertical segments.
    for (const [a, b] of rotated) {
      expect(Math.abs(a.x - b.x)).toBeLessThan(1e-6);
    }
  });

  it('returns nothing for an empty or degenerate input', () => {
    expect(hatchFillLines([], 1, 0)).toEqual([]);
    expect(hatchFillLines([{ outer: [], holes: [] }], 1, 0)).toEqual([]);
    expect(hatchFillLines([{ outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }], holes: [] }], 1, 0)).toEqual([]);
  });
});
