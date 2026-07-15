import { describe, expect, it } from 'vitest';
import { buildCenteringHoles, centeringHoleCenters, centeringMirrorAxis } from '../centering';
import { mirrorPolyline, mirrorStroke } from '../mirror';
import type { CenteringParams } from '../types';

const BOUNDS: [number, number, number, number] = [10, 20, 110, 80]; // 100x60 board
const BASE: CenteringParams = {
  orientation: 'horizontal',
  holeCount: 2,
  outlineToHoleCenterMm: 12,
  holeSpacingMm: 10,
  holeDiameterMm: 3,
  toolDiameterMm: 1,
  lateralStepoverPct: 50,
};

describe('centering hole placement', () => {
  it('2 holes: left and right on the horizontal centerline', () => {
    const centers = centeringHoleCenters(BOUNDS, BASE);
    expect(centers).toEqual([
      { x: -2, y: 50 },
      { x: 122, y: 50 },
    ]);
  });

  it('3-4 holes go further out along the same axis', () => {
    const four = centeringHoleCenters(BOUNDS, { ...BASE, holeCount: 4 });
    expect(four).toHaveLength(4);
    // Every hole is exactly on the flip axis y = 50 and outside the board.
    for (const c of four) {
      expect(c.y).toBe(50);
      expect(c.x < 10 || c.x > 110).toBe(true);
    }
    expect(four[2]).toEqual({ x: 132, y: 50 });
    expect(four[3]).toEqual({ x: -12, y: 50 });
  });

  it('vertical orientation transposes placement and axis', () => {
    const centers = centeringHoleCenters(BOUNDS, { ...BASE, orientation: 'vertical' });
    expect(centers).toEqual([
      { x: 60, y: 8 },
      { x: 60, y: 92 },
    ]);
    expect(centeringMirrorAxis(BOUNDS, 'vertical')).toEqual({ axis: 'x', position: 60 });
    expect(centeringMirrorAxis(BOUNDS, 'horizontal')).toEqual({ axis: 'y', position: 50 });
  });

  it('builds strategy-A toolpaths: one plunge per hole plus bores', () => {
    const op = buildCenteringHoles({
      id: 'centering',
      layerId: 'anchor',
      label: 'Centering holes',
      toolNumber: 4,
      boardBounds: BOUNDS,
      params: { ...BASE, holeCount: 3 },
    });
    expect(op.stats.plungeCount).toBe(3);
    expect(op.stats.boreHoleCount).toBe(3); // 3mm hole, 1mm tool → bored
    expect(op.strokes.some((s) => s.type === 'arc')).toBe(true);
    expect(op.meta.centering_hole_count).toBe('3');
  });
});

describe('mirroring', () => {
  it('reflects points about a vertical axis and flips arc winding', () => {
    const axis = { axis: 'x' as const, position: 60 };
    expect(mirrorPolyline([{ x: 10, y: 5 }, { x: 110, y: 7 }], axis)).toEqual([
      { x: 110, y: 5 },
      { x: 10, y: 7 },
    ]);
    const arc = mirrorStroke(
      { type: 'arc', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, center: { x: 5, y: 0 }, ccw: true },
      axis,
    );
    expect(arc.type).toBe('arc');
    if (arc.type === 'arc') {
      expect(arc.ccw).toBe(false);
      expect(arc.center).toEqual({ x: 115, y: 0 });
    }
  });

  it('horizontal-axis mirror reflects y only', () => {
    const axis = { axis: 'y' as const, position: 50 };
    expect(mirrorPolyline([{ x: 3, y: 20 }], axis)).toEqual([{ x: 3, y: 80 }]);
  });
});
