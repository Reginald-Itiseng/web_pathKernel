import { describe, expect, it } from 'vitest';
import { collectDrillHoles } from '../copper';
import { buildDrillToolpaths } from '../drilling';

describe('routed Excellon slots', () => {
  it('keeps tool-width paths and emits a routed drill toolpath', () => {
    const features = collectDrillHoles([
      {
        type: 'path',
        width: 1,
        polarity: 'dark',
        segments: [{ type: 'line', start: { x: 10, y: 5 }, end: { x: 16, y: 5 } }],
      },
    ]);

    expect(features).toEqual([
      {
        type: 'slot',
        width: 1,
        segments: [{ type: 'line', start: { x: 10, y: 5 }, end: { x: 16, y: 5 } }],
      },
    ]);

    const operation = buildDrillToolpaths({
      id: 'drill-slots',
      layerId: 'drill',
      label: 'Drill',
      toolNumber: 1,
      holes: features,
      params: { toolDiameterMm: 1, lateralStepoverPct: 50, allowOversizeForSmallHoles: false },
    });

    expect(operation.stats.plungeCount).toBe(1);
    expect(operation.meta.drill_slot_count).toBe('1');
    expect(operation.strokes).toContainEqual({
      type: 'line', start: { x: 10, y: 5 }, end: { x: 16, y: 5 },
    });
  });
});
