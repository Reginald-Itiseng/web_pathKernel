import type { LayerType } from './layerUtils';
import type {
  LayerGeometry,
  PadDefinition,
  PadInstance,
  PadShape,
  TraceClass,
  HoleInstance,
  PadHoleMatch,
} from '../types/geometry';
import type { LayerEntry } from './gerberUtils';

// ─── Extraction ──────────────────────────────────────────────────────────────

/**
 * Parses the already-rendered SVG string of a layer and builds a typed
 * geometry model: pad definitions, pad instances, trace widths, and (for
 * drill layers) hole instances.
 *
 * Coordinate convention: use.x and use.y in the gerber-to-svg output store
 * the original Gerber coordinates × 1000 BEFORE the Y-flip transform. Dividing
 * by 1000 (and scaling by 25.4 for inch layers) gives real-world mm values.
 */
export function extractLayerGeometry(
  svgString: string,
  layerId: string,
  layerType: LayerType,
  units: string | null,
): LayerGeometry {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const svg = doc.documentElement;
  const prefix = svg.getAttribute('id') ?? '';
  const scale = units === 'in' ? 25.4 : 1; // coordinate unit → mm

  const padDefs = extractPadDefs(doc, prefix);
  const padInstances = extractPadInstances(doc, layerId, scale);
  const traceClasses = extractTraceClasses(doc, layerId);

  const holeInstances: HoleInstance[] =
    layerType === 'drill'
      ? buildHoleInstances(padInstances, padDefs, layerId)
      : [];

  return { layerId, padDefs, padInstances, traceClasses, holeInstances };
}

function extractPadDefs(doc: Document, prefix: string): PadDefinition[] {
  const defs = doc.querySelector('defs');
  if (!defs) return [];

  const pattern = new RegExp(`^${escapeRegExp(prefix)}_pad-(.+)$`);
  const result: PadDefinition[] = [];

  for (const child of Array.from(defs.children)) {
    const id = child.getAttribute('id') ?? '';
    // skip mask elements (clear-layer machinery)
    if (id.includes('_mask-')) continue;

    const match = pattern.exec(id);
    if (!match) continue;

    const toolCode = match[1];
    result.push(parsePadDef(child, id, toolCode));
  }

  return result;
}

function parsePadDef(el: Element, defId: string, toolCode: string): PadDefinition {
  const base: Pick<PadDefinition, 'defId' | 'toolCode'> = { defId, toolCode };
  const nullDims = { diameterMm: null, widthMm: null, heightMm: null, ringStrokeWidthMm: null };

  const tag = el.tagName.toLowerCase();

  if (tag === 'circle') {
    const r = parseFloat(el.getAttribute('r') ?? '0');
    const sw = el.getAttribute('stroke-width');
    if (sw != null) {
      return { ...base, ...nullDims, shape: 'ring', diameterMm: (r * 2) / 1000, ringStrokeWidthMm: parseFloat(sw) / 1000 };
    }
    return { ...base, ...nullDims, shape: 'circle', diameterMm: (r * 2) / 1000 };
  }

  if (tag === 'rect') {
    const w = parseFloat(el.getAttribute('width') ?? '0');
    const h = parseFloat(el.getAttribute('height') ?? '0');
    return { ...base, ...nullDims, shape: 'rect', widthMm: w / 1000, heightMm: h / 1000 };
  }

  if (tag === 'polygon') {
    return { ...base, ...nullDims, shape: 'polygon' };
  }

  // <g> — multi-shape macro pad
  return { ...base, ...nullDims, shape: 'complex' };
}

function extractPadInstances(doc: Document, layerId: string, scale: number): PadInstance[] {
  const uses = Array.from(doc.querySelectorAll('use'));
  const result: PadInstance[] = [];

  for (const use of uses) {
    const href =
      use.getAttribute('xlink:href') ??
      use.getAttribute('href') ??
      '';
    if (!href.includes('_pad-')) continue; // skip block-repeat uses

    const xRaw = parseFloat(use.getAttribute('x') ?? '0');
    const yRaw = parseFloat(use.getAttribute('y') ?? '0');

    result.push({
      defId: href.startsWith('#') ? href.slice(1) : href,
      xMm: (xRaw / 1000) * scale,
      yMm: (yRaw / 1000) * scale,
      layerId,
    });
  }

  return result;
}

function extractTraceClasses(doc: Document, layerId: string): TraceClass[] {
  const paths = Array.from(doc.querySelectorAll('path[fill="none"]'));
  const map = new Map<number, TraceClass>();

  for (const path of paths) {
    const swAttr = path.getAttribute('stroke-width');
    if (!swAttr) continue;
    const raw = parseFloat(swAttr);
    if (!isFinite(raw) || raw <= 0) continue;

    const existing = map.get(raw);
    if (existing) {
      existing.instanceCount++;
    } else {
      map.set(raw, { strokeWidthRaw: raw, widthMm: raw / 1000, instanceCount: 1, layerId });
    }
  }

  return Array.from(map.values()).sort((a, b) => a.strokeWidthRaw - b.strokeWidthRaw);
}

function buildHoleInstances(
  instances: PadInstance[],
  defs: PadDefinition[],
  layerId: string,
): HoleInstance[] {
  const defMap = new Map(defs.map((d) => [d.defId, d]));
  const result: HoleInstance[] = [];

  for (const inst of instances) {
    const def = defMap.get(inst.defId);
    if (!def || def.diameterMm == null) continue;
    result.push({ defId: inst.defId, diameterMm: def.diameterMm, xMm: inst.xMm, yMm: inst.yMm, layerId });
  }

  return result;
}

// ─── Editing ─────────────────────────────────────────────────────────────────

/**
 * Modifies the pad definition `defId` in the SVG to have the given diameter.
 * Works for circle and rect shapes; no-ops silently for complex/polygon.
 */
export function editPadSize(svgString: string, defId: string, newDiameterMm: number): string {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const el = doc.getElementById(defId);
  if (!el) {
    console.warn('[editPadSize] element not found:', defId);
    return svgString;
  }

  const tag = el.tagName.toLowerCase();
  const newRaw = (newDiameterMm * 1000) / 2; // diameter → radius in SVG units

  if (tag === 'circle') {
    el.setAttribute('r', fmtN(newRaw));
  } else if (tag === 'rect') {
    const oldW = parseFloat(el.getAttribute('width') ?? '0');
    const oldH = parseFloat(el.getAttribute('height') ?? '0');
    const oldMax = Math.max(oldW, oldH);
    if (oldMax <= 0) return svgString;
    const scaleFactor = (newDiameterMm * 1000) / oldMax;
    const newW = oldW * scaleFactor;
    const newH = oldH * scaleFactor;
    el.setAttribute('width',  fmtN(newW));
    el.setAttribute('height', fmtN(newH));
    el.setAttribute('x', fmtN(-newW / 2));
    el.setAttribute('y', fmtN(-newH / 2));
  } else {
    console.warn('[editPadSize] unsupported shape for edit:', tag, defId);
    return svgString;
  }

  return new XMLSerializer().serializeToString(doc);
}

/**
 * Changes all trace paths whose stroke-width matches `oldStrokeWidthRaw`
 * to the new width. Uses raw SVG units to avoid float re-parsing drift.
 */
export function editTraceWidth(
  svgString: string,
  oldStrokeWidthRaw: number,
  newWidthMm: number,
): string {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const paths = doc.querySelectorAll('path[fill="none"]');
  const oldStr = String(oldStrokeWidthRaw);
  const newRaw = fmtN(newWidthMm * 1000);

  let changed = false;
  for (const path of Array.from(paths)) {
    if (path.getAttribute('stroke-width') === oldStr) {
      path.setAttribute('stroke-width', newRaw);
      changed = true;
    }
  }

  if (!changed) {
    console.warn('[editTraceWidth] no paths matched stroke-width:', oldStrokeWidthRaw);
    return svgString;
  }

  return new XMLSerializer().serializeToString(doc);
}

/** Changes the drill hole def radius for the given defId. */
export function editHoleDiameter(svgString: string, defId: string, newDiameterMm: number): string {
  return editPadSize(svgString, defId, newDiameterMm);
}

// ─── Cross-layer matching ────────────────────────────────────────────────────

const MATCH_TOLERANCE_MM = 0.025; // ±25 µm standard drill registration

/**
 * Finds copper pad instances that have a drill hole at the same board position
 * within the registration tolerance. Returns one match per hole.
 */
export function matchPadsToHoles(layers: LayerEntry[]): PadHoleMatch[] {
  const copperLayers = layers.filter(
    (l) => l.layerType === 'top-copper' || l.layerType === 'bottom-copper',
  );
  const drillLayers = layers.filter((l) => l.layerType === 'drill');

  if (!copperLayers.length || !drillLayers.length) return [];

  const allHoles: HoleInstance[] = drillLayers.flatMap((l) => l.geometry?.holeInstances ?? []);
  const allPads:  PadInstance[]  = copperLayers.flatMap((l) => l.geometry?.padInstances  ?? []);
  const matches:  PadHoleMatch[] = [];

  for (const hole of allHoles) {
    for (const pad of allPads) {
      const dx = pad.xMm - hole.xMm;
      const dy = pad.yMm - hole.yMm;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= MATCH_TOLERANCE_MM) {
        matches.push({ pad, hole, distanceMm: dist });
        break; // first copper match per hole is enough
      }
    }
  }

  return matches;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format a number for SVG attributes — integer if whole, otherwise trim trailing zeros. */
function fmtN(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/\.?0+$/, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Re-export the shape type so callers don't need to import from two places
export type { PadShape };
