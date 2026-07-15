/**
 * Gerber/Excellon → KPrimitive ingest via @tracespace/parser + plotter (v5 alpha).
 *
 * The plotter yields an ImageTree of geometric primitives — the JS analogue of
 * pcb-tools primitives in the Python kernel. Everything is normalized to mm.
 *
 * Known alpha limitations handled here:
 *  - `%LPC%` (load polarity clear) is not surfaced by the plotter; we scan the
 *    parse tree and report a warning so the caller can flag the layer.
 *  - Macro shapes arrive as LayeredShape with per-shape `erase` flags, which we
 *    map to clear polarity.
 */
import { parse } from '@tracespace/parser';
import {
  plot,
  type ImageGraphic,
  type PathSegment,
  type Shape,
} from '@tracespace/plotter';
import type { KPoint, KPrimitive, KSegment, LayerPrimitives, Polarity } from '../types';

export interface TracespaceIngestResult {
  layer: LayerPrimitives;
  warnings: string[];
  /** 'gerber' | 'drill' as detected by the parser. */
  filetype: string | null;
  units: 'mm' | 'in';
}

export function ingestTracespace(content: string, layerId: string): TracespaceIngestResult {
  const tree = parse(content);
  const image = plot(tree);
  const units = image.units === 'in' ? 'in' : 'mm';
  const scale = units === 'in' ? 25.4 : 1;
  const warnings: string[] = [];

  // The alpha plotter ignores %LPC% — warn when the file uses it.
  const usesClearPolarity = tree.children.some(
    (node) =>
      (node as { type?: string; polarity?: string }).type === 'loadPolarity' &&
      (node as { polarity?: string }).polarity === 'clear',
  );
  if (usesClearPolarity) {
    warnings.push(
      'File uses clear polarity (%LPC%) which the parser cannot represent — copper may be overstated.',
    );
  }

  const primitives: KPrimitive[] = [];
  for (const graphic of image.children) {
    convertGraphic(graphic, scale, primitives);
  }

  let bounds: [number, number, number, number] | null = null;
  if (image.size.length === 4) {
    const [x1, y1, x2, y2] = image.size;
    bounds = [x1 * scale, y1 * scale, x2 * scale, y2 * scale];
  }

  return {
    layer: { layerId, source: 'tracespace', primitives, bounds },
    warnings,
    filetype: (tree as { filetype?: string }).filetype ?? null,
    units,
  };
}

function convertGraphic(graphic: ImageGraphic, scale: number, out: KPrimitive[]): void {
  if (graphic.type === 'imageShape') {
    convertShape(graphic.shape, scale, 'dark', true, out);
    return;
  }
  if (graphic.type === 'imagePath') {
    // The plotter groups ALL strokes drawn with one tool into a single
    // imagePath, so its segment list can contain many disconnected traces.
    // Emit one path primitive per contiguous run — chaining across the gaps
    // would invent phantom traces between unrelated tracks.
    const segments = convertSegments(graphic.segments, scale);
    for (const run of splitContiguousRuns(segments)) {
      out.push({ type: 'path', width: graphic.width * scale, segments: run, polarity: 'dark' });
    }
    return;
  }
  // imageRegion — filled area bounded by segments.
  const segments = convertSegments(graphic.segments, scale);
  if (segments.length > 0) {
    out.push({ type: 'outline', segments, polarity: 'dark', flashed: false });
  }
}

/**
 * Repair the plotter's broken macro vector-line (code 20) polygons.
 *
 * plot-macro.ts `plotVectorLine` offsets the endpoints ALONG the line
 * direction instead of PERPENDICULAR to it, emitting a zero-area bowtie
 * [s+o, e+o, e−o, s−o] with o parallel to (e−s). Without repair, KiCad
 * RoundRect pads lose their edge strips and the corner circles bulge out of
 * the thin body — "mouse ears". The bowtie is algebraically invertible:
 * recover s, e and the half-width, then rebuild the true rectangle with the
 * offset rotated 90°.
 */
function repairMacroVectorLine(points: KPoint[]): KPoint[] {
  if (points.length !== 4) return points;
  const [p0, p1, p2, p3] = points;
  const s: KPoint = { x: (p0.x + p3.x) / 2, y: (p0.y + p3.y) / 2 };
  const e: KPoint = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const o: KPoint = { x: (p0.x - p3.x) / 2, y: (p0.y - p3.y) / 2 };
  const dx = e.x - s.x;
  const dy = e.y - s.y;
  const len = Math.hypot(dx, dy);
  const halfW = Math.hypot(o.x, o.y);
  if (len <= 1e-12 || halfW <= 1e-12) return points;

  // Both point pairs must agree it's the bowtie [s+o, e+o, e−o, s−o].
  const o2: KPoint = { x: (p1.x - p2.x) / 2, y: (p1.y - p2.y) / 2 };
  if (Math.hypot(o2.x - o.x, o2.y - o.y) > 1e-9 + halfW * 1e-6) return points;

  // Bug signature: the offset is parallel to the line (a correct rectangle
  // would have it perpendicular) and the polygon area is ~zero.
  const sinAngle = Math.abs(o.x * dy - o.y * dx) / (len * halfW);
  if (sinAngle > 0.01) return points;
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = points[i];
    const b = points[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  if (Math.abs(area / 2) > 0.01 * len * halfW) return points;

  const px = (-dy / len) * halfW;
  const py = (dx / len) * halfW;
  return [
    { x: s.x + px, y: s.y + py },
    { x: e.x + px, y: e.y + py },
    { x: e.x - px, y: e.y - py },
    { x: s.x - px, y: s.y - py },
  ];
}

/** Continuity tolerance between consecutive segments (mm). */
const CONTIGUITY_TOL_MM = 1e-6;

function splitContiguousRuns(segments: KSegment[]): KSegment[][] {
  const runs: KSegment[][] = [];
  let run: KSegment[] = [];
  for (const seg of segments) {
    if (run.length > 0) {
      const prevEnd = run[run.length - 1].end;
      const gap = Math.hypot(seg.start.x - prevEnd.x, seg.start.y - prevEnd.y);
      if (gap > CONTIGUITY_TOL_MM) {
        runs.push(run);
        run = [];
      }
    }
    run.push(seg);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

function convertShape(
  shape: Shape,
  scale: number,
  polarity: Polarity,
  flashed: boolean,
  out: KPrimitive[],
): void {
  switch (shape.type) {
    case 'circle':
      out.push({
        type: 'circle',
        cx: shape.cx * scale,
        cy: shape.cy * scale,
        r: shape.r * scale,
        polarity,
        flashed,
      });
      return;
    case 'rectangle': {
      // Plotter rectangles are corner-based (x, y = min corner).
      const w = shape.xSize * scale;
      const h = shape.ySize * scale;
      out.push({
        type: 'rect',
        cx: shape.x * scale + w / 2,
        cy: shape.y * scale + h / 2,
        w,
        h,
        r: (shape.r ?? 0) * scale,
        polarity,
        flashed,
      });
      return;
    }
    case 'polygon': {
      const points = repairMacroVectorLine(
        shape.points.map(([x, y]): KPoint => ({ x: x * scale, y: y * scale })),
      );
      out.push({ type: 'polygon', points, polarity, flashed });
      return;
    }
    case 'outline': {
      const segments = convertSegments(shape.segments, scale);
      if (segments.length > 0) {
        out.push({ type: 'outline', segments, polarity, flashed });
      }
      return;
    }
    case 'layeredShape':
      for (const sub of shape.shapes) {
        convertShape(sub, scale, sub.erase ? 'clear' : polarity, flashed, out);
      }
      return;
  }
}

function convertSegments(segments: PathSegment[], scale: number): KSegment[] {
  const out: KSegment[] = [];
  for (const seg of segments) {
    if (seg.type === 'line') {
      out.push({
        type: 'line',
        start: { x: seg.start[0] * scale, y: seg.start[1] * scale },
        end: { x: seg.end[0] * scale, y: seg.end[1] * scale },
      });
    } else {
      // ArcPosition = [x, y, theta]; plotter guarantees endTheta > startTheta
      // for CCW arcs and startTheta > endTheta for CW arcs.
      out.push({
        type: 'arc',
        start: { x: seg.start[0] * scale, y: seg.start[1] * scale },
        end: { x: seg.end[0] * scale, y: seg.end[1] * scale },
        center: { x: seg.center[0] * scale, y: seg.center[1] * scale },
        radius: seg.radius * scale,
        ccw: seg.end[2] > seg.start[2],
      });
    }
  }
  return out;
}
