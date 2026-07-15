/**
 * Toolpath mirroring for double-sided / single-sided-from-back milling.
 * Reflection about the flip axis (line through the centering holes when
 * present). Arcs flip winding under reflection.
 */
import type { KPoint, MirrorAxis, Stroke } from './types';

export function mirrorPoint(p: KPoint, axis: MirrorAxis): KPoint {
  return axis.axis === 'x'
    ? { x: 2 * axis.position - p.x, y: p.y }
    : { x: p.x, y: 2 * axis.position - p.y };
}

export function mirrorPolyline(line: KPoint[], axis: MirrorAxis): KPoint[] {
  return line.map((p) => mirrorPoint(p, axis));
}

export function mirrorStroke(stroke: Stroke, axis: MirrorAxis): Stroke {
  if (stroke.type === 'polyline') {
    return { type: 'polyline', points: mirrorPolyline(stroke.points, axis) };
  }
  if (stroke.type === 'line') {
    return {
      type: 'line',
      start: mirrorPoint(stroke.start, axis),
      end: mirrorPoint(stroke.end, axis),
    };
  }
  return {
    type: 'arc',
    start: mirrorPoint(stroke.start, axis),
    end: mirrorPoint(stroke.end, axis),
    center: mirrorPoint(stroke.center, axis),
    // Reflection reverses winding.
    ccw: !stroke.ccw,
  };
}
