/**
 * Fallback ingest: builds approximate KPrimitives from the geometry the app
 * already scrapes out of gerber-to-svg output. Used when the tracespace v5
 * alpha parser fails on a file, so the kernel keeps working at reduced
 * fidelity (pads become simple circles/rects, traces become swept centerlines).
 *
 * This module is DOM-free: the caller extracts the SVG-derived data and passes
 * plain structures in.
 */
import type { KPoint, KPrimitive, LayerPrimitives } from '../types';
import { mergeBounds, ringBounds } from '../geom2d';

export interface SvgFallbackPad {
  shape: 'circle' | 'rect' | 'ring' | 'polygon' | 'complex';
  xMm: number;
  yMm: number;
  diameterMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

export interface SvgFallbackTrace {
  widthMm: number;
  points: KPoint[];
}

export interface SvgFallbackHole {
  xMm: number;
  yMm: number;
  diameterMm: number;
}

export interface SvgFallbackInput {
  pads: SvgFallbackPad[];
  traces: SvgFallbackTrace[];
  holes: SvgFallbackHole[];
}

export function ingestSvgFallback(input: SvgFallbackInput, layerId: string): LayerPrimitives {
  const primitives: KPrimitive[] = [];
  let bounds: [number, number, number, number] | null = null;

  for (const pad of input.pads) {
    if (pad.shape === 'rect' && pad.widthMm != null && pad.heightMm != null) {
      primitives.push({
        type: 'rect',
        cx: pad.xMm,
        cy: pad.yMm,
        w: pad.widthMm,
        h: pad.heightMm,
        r: 0,
        polarity: 'dark',
        flashed: true,
      });
      bounds = mergeBounds(bounds, [
        pad.xMm - pad.widthMm / 2,
        pad.yMm - pad.heightMm / 2,
        pad.xMm + pad.widthMm / 2,
        pad.yMm + pad.heightMm / 2,
      ]);
      continue;
    }
    const dia = pad.diameterMm ?? Math.max(pad.widthMm ?? 0, pad.heightMm ?? 0);
    if (dia > 0) {
      primitives.push({
        type: 'circle',
        cx: pad.xMm,
        cy: pad.yMm,
        r: dia / 2,
        polarity: 'dark',
        flashed: true,
      });
      bounds = mergeBounds(bounds, [
        pad.xMm - dia / 2,
        pad.yMm - dia / 2,
        pad.xMm + dia / 2,
        pad.yMm + dia / 2,
      ]);
    }
  }

  for (const trace of input.traces) {
    if (trace.points.length < 2 || trace.widthMm <= 0) continue;
    const segments: KPrimitive & { type: 'path' } = {
      type: 'path',
      width: trace.widthMm,
      segments: [],
      polarity: 'dark',
    };
    for (let i = 1; i < trace.points.length; i++) {
      segments.segments.push({ type: 'line', start: trace.points[i - 1], end: trace.points[i] });
    }
    primitives.push(segments);
    const [minX, minY, maxX, maxY] = ringBounds(trace.points);
    const r = trace.widthMm / 2;
    bounds = mergeBounds(bounds, [minX - r, minY - r, maxX + r, maxY + r]);
  }

  for (const hole of input.holes) {
    if (hole.diameterMm <= 0) continue;
    primitives.push({ type: 'drill', cx: hole.xMm, cy: hole.yMm, diameter: hole.diameterMm });
    const r = hole.diameterMm / 2;
    bounds = mergeBounds(bounds, [hole.xMm - r, hole.yMm - r, hole.xMm + r, hole.yMm + r]);
  }

  return { layerId, source: 'svg-fallback', primitives, bounds };
}
