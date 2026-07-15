/**
 * Acceptance tests for the clip.ts wrapper over js-angusj-clipper.
 * These encode the geometric behaviors the kernel relies on; a future engine
 * swap must keep them green.
 *
 * History: clipper2-js@1.2.4 was tried first and produced corrupt offset
 * geometry (mitered square offset returned points inside the source polygon),
 * so the engine was swapped per the plan's risk mitigation.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  cleanPolygons,
  differencePolygons,
  initClipper,
  intersectPolygons,
  offsetPolygons,
  polygonSetArea,
  polygonsIntersect,
  polysWithHoles,
  sweptOpenPaths,
  unionPolygons,
} from '../clip';
import { circlePoints } from '../geom2d';
import type { KPoint } from '../types';

function rect(x0: number, y0: number, x1: number, y1: number): KPoint[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

beforeAll(async () => {
  await initClipper();
});

describe('clip.ts wrapper acceptance', () => {
  it('unions two overlapping unit squares into one ring of area 1.5', () => {
    const out = unionPolygons([rect(0, 0, 1, 1), rect(0.5, 0, 1.5, 1)]);
    expect(out.length).toBe(1);
    expect(polygonSetArea(out)).toBeCloseTo(1.5, 6);
  });

  it('difference cuts a hole with correct net area', () => {
    const out = differencePolygons([rect(0, 0, 10, 10)], [rect(4, 4, 6, 6)]);
    expect(out.length).toBe(2);
    expect(polygonSetArea(out)).toBeCloseTo(96, 6);
  });

  it('offsets a circle outward with round join to the expected area', () => {
    const out = offsetPolygons([circlePoints(0, 0, 2)], 1, 'round');
    const expected = Math.PI * 9;
    expect(Math.abs(polygonSetArea(out) - expected) / expected).toBeLessThan(0.005);
  });

  it('offsets a square with miter join to exact sharp corners', () => {
    const out = offsetPolygons([rect(0, 0, 2, 2)], 0.5, 'miter');
    expect(out.length).toBe(1);
    expect(polygonSetArea(out)).toBeCloseTo(9, 4); // 3x3
  });

  it('negative offset shrinks and can annihilate a polygon', () => {
    const shrunk = offsetPolygons([rect(0, 0, 2, 2)], -0.5, 'round');
    expect(polygonSetArea(shrunk)).toBeCloseTo(1, 4);
    const gone = offsetPolygons([rect(0, 0, 2, 2)], -1.5, 'round');
    expect(gone.length).toBe(0);
  });

  it('sweeps an open path by a tool radius (LineString.buffer analog)', () => {
    const out = sweptOpenPaths([[{ x: 0, y: 0 }, { x: 10, y: 0 }]], 0.5);
    const expected = 10 * 1 + Math.PI * 0.25;
    expect(Math.abs(polygonSetArea(out) - expected) / expected).toBeLessThan(0.01);
  });

  it('assigns holes to outers via polysWithHoles', () => {
    const rings = differencePolygons([rect(0, 0, 10, 10)], [rect(4, 4, 6, 6)]);
    const polys = polysWithHoles(rings);
    expect(polys.length).toBe(1);
    expect(polys[0].holes.length).toBe(1);
  });

  it('detects polygon intersection', () => {
    expect(polygonsIntersect([rect(0, 0, 2, 2)], [rect(1, 1, 3, 3)])).toBe(true);
    expect(polygonsIntersect([rect(0, 0, 2, 2)], [rect(5, 5, 6, 6)])).toBe(false);
  });

  it('cleanPolygons reduces vertex count with bounded (display-grade) area drift', () => {
    const noisy = circlePoints(0, 0, 5, 0.001); // very dense ring
    const cleaned = cleanPolygons([noisy], 0.005);
    expect(cleaned[0].length).toBeLessThan(noisy.length);
    const expected = Math.PI * 25;
    // CleanPolygons is coarser than its distance parameter; display-only use.
    expect(Math.abs(polygonSetArea(cleaned) - expected) / expected).toBeLessThan(0.02);
  });

  it('intersection returns overlap region', () => {
    const out = intersectPolygons([rect(0, 0, 2, 2)], [rect(1, 1, 3, 3)]);
    expect(polygonSetArea(out)).toBeCloseTo(1, 6);
  });
});
