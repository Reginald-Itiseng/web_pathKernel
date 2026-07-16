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

/** Raw SVG units per mm for a layer (gerber-to-svg emits native-unit x1000). */
function rawPerMm(units: string | null): number {
  return units === 'in' ? 1000 / 25.4 : 1000;
}

export function extractLayerGeometry(
  svgString: string,
  layerId: string,
  layerType: LayerType,
  units: string | null,
): LayerGeometry {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const scale = units === 'in' ? 25.4 : 1;

  const padDefs = extractPadDefs(doc, scale);
  const padInstances = extractPadInstances(doc, layerId, scale);
  const traceClasses = extractTraceClasses(doc, layerId, scale);
  const holeInstances: HoleInstance[] =
    layerType === 'drill'
      ? buildHoleInstances(padInstances, padDefs, layerId)
      : [];

  return { layerId, padDefs, padInstances, traceClasses, holeInstances };
}

function extractPadDefs(doc: Document, scale: number): PadDefinition[] {
  const defs = doc.querySelector('defs');
  if (!defs) return [];

  return Array.from(defs.children)
    .map((child) => {
      const id = child.getAttribute('id') ?? '';
      if (id.includes('_mask-')) return null;
      const markerIndex = id.indexOf('_pad-');
      if (markerIndex < 0) return null;
      return parsePadDef(child, id, id.slice(markerIndex + '_pad-'.length), scale);
    })
    .filter((def): def is PadDefinition => def != null);
}

function parsePadDef(el: Element, defId: string, toolCode: string, scale: number): PadDefinition {
  const base: Pick<PadDefinition, 'defId' | 'toolCode'> = { defId, toolCode };
  const nullDims = { diameterMm: null, widthMm: null, heightMm: null, ringStrokeWidthMm: null };
  const tag = el.tagName.toLowerCase();
  // Raw SVG values are native-units x1000; scale converts inch layers to mm.
  const toMm = (raw: number) => (raw / 1000) * scale;

  if (tag === 'circle') {
    const r = parseFloat(el.getAttribute('r') ?? '0');
    const sw = el.getAttribute('stroke-width');
    if (sw != null) {
      return {
        ...base,
        ...nullDims,
        shape: 'ring',
        diameterMm: toMm(r * 2),
        ringStrokeWidthMm: toMm(parseFloat(sw)),
      };
    }
    return { ...base, ...nullDims, shape: 'circle', diameterMm: toMm(r * 2) };
  }

  if (tag === 'rect') {
    const w = parseFloat(el.getAttribute('width') ?? '0');
    const h = parseFloat(el.getAttribute('height') ?? '0');
    return { ...base, ...nullDims, shape: 'rect', widthMm: toMm(w), heightMm: toMm(h) };
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

function extractTraceClasses(doc: Document, layerId: string, scale: number): TraceClass[] {
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
        widthMm: (raw / 1000) * scale,
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
    // Split the tool's mega-path into stroke subpaths, then regroup the
    // subpaths that touch — one <path> per CONNECTED trace, so clicking
    // selects the whole trace rather than a single drawn segment.
    const loops = groupConnectedLoops(splitPathLoops(path.getAttribute('d') ?? ''));
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
  // In SVG path data 'M'/'m' can only ever be a moveto command (letters never
  // appear inside numbers), so every occurrence starts a new subpath. The old
  // detector required the M to follow another command letter, which never
  // happens in gerber-to-svg output ("...L4667 40233M5100...") — so paths were
  // never split and one <path> held ALL traces of a tool as a single unit.
  const starts: number[] = [];
  for (let i = 0; i < pathData.length; i++) {
    const ch = pathData[i];
    if (ch === 'M' || ch === 'm') starts.push(i);
  }

  if (starts.length <= 1) return pathData.trim() ? [pathData.trim()] : [];
  return starts
    .map((start, i) => pathData.slice(start, starts[i + 1]).trim())
    .filter(Boolean);
}

/**
 * Group stroke subpaths into connected traces: subpaths sharing any vertex
 * belong to the same electrical trace (contiguous runs, T-junctions,
 * reversed segments). Each group's path data is concatenated so one <path>
 * element represents one whole trace.
 */
function groupConnectedLoops(loops: string[]): string[] {
  if (loops.length <= 1) return loops;

  const parent = Array.from({ length: loops.length }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  // Gerber coordinates are exact integers in gerber-to-svg output, so exact
  // vertex keys suffice for connectivity.
  const vertexOwner = new Map<string, number>();
  loops.forEach((loop, idx) => {
    for (const key of pathVertexKeys(loop)) {
      const owner = vertexOwner.get(key);
      if (owner == null) vertexOwner.set(key, idx);
      else union(owner, idx);
    }
  });

  const grouped = new Map<number, string[]>();
  loops.forEach((loop, idx) => {
    const root = find(idx);
    const list = grouped.get(root);
    if (list) list.push(loop);
    else grouped.set(root, [loop]);
  });
  return [...grouped.values()].map((parts) => parts.join(''));
}

/** All vertex coordinate keys of a path (absolute M/L/H/V, raw units). */
function pathVertexKeys(d: string): string[] {
  const tokens = d.match(/[MmLlHhVvZz]|[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const keys: string[] = [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;

  while (i < tokens.length) {
    if (/^[a-z]$/i.test(tokens[i])) cmd = tokens[i++];
    if (!cmd) break;
    if (cmd === 'M' || cmd === 'L') {
      x = Number(tokens[i++]);
      y = Number(tokens[i++]);
      keys.push(`${x},${y}`);
    } else if (cmd === 'm' || cmd === 'l') {
      x += Number(tokens[i++]);
      y += Number(tokens[i++]);
      keys.push(`${x},${y}`);
    } else if (cmd === 'H') {
      x = Number(tokens[i++]);
      keys.push(`${x},${y}`);
    } else if (cmd === 'V') {
      y = Number(tokens[i++]);
      keys.push(`${x},${y}`);
    } else {
      i++;
    }
  }
  return keys;
}

/** Apply a new size to a pad def element (circle or rect). */
function resizePadElement(el: Element, newDiameterMm: number, units: string | null): boolean {
  const tag = el.tagName.toLowerCase();
  const newRawDiameter = newDiameterMm * rawPerMm(units);

  if (tag === 'circle') {
    el.setAttribute('r', fmtN(newRawDiameter / 2));
    return true;
  }
  if (tag === 'rect') {
    const oldW = parseFloat(el.getAttribute('width') ?? '0');
    const oldH = parseFloat(el.getAttribute('height') ?? '0');
    const oldMax = Math.max(oldW, oldH);
    if (oldMax <= 0) return false;
    const scaleFactor = newRawDiameter / oldMax;
    const newW = oldW * scaleFactor;
    const newH = oldH * scaleFactor;
    el.setAttribute('width', fmtN(newW));
    el.setAttribute('height', fmtN(newH));
    el.setAttribute('x', fmtN(-newW / 2));
    el.setAttribute('y', fmtN(-newH / 2));
    return true;
  }
  return false;
}

export function editPadSize(
  svgString: string,
  defId: string,
  newDiameterMm: number,
  units: string | null,
): string {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const el = doc.getElementById(defId);
  if (!el || !resizePadElement(el, newDiameterMm, units)) return svgString;
  return new XMLSerializer().serializeToString(doc);
}

/**
 * Resize ONE placed pad only: clone its def with the new size and repoint just
 * that instance's <use> at the clone. Other pads sharing the def are untouched.
 */
export function editSinglePadSize(
  svgString: string,
  defId: string,
  padInstanceId: string,
  newDiameterMm: number,
  units: string | null,
): string {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const def = doc.getElementById(defId);
  const use = doc.querySelector(`[data-pad-instance-id="${cssEscape(padInstanceId)}"]`);
  if (!def || !use) return svgString;

  // Unique clone id that keeps the "_pad-" marker so extraction still sees it.
  let n = 0;
  let cloneId = `${defId}-s${n}`;
  while (doc.getElementById(cloneId)) cloneId = `${defId}-s${++n}`;

  const clone = def.cloneNode(true) as Element;
  clone.setAttribute('id', cloneId);
  if (!resizePadElement(clone, newDiameterMm, units)) return svgString;
  def.parentNode?.insertBefore(clone, def.nextSibling);

  if (use.hasAttribute('xlink:href')) use.setAttribute('xlink:href', `#${cloneId}`);
  if (use.hasAttribute('href')) use.setAttribute('href', `#${cloneId}`);
  return new XMLSerializer().serializeToString(doc);
}

export function editTraceWidth(
  svgString: string,
  oldStrokeWidthRaw: number,
  newWidthMm: number,
  units: string | null,
): string {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const newRaw = fmtN(newWidthMm * rawPerMm(units));
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

export function editSingleTraceWidth(
  svgString: string,
  pathId: string,
  newWidthMm: number,
  units: string | null,
): string {
  const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const path = doc.querySelector(`path[data-path-id="${cssEscape(pathId)}"]`);
  if (!path) return svgString;
  path.setAttribute('stroke-width', fmtN(newWidthMm * rawPerMm(units)));
  return new XMLSerializer().serializeToString(doc);
}

export function editHoleDiameter(
  svgString: string,
  defId: string,
  newDiameterMm: number,
  units: string | null,
): string {
  return editPadSize(svgString, defId, newDiameterMm, units);
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
