import type { LayerType } from './layerUtils';
import type {
  LayerGeometry,
  PadDefinition,
  PadInstance,
  PadShape,
  TraceClass,
  HoleInstance,
  PadHoleMatch,
  PadHoleAnalysis,
  ValidationRuleSet,
} from '../types/geometry';
import type { LayerEntry } from './gerberUtils';

export const DEFAULT_VALIDATION_RULES: ValidationRuleSet = {
  minTraceWidthMm: 0.2,
  minDrillMm: 0.3,
  minAnnularRingMm: 0.15,
  minIsolationMm: 0.2,
  matchToleranceMm: 0.025,
  outlineClosureToleranceMm: 0.05,
};

export function extractLayerGeometry(
  svgString: string,
  layerId: string,
  layerType: LayerType,
  units: string | null,
): LayerGeometry {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const scale = units === 'in' ? 25.4 : 1;

  const padDefs = extractPadDefs(doc);
  const padInstances = extractPadInstances(doc, layerId, scale);
  const traceClasses = extractTraceClasses(doc, layerId);
  const holeInstances: HoleInstance[] =
    layerType === 'drill'
      ? buildHoleInstances(padInstances, padDefs, layerId)
      : [];

  return { layerId, padDefs, padInstances, traceClasses, holeInstances };
}

function extractPadDefs(doc: Document): PadDefinition[] {
  const defs = doc.querySelector('defs');
  if (!defs) return [];

  return Array.from(defs.children)
    .map((child) => {
      const id = child.getAttribute('id') ?? '';
      if (id.includes('_mask-')) return null;
      const markerIndex = id.indexOf('_pad-');
      if (markerIndex < 0) return null;
      return parsePadDef(child, id, id.slice(markerIndex + '_pad-'.length));
    })
    .filter((def): def is PadDefinition => def != null);
}

function parsePadDef(el: Element, defId: string, toolCode: string): PadDefinition {
  const base: Pick<PadDefinition, 'defId' | 'toolCode'> = { defId, toolCode };
  const nullDims = { diameterMm: null, widthMm: null, heightMm: null, ringStrokeWidthMm: null };
  const tag = el.tagName.toLowerCase();

  if (tag === 'circle') {
    const r = parseFloat(el.getAttribute('r') ?? '0');
    const sw = el.getAttribute('stroke-width');
    if (sw != null) {
      return {
        ...base,
        ...nullDims,
        shape: 'ring',
        diameterMm: (r * 2) / 1000,
        ringStrokeWidthMm: parseFloat(sw) / 1000,
      };
    }
    return { ...base, ...nullDims, shape: 'circle', diameterMm: (r * 2) / 1000 };
  }

  if (tag === 'rect') {
    const w = parseFloat(el.getAttribute('width') ?? '0');
    const h = parseFloat(el.getAttribute('height') ?? '0');
    return { ...base, ...nullDims, shape: 'rect', widthMm: w / 1000, heightMm: h / 1000 };
  }

  if (tag === 'polygon') return { ...base, ...nullDims, shape: 'polygon' };
  return { ...base, ...nullDims, shape: 'complex' };
}

function extractPadInstances(doc: Document, layerId: string, scale: number): PadInstance[] {
  const result: PadInstance[] = [];
  let idx = 0;

  for (const use of Array.from(doc.querySelectorAll('use'))) {
    const href = use.getAttribute('xlink:href') ?? use.getAttribute('href') ?? '';
    if (!href.includes('_pad-')) continue;

    const xRaw = parseFloat(use.getAttribute('x') ?? '0');
    const yRaw = parseFloat(use.getAttribute('y') ?? '0');
    const instanceId = use.getAttribute('data-pad-instance-id') ?? `${layerId}:pad:${idx}`;
    result.push({
      instanceId,
      featureId: instanceId,
      defId: href.startsWith('#') ? href.slice(1) : href,
      xMm: (xRaw / 1000) * scale,
      yMm: (yRaw / 1000) * scale,
      layerId,
    });
    idx++;
  }

  return result;
}

function extractTraceClasses(doc: Document, layerId: string): TraceClass[] {
  const map = new Map<number, TraceClass>();

  for (const path of Array.from(doc.querySelectorAll('path[fill="none"]'))) {
    const raw = parseFloat(path.getAttribute('stroke-width') ?? '');
    if (!Number.isFinite(raw) || raw <= 0) continue;

    const pathId = path.getAttribute('data-path-id') ?? `${layerId}:trace:${map.size}:${raw}`;
    const existing = map.get(raw);
    if (existing) {
      existing.instanceCount++;
      existing.pathIds.push(pathId);
    } else {
      map.set(raw, {
        strokeWidthRaw: raw,
        widthMm: raw / 1000,
        instanceCount: 1,
        layerId,
        pathIds: [pathId],
      });
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
  let idx = 0;

  for (const inst of instances) {
    const def = defMap.get(inst.defId);
    if (!def || def.diameterMm == null) continue;
    const instanceId = `${layerId}:hole:${idx++}`;
    result.push({
      instanceId,
      featureId: instanceId,
      defId: inst.defId,
      diameterMm: def.diameterMm,
      xMm: inst.xMm,
      yMm: inst.yMm,
      layerId,
    });
  }

  return result;
}

export function addPathIds(svgString: string, layerId: string): string {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  let pathIdx = 0;
  let padIdx = 0;

  for (const use of Array.from(doc.querySelectorAll('use'))) {
    const href = use.getAttribute('xlink:href') ?? use.getAttribute('href') ?? '';
    if (!href.includes('_pad-')) continue;
    use.setAttribute('data-pad-instance-id', `${layerId}:pad:${padIdx++}`);
  }

  for (const path of Array.from(doc.querySelectorAll('path[fill="none"]'))) {
    const loops = splitPathLoops(path.getAttribute('d') ?? '');
    if (loops.length <= 1) {
      path.setAttribute('data-path-id', `${layerId}:trace:${pathIdx++}`);
      continue;
    }

    const parent = path.parentNode;
    if (!parent) continue;

    for (const d of loops) {
      const loopPath = path.cloneNode(false) as Element;
      loopPath.setAttribute('d', d);
      loopPath.setAttribute('data-path-id', `${layerId}:trace:${pathIdx++}`);
      parent.insertBefore(loopPath, path);
    }
    parent.removeChild(path);
  }

  return new XMLSerializer().serializeToString(doc);
}

function splitPathLoops(pathData: string): string[] {
  const starts: number[] = [];
  let previousCommand = true;

  for (let i = 0; i < pathData.length; i++) {
    const ch = pathData[i];
    if ((ch === 'M' || ch === 'm') && previousCommand) starts.push(i);
    if (/[a-zA-Z]/.test(ch)) previousCommand = true;
    if (/[-+0-9.]/.test(ch)) previousCommand = false;
  }

  if (starts.length <= 1) return pathData.trim() ? [pathData.trim()] : [];
  return starts
    .map((start, i) => pathData.slice(start, starts[i + 1]).trim())
    .filter(Boolean);
}

export function editPadSize(svgString: string, defId: string, newDiameterMm: number): string {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const el = doc.getElementById(defId);
  if (!el) return svgString;

  const tag = el.tagName.toLowerCase();
  const newRawRadius = (newDiameterMm * 1000) / 2;

  if (tag === 'circle') {
    el.setAttribute('r', fmtN(newRawRadius));
  } else if (tag === 'rect') {
    const oldW = parseFloat(el.getAttribute('width') ?? '0');
    const oldH = parseFloat(el.getAttribute('height') ?? '0');
    const oldMax = Math.max(oldW, oldH);
    if (oldMax <= 0) return svgString;
    const scaleFactor = (newDiameterMm * 1000) / oldMax;
    const newW = oldW * scaleFactor;
    const newH = oldH * scaleFactor;
    el.setAttribute('width', fmtN(newW));
    el.setAttribute('height', fmtN(newH));
    el.setAttribute('x', fmtN(-newW / 2));
    el.setAttribute('y', fmtN(-newH / 2));
  } else {
    return svgString;
  }

  return new XMLSerializer().serializeToString(doc);
}

export function editTraceWidth(
  svgString: string,
  oldStrokeWidthRaw: number,
  newWidthMm: number,
): string {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const newRaw = fmtN(newWidthMm * 1000);
  let changed = false;

  for (const path of Array.from(doc.querySelectorAll('path[fill="none"]'))) {
    const raw = parseFloat(path.getAttribute('stroke-width') ?? '');
    if (Number.isFinite(raw) && Math.abs(raw - oldStrokeWidthRaw) < 0.000001) {
      path.setAttribute('stroke-width', newRaw);
      changed = true;
    }
  }

  return changed ? new XMLSerializer().serializeToString(doc) : svgString;
}

export function editSingleTraceWidth(svgString: string, pathId: string, newWidthMm: number): string {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const path = doc.querySelector(`path[data-path-id="${cssEscape(pathId)}"]`);
  if (!path) return svgString;
  path.setAttribute('stroke-width', fmtN(newWidthMm * 1000));
  return new XMLSerializer().serializeToString(doc);
}

export function editHoleDiameter(svgString: string, defId: string, newDiameterMm: number): string {
  return editPadSize(svgString, defId, newDiameterMm);
}

export function matchPadsToHoles(layers: LayerEntry[]): PadHoleMatch[] {
  return analyzePadHoleMatches(layers).matches;
}

export function analyzePadHoleMatches(
  layers: LayerEntry[],
  rules: ValidationRuleSet = DEFAULT_VALIDATION_RULES,
): PadHoleAnalysis {
  const allHoles = layers
    .filter((l) => l.layerType === 'drill')
    .flatMap((l) => l.geometry?.holeInstances ?? []);
  const allPads = layers
    .filter((l) => l.layerType === 'top-copper' || l.layerType === 'bottom-copper')
    .flatMap((l) => l.geometry?.padInstances ?? []);

  const matches: PadHoleMatch[] = [];
  const matchedPadIds = new Set<string>();
  const matchedHoleIds = new Set<string>();

  for (const hole of allHoles) {
    const candidates: PadHoleMatch[] = [];
    for (const pad of allPads) {
      const distanceMm = Math.hypot(pad.xMm - hole.xMm, pad.yMm - hole.yMm);
      if (distanceMm > rules.matchToleranceMm) continue;

      const diameter = padDiameterMm(pad, layers);
      const annularRingMm = diameter == null ? null : (diameter - hole.diameterMm) / 2;
      candidates.push({
        pad,
        hole,
        distanceMm,
        annularRingMm,
        status:
          annularRingMm != null && annularRingMm < rules.minAnnularRingMm
            ? 'diameter-warning'
            : 'matched',
      });
    }

    for (const candidate of candidates) {
      const match = candidates.length > 1 ? { ...candidate, status: 'ambiguous' as const } : candidate;
      matches.push(match);
      matchedPadIds.add(candidate.pad.instanceId);
      matchedHoleIds.add(candidate.hole.instanceId);
    }
  }

  return {
    matches,
    ambiguousMatches: matches.filter((m) => m.status === 'ambiguous'),
    unmatchedPads: allPads.filter((pad) => !matchedPadIds.has(pad.instanceId)),
    unmatchedHoles: allHoles.filter((hole) => !matchedHoleIds.has(hole.instanceId)),
    annularWarnings: matches.filter((m) => m.annularRingMm != null && m.annularRingMm < rules.minAnnularRingMm),
  };
}

function padDiameterMm(pad: PadInstance, layers: LayerEntry[]): number | null {
  const layer = layers.find((l) => l.id === pad.layerId);
  const def = layer?.geometry?.padDefs.find((d) => d.defId === pad.defId);
  if (!def) return null;
  if (def.diameterMm != null) return def.diameterMm;
  if (def.widthMm != null || def.heightMm != null) return Math.max(def.widthMm ?? 0, def.heightMm ?? 0);
  return null;
}

function fmtN(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/\.?0+$/, '');
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

export type { PadShape };
