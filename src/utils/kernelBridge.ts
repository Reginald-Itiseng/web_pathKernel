/**
 * App-side bridge between LayerEntry (SVG-era model) and the kernel's
 * primitive model. Ingest prefers the tracespace v5 parser; if that fails the
 * SVG-scraped geometry becomes a reduced-fidelity fallback source.
 */
import { ingestTracespace } from '../kernel/ingest/tracespace';
import {
  ingestSvgFallback,
  type SvgFallbackInput,
} from '../kernel/ingest/svgFallback';
import type { KernelJobLayer, KernelLayerRole, KPrimitive, LayerPrimitives } from '../kernel/types';
import type { LayerGeometry, Point2D } from '../types/geometry';
import type { LayerEntry } from './gerberUtils';
import type { LayerType } from './layerUtils';

export interface IngestOutcome {
  primitives: LayerPrimitives | undefined;
  warnings: string[];
}

export function kernelRoleForLayerType(layerType: LayerType): KernelLayerRole {
  switch (layerType) {
    case 'top-copper':
    case 'bottom-copper':
    case 'board-outline':
    case 'drill':
      return layerType;
    default:
      return 'other';
  }
}

/**
 * Build kernel primitives for a layer. Tries tracespace first; on failure
 * falls back to the SVG-scraped geometry (pads/traces/holes) so the kernel
 * still has something to work with.
 */
export function ingestLayerPrimitives(
  content: string,
  layerId: string,
  layerType: LayerType,
  geometry: LayerGeometry | undefined,
  svgString: string,
  units: string | null,
): IngestOutcome {
  const warnings: string[] = [];
  try {
    const result = ingestTracespace(content, layerId);
    warnings.push(...result.warnings);
    if (result.layer.primitives.length > 0) {
      return { primitives: result.layer, warnings };
    }
    warnings.push('Parser produced no geometry; using SVG-derived fallback.');
  } catch (err) {
    warnings.push(
      `Geometry parser failed (${err instanceof Error ? err.message : String(err)}); using SVG-derived fallback.`,
    );
  }

  try {
    const fallbackInput = buildSvgFallbackInput(geometry, svgString, units, layerType);
    const fallback = ingestSvgFallback(fallbackInput, layerId);
    if (fallback.primitives.length > 0) {
      return { primitives: fallback, warnings };
    }
  } catch {
    // fall through
  }
  warnings.push('No usable geometry could be derived for the CAM kernel.');
  return { primitives: undefined, warnings };
}

function buildSvgFallbackInput(
  geometry: LayerGeometry | undefined,
  svgString: string,
  units: string | null,
  layerType: LayerType,
): SvgFallbackInput {
  const input: SvgFallbackInput = { pads: [], traces: [], holes: [] };
  if (geometry) {
    const defById = new Map(geometry.padDefs.map((d) => [d.defId, d]));
    for (const pad of geometry.padInstances) {
      const def = defById.get(pad.defId);
      if (!def) continue;
      input.pads.push({
        shape: def.shape,
        xMm: pad.xMm,
        yMm: pad.yMm,
        diameterMm: def.diameterMm,
        widthMm: def.widthMm,
        heightMm: def.heightMm,
      });
    }
    for (const hole of geometry.holeInstances) {
      input.holes.push({ xMm: hole.xMm, yMm: hole.yMm, diameterMm: hole.diameterMm });
    }
  }
  // Trace centerlines from the rendered SVG paths.
  if (layerType !== 'drill') {
    for (const { widthMm, points } of extractSvgTracePolylines(svgString, units)) {
      input.traces.push({ widthMm, points });
    }
  }
  return input;
}

/** Extract stroked path centerlines (mm) from a gerber-to-svg document. */
export function extractSvgTracePolylines(
  svgString: string,
  units: string | null,
): Array<{ widthMm: number; points: Point2D[] }> {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const scale = units === 'in' ? 25.4 : 1;
  const out: Array<{ widthMm: number; points: Point2D[] }> = [];
  for (const path of Array.from(doc.querySelectorAll('path[fill="none"]'))) {
    const rawWidth = parseFloat(path.getAttribute('stroke-width') ?? '');
    if (!Number.isFinite(rawWidth) || rawWidth <= 0) continue;
    const points = parseSimplePath(path.getAttribute('d') ?? '', scale);
    if (points.length > 1) {
      out.push({ widthMm: (rawWidth / 1000) * scale, points });
    }
  }
  return out;
}

function parseSimplePath(d: string, scale: number): Point2D[] {
  const tokens = d.match(/[MmLlHhVvZz]|[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const points: Point2D[] = [];
  let i = 0;
  let cmd = '';
  let current = { x: 0, y: 0 };

  while (i < tokens.length) {
    if (/^[a-z]$/i.test(tokens[i])) cmd = tokens[i++];
    if (!cmd) break;

    if (cmd === 'M' || cmd === 'L') {
      const x = Number(tokens[i++]);
      const y = Number(tokens[i++]);
      current = { x: (x / 1000) * scale, y: (y / 1000) * scale };
      points.push(current);
    } else if (cmd === 'm' || cmd === 'l') {
      const x = Number(tokens[i++]);
      const y = Number(tokens[i++]);
      current = { x: current.x + (x / 1000) * scale, y: current.y + (y / 1000) * scale };
      points.push(current);
    } else if (cmd === 'H') {
      current = { ...current, x: (Number(tokens[i++]) / 1000) * scale };
      points.push(current);
    } else if (cmd === 'V') {
      current = { ...current, y: (Number(tokens[i++]) / 1000) * scale };
      points.push(current);
    } else if (cmd === 'Z' || cmd === 'z') {
      if (points[0]) points.push(points[0]);
    } else {
      i++;
    }
  }

  return points;
}

/** Assemble worker job layers from the app's layer entries. */
export function buildKernelLayers(layers: LayerEntry[]): KernelJobLayer[] {
  const out: KernelJobLayer[] = [];
  for (const layer of layers) {
    if (!layer.primitives) continue;
    out.push({ ...layer.primitives, role: kernelRoleForLayerType(layer.layerType) });
  }
  return out;
}

// ─── Editing: propagate SVG-preview edits into kernel primitives ──────────
//
// geometryUtils.ts's editPadSize/editTraceWidth/etc. only rewrite the SVG
// preview — they have no way to touch `layer.primitives` because that's a
// completely separate parse of the ORIGINAL Gerber text (via tracespace),
// with no shared identifiers back to an SVG defId/instanceId/pathId. These
// mirror each SVG editor but operate on the kernel's KPrimitive[] instead,
// correlating edits to primitives by POSITION (pads/holes) or WIDTH class
// (bulk trace edits) — both of which are already known to agree between the
// two independent parses (kernel/ingest/svgFallback.ts relies on the same
// PadInstance/HoleInstance.xMm/yMm as direct KPrimitive cx/cy, unflipped).

/**
 * Position-match tolerance for correlating SVG-edited geometry back to
 * kernel primitives (mm). Tight relative to real pad/trace spacing (rarely
 * under 0.1mm even on dense boards) so it can only ever miss a match (safe
 * no-op, same as today's behavior) rather than resize the wrong feature.
 */
const PRIMITIVE_MATCH_TOL_MM = 5e-3;

function primitiveCenter(p: KPrimitive): Point2D | null {
  if (p.type === 'circle' || p.type === 'rect' || p.type === 'drill') return { x: p.cx, y: p.cy };
  return null;
}

function findPrimitiveIndicesNear(primitives: KPrimitive[], xMm: number, yMm: number): number[] {
  const out: number[] = [];
  primitives.forEach((p, i) => {
    const c = primitiveCenter(p);
    if (c && Math.hypot(c.x - xMm, c.y - yMm) <= PRIMITIVE_MATCH_TOL_MM) out.push(i);
  });
  return out;
}

/** Resize a flashed pad/hole primitive (aspect-preserving for rects, mirrors resizePadElement). */
function resizedPad(p: KPrimitive, newDiameterMm: number): KPrimitive | null {
  if (p.type === 'circle') return { ...p, r: newDiameterMm / 2 };
  if (p.type === 'drill') return { ...p, diameter: newDiameterMm };
  if (p.type === 'rect') {
    const oldMax = Math.max(p.w, p.h);
    if (oldMax <= 0) return null;
    const factor = newDiameterMm / oldMax;
    return { ...p, w: p.w * factor, h: p.h * factor };
  }
  return null;
}

function withEditedPrimitivesAt(
  layerPrimitives: LayerPrimitives,
  indices: number[],
  edit: (p: KPrimitive) => KPrimitive | null,
): LayerPrimitives {
  if (indices.length === 0) return layerPrimitives;
  const primitives = layerPrimitives.primitives.slice();
  let changed = false;
  for (const i of indices) {
    const edited = edit(primitives[i]);
    if (edited) {
      primitives[i] = edited;
      changed = true;
    }
  }
  return changed ? { ...layerPrimitives, primitives } : layerPrimitives;
}

/** Mirrors `editPadSize`: resize every kernel primitive at a pad instance sharing `defId`. */
export function editKernelPadSize(
  layerPrimitives: LayerPrimitives | undefined,
  geometry: LayerGeometry,
  defId: string,
  newDiameterMm: number,
): LayerPrimitives | undefined {
  if (!layerPrimitives) return layerPrimitives;
  let result = layerPrimitives;
  for (const inst of geometry.padInstances) {
    if (inst.defId !== defId) continue;
    const indices = findPrimitiveIndicesNear(result.primitives, inst.xMm, inst.yMm);
    result = withEditedPrimitivesAt(result, indices, (p) => resizedPad(p, newDiameterMm));
  }
  return result;
}

/** Mirrors `editSinglePadSize`: resize just the kernel primitive at one placed pad instance. */
export function editKernelSinglePadSize(
  layerPrimitives: LayerPrimitives | undefined,
  geometry: LayerGeometry,
  instanceId: string,
  newDiameterMm: number,
): LayerPrimitives | undefined {
  if (!layerPrimitives) return layerPrimitives;
  const inst = geometry.padInstances.find((p) => p.instanceId === instanceId);
  if (!inst) return layerPrimitives;
  const indices = findPrimitiveIndicesNear(layerPrimitives.primitives, inst.xMm, inst.yMm);
  return withEditedPrimitivesAt(layerPrimitives, indices, (p) => resizedPad(p, newDiameterMm));
}

/** Mirrors `editHoleDiameter` (same defId-keyed resize as pads — holes are pad instances too). */
export function editKernelHoleDiameter(
  layerPrimitives: LayerPrimitives | undefined,
  geometry: LayerGeometry,
  defId: string,
  newDiameterMm: number,
): LayerPrimitives | undefined {
  return editKernelPadSize(layerPrimitives, geometry, defId, newDiameterMm);
}

/** Mirrors `editTraceWidth`: resize every path primitive at the old width class. */
export function editKernelTraceWidth(
  layerPrimitives: LayerPrimitives | undefined,
  oldWidthMm: number,
  newWidthMm: number,
): LayerPrimitives | undefined {
  if (!layerPrimitives) return layerPrimitives;
  let changed = false;
  const primitives = layerPrimitives.primitives.map((p) => {
    if (p.type === 'path' && Math.abs(p.width - oldWidthMm) <= PRIMITIVE_MATCH_TOL_MM) {
      changed = true;
      return { ...p, width: newWidthMm };
    }
    return p;
  });
  return changed ? { ...layerPrimitives, primitives } : layerPrimitives;
}

/**
 * Mirrors `editSingleTraceWidth`: resize just the kernel path primitive(s)
 * matching one specific SVG-rendered trace's geometry. A single on-screen
 * trace can correspond to several KPrimitive 'path' runs (tracespace splits
 * at any gap — a via, a component boundary), so each run is matched
 * independently by checking whether BOTH its endpoints lie on the rendered
 * polyline, not just the polyline's own overall start/end.
 */
export function editKernelSingleTraceWidth(
  layerPrimitives: LayerPrimitives | undefined,
  svgString: string,
  pathId: string,
  newWidthMm: number,
  units: string | null,
): LayerPrimitives | undefined {
  if (!layerPrimitives) return layerPrimitives;
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const pathEl = doc.querySelector(`path[data-path-id="${cssEscape(pathId)}"]`);
  if (!pathEl) return layerPrimitives;
  const scale = units === 'in' ? 25.4 : 1;
  const polyline = parseSimplePath(pathEl.getAttribute('d') ?? '', scale);
  if (polyline.length < 2) return layerPrimitives;

  const onPolyline = (pt: Point2D): boolean =>
    polyline.some((p) => Math.hypot(p.x - pt.x, p.y - pt.y) <= PRIMITIVE_MATCH_TOL_MM);

  let changed = false;
  const primitives = layerPrimitives.primitives.map((p) => {
    if (p.type !== 'path' || p.segments.length === 0) return p;
    const start = p.segments[0].start;
    const end = p.segments[p.segments.length - 1].end;
    if (onPolyline(start) && onPolyline(end)) {
      changed = true;
      return { ...p, width: newWidthMm };
    }
    return p;
  });
  return changed ? { ...layerPrimitives, primitives } : layerPrimitives;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
