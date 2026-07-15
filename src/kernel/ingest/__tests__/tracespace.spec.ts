import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestTracespace } from '../tracespace';

const FIXTURE_DIR = join(__dirname, '../../../../test_gerbers/motor_driver');

function load(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

describe('ingestTracespace on motor_driver fixtures', () => {
  it('ingests F_Cu copper with pads and traces', () => {
    const { layer, warnings } = ingestTracespace(load('ObsidianSpin-F_Cu.gbr'), 'fcu');
    expect(layer.primitives.length).toBeGreaterThan(10);
    expect(layer.bounds).not.toBeNull();
    const types = new Set(layer.primitives.map((p) => p.type));
    expect(types.has('path')).toBe(true); // traces
    expect(warnings).toEqual([]);
    const [minX, minY, maxX, maxY] = layer.bounds!;
    expect(maxX - minX).toBeGreaterThan(5);
    expect(maxX - minX).toBeLessThan(500);
    expect(maxY - minY).toBeGreaterThan(5);
    expect(maxY - minY).toBeLessThan(500);
  });

  it('ingests B_Cu copper', () => {
    const { layer } = ingestTracespace(load('ObsidianSpin-B_Cu.gbr'), 'bcu');
    expect(layer.primitives.length).toBeGreaterThan(5);
  });

  it('ingests Edge_Cuts as zero-ish width paths', () => {
    const { layer } = ingestTracespace(load('ObsidianSpin-Edge_Cuts.gbr'), 'edge');
    const paths = layer.primitives.filter((p) => p.type === 'path');
    expect(paths.length).toBeGreaterThan(0);
  });

  it('ingests the Excellon drill file as circle flashes', () => {
    const { layer, filetype } = ingestTracespace(load('ObsidianSpin.drl'), 'drl');
    expect(filetype).toBe('drill');
    const circles = layer.primitives.filter((p) => p.type === 'circle');
    expect(circles.length).toBeGreaterThan(0);
    for (const c of circles) {
      if (c.type !== 'circle') continue;
      expect(c.r * 2).toBeGreaterThan(0.1); // sane drill sizes
      expect(c.r * 2).toBeLessThan(10);
    }
  });

  it('keeps copper bounds consistent between F_Cu and B_Cu (same board)', () => {
    const f = ingestTracespace(load('ObsidianSpin-F_Cu.gbr'), 'f').layer.bounds!;
    const b = ingestTracespace(load('ObsidianSpin-B_Cu.gbr'), 'b').layer.bounds!;
    // Same board: bounds should overlap heavily (within 10 mm on each edge).
    expect(Math.abs(f[0] - b[0])).toBeLessThan(10);
    expect(Math.abs(f[2] - b[2])).toBeLessThan(10);
  });
});
