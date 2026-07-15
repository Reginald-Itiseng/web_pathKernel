/**
 * Regression: the tracespace plotter's macro vector-line (code 20) is broken —
 * it offsets endpoints along the line instead of perpendicular, emitting
 * zero-area bowtie polygons. KiCad RoundRect pads (box + 4 corner circles +
 * 4 vector-line edge strips) then lose their edge strips and grow "mouse
 * ears" where the corner circles bulge past the thin body. Ingest repairs the
 * bowties back into the intended rectangles.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initClipper, polygonSetArea, unionPolygons } from '../clip';
import { primitiveToPolygons } from '../copper';
import { ringArea } from '../geom2d';
import { ingestTracespace } from '../ingest/tracespace';
import type { KPrimitive } from '../types';

const FIXTURE_DIR = join(__dirname, '../../../test_gerbers/motor_driver');

beforeAll(async () => {
  await initClipper();
});

describe('RoundRect macro pads', () => {
  it('no zero-area bowtie polygons survive ingest', () => {
    const content = readFileSync(join(FIXTURE_DIR, 'ObsidianSpin-F_Cu.gbr'), 'utf8');
    const { layer } = ingestTracespace(content, 'fcu');
    let quadCount = 0;
    for (const prim of layer.primitives) {
      if (prim.type !== 'polygon' || prim.points.length !== 4) continue;
      quadCount++;
      const area = Math.abs(ringArea(prim.points));
      // Every 4-point polygon must have real area (the strips are 0.3 x ~1.6).
      expect(area).toBeGreaterThan(1e-3);
    }
    expect(quadCount).toBeGreaterThan(0); // the fixture exercises the case
  });

  it('a D22 RoundRect pad unions to the exact rounded-rectangle area', () => {
    const content = readFileSync(join(FIXTURE_DIR, 'ObsidianSpin-F_Cu.gbr'), 'utf8');
    const { layer } = ingestTracespace(content, 'fcu');

    // D22: corners at (±0.15, ±0.8) relative, rounding radius 0.15
    // → pad 0.6 x 1.9 mm. Locate one pad by its 4 corner circles (r=0.15),
    // then collect only the macro pieces inside that pad's bounding box.
    const cornerCircles = layer.primitives.filter(
      (p): p is KPrimitive & { type: 'circle' } =>
        p.type === 'circle' && Math.abs(p.r - 0.15) < 1e-6,
    );
    expect(cornerCircles.length).toBeGreaterThanOrEqual(4);
    const anchor = cornerCircles[0];
    const mates = cornerCircles.filter(
      (c) => Math.abs(c.cx - anchor.cx) <= 0.31 && Math.abs(c.cy - anchor.cy) <= 1.61,
    );
    expect(mates.length).toBe(4);
    const pad = {
      minX: Math.min(...mates.map((c) => c.cx)) - 0.16,
      maxX: Math.max(...mates.map((c) => c.cx)) + 0.16,
      minY: Math.min(...mates.map((c) => c.cy)) - 0.16,
      maxY: Math.max(...mates.map((c) => c.cy)) + 0.16,
    };
    const inside = (x: number, y: number) =>
      x >= pad.minX && x <= pad.maxX && y >= pad.minY && y <= pad.maxY;
    const padPieces = layer.primitives.filter((p) => {
      if (p.type === 'circle') return inside(p.cx, p.cy);
      if (p.type === 'polygon') return p.points.every((pt) => inside(pt.x, pt.y));
      return false;
    });

    const rings = padPieces.flatMap((p) => primitiveToPolygons(p));
    const union = unionPolygons(rings);
    // One convex blob — no ears (ears would still union to 1 ring, so check
    // the area matches the exact rounded rect, not box+circles).
    expect(union.length).toBe(1);
    const w = 0.6;
    const h = 1.9;
    const r = 0.15;
    const expected = w * h - (4 - Math.PI) * r * r;
    expect(Math.abs(polygonSetArea(union) - expected) / expected).toBeLessThan(0.005);
  });
});
