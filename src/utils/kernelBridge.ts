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
import type { KernelJobLayer, KernelLayerRole, LayerPrimitives } from '../kernel/types';
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
