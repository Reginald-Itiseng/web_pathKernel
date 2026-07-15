/**
 * The single seam between the kernel and the polygon-clipping engine.
 *
 * Engine: js-angusj-clipper (Angus Johnson's Clipper 6.4.2 compiled to WASM,
 * with asm.js fallback). Chosen over clipper2-js@1.2.4 after acceptance
 * testing showed the latter produces corrupt offset geometry (see
 * __tests__/clip-acceptance.spec.ts for the behaviors we rely on).
 *
 * All public functions take and return mm-space KPoint rings; integer scaling
 * is internal. `initClipper()` must resolve before any other export is used.
 *
 * Shapely → clip.ts translation table (used by the Python ports):
 *   unary_union(polys)          → unionPolygons
 *   a.difference(b)             → differencePolygons
 *   a.intersection(b)           → intersectPolygons
 *   poly.buffer(±d, join).boundary → offsetPolygons(paths, ±d, join) — output
 *                                  rings ARE the boundary loops
 *   line.buffer(r)              → sweptOpenPaths(polylines, r)
 *   make_valid / buffer(0)      → unionPolygons (NonZero rebuild)
 *   a.intersects(b)             → polygonsIntersect
 */
import * as clipperLib from 'js-angusj-clipper';
import type { KPoint, JoinStyle, PolyWithHoles } from './types';

/** mm → integer scale. 1e5 = 10 nm resolution; 300 mm board → 3e7 < 2^53. */
export const SCALE = 1e5;
/** Max board extent we accept before scaling becomes unsafe (mm). */
const MAX_EXTENT_MM = 10_000;
/** Arc flattening tolerance for round joins, in integer units (0.005 mm). */
const ARC_TOLERANCE = 0.005 * SCALE;

type IntPoint = { x: number; y: number };

let instance: clipperLib.ClipperLibWrapper | null = null;
let loading: Promise<clipperLib.ClipperLibWrapper> | null = null;

export async function initClipper(): Promise<void> {
  if (instance) return;
  loading ??= clipperLib.loadNativeClipperLibInstanceAsync(
    clipperLib.NativeClipperLibRequestedFormat.WasmWithAsmJsFallback,
  );
  instance = await loading;
}

export function isClipperReady(): boolean {
  return instance != null;
}

function lib(): clipperLib.ClipperLibWrapper {
  if (!instance) {
    throw new Error('Clipper engine not initialized — call initClipper() first.');
  }
  return instance;
}

const JOIN_TYPE: Record<JoinStyle, clipperLib.JoinType> = {
  round: clipperLib.JoinType.Round,
  miter: clipperLib.JoinType.Miter,
  // Clipper1 has no bevel join; square is the closest analog.
  bevel: clipperLib.JoinType.Square,
};

function toIntPath(ring: KPoint[]): IntPoint[] {
  const out: IntPoint[] = [];
  for (const p of ring) {
    if (Math.abs(p.x) > MAX_EXTENT_MM || Math.abs(p.y) > MAX_EXTENT_MM) {
      throw new Error(`Coordinate out of range: ${p.x}, ${p.y} mm`);
    }
    const x = Math.round(p.x * SCALE);
    const y = Math.round(p.y * SCALE);
    const last = out[out.length - 1];
    if (!last || last.x !== x || last.y !== y) out.push({ x, y });
  }
  // Drop closing duplicate if the ring came pre-closed.
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first.x === last.x && first.y === last.y) out.pop();
  }
  return out;
}

function fromIntPath(path: readonly IntPoint[]): KPoint[] {
  return path.map((p) => ({ x: p.x / SCALE, y: p.y / SCALE }));
}

function toIntPaths(rings: KPoint[][], minVerts: number): IntPoint[][] {
  const out: IntPoint[][] = [];
  for (const ring of rings) {
    const converted = toIntPath(ring);
    if (converted.length >= minVerts) out.push(converted);
  }
  return out;
}

function fromIntPaths(paths: readonly (readonly IntPoint[])[] | undefined): KPoint[][] {
  if (!paths) return [];
  return paths.filter((p) => p.length >= 3).map(fromIntPath);
}

function clip(
  type: clipperLib.ClipType,
  subject: KPoint[][],
  clipPaths?: KPoint[][],
): KPoint[][] {
  const subjectData = toIntPaths(subject, 3);
  if (subjectData.length === 0) return [];
  const params: clipperLib.ClipParams = {
    clipType: type,
    subjectFillType: clipperLib.PolyFillType.NonZero,
    subjectInputs: [{ data: subjectData, closed: true }],
  };
  if (clipPaths) {
    const clipData = toIntPaths(clipPaths, 3);
    if (clipData.length > 0) {
      params.clipInputs = [{ data: clipData }];
    } else if (type !== clipperLib.ClipType.Union) {
      return fromIntPaths(
        lib().clipToPaths({
          clipType: clipperLib.ClipType.Union,
          subjectFillType: clipperLib.PolyFillType.NonZero,
          subjectInputs: [{ data: subjectData, closed: true }],
        }),
      );
    }
  }
  return fromIntPaths(lib().clipToPaths(params));
}

/** union of a set of closed rings under NonZero fill (shapely unary_union). */
export function unionPolygons(rings: KPoint[][]): KPoint[][] {
  return clip(clipperLib.ClipType.Union, rings);
}

/** subject − clip (shapely difference). */
export function differencePolygons(subject: KPoint[][], clipRings: KPoint[][]): KPoint[][] {
  if (clipRings.length === 0) return unionPolygons(subject);
  return clip(clipperLib.ClipType.Difference, subject, clipRings);
}

/** subject ∩ clip (shapely intersection). */
export function intersectPolygons(subject: KPoint[][], clipRings: KPoint[][]): KPoint[][] {
  if (subject.length === 0 || clipRings.length === 0) return [];
  return clip(clipperLib.ClipType.Intersection, subject, clipRings);
}

/** shapely a.intersects(b) for polygon sets. */
export function polygonsIntersect(a: KPoint[][], b: KPoint[][]): boolean {
  return intersectPolygons(a, b).length > 0;
}

/**
 * Offset a polygon set by ±delta mm (shapely buffer). The returned closed
 * rings are exactly the boundary loops of the offset area (outer rings and
 * hole rings), which is what isolation routing consumes.
 */
export function offsetPolygons(rings: KPoint[][], deltaMm: number, join: JoinStyle): KPoint[][] {
  const data = toIntPaths(rings, 3);
  if (data.length === 0) return [];
  const result = lib().offsetToPaths({
    delta: Math.round(deltaMm * SCALE),
    arcTolerance: ARC_TOLERANCE,
    offsetInputs: [
      {
        data,
        joinType: JOIN_TYPE[join],
        endType: clipperLib.EndType.ClosedPolygon,
      },
    ],
  });
  return fromIntPaths(result);
}

/**
 * Swept area of open polylines with a round tool of the given radius
 * (shapely LineString.buffer(radius)). Delta semantics verified: for open
 * paths this engine applies the delta on each side, i.e. delta = radius.
 */
export function sweptOpenPaths(polylines: KPoint[][], radiusMm: number): KPoint[][] {
  if (radiusMm <= 0) return [];
  const data: IntPoint[][] = [];
  for (const line of polylines) {
    const converted: IntPoint[] = [];
    for (const p of line) {
      const x = Math.round(p.x * SCALE);
      const y = Math.round(p.y * SCALE);
      const last = converted[converted.length - 1];
      if (!last || last.x !== x || last.y !== y) converted.push({ x, y });
    }
    if (converted.length >= 1) data.push(converted);
  }
  if (data.length === 0) return [];
  const result = lib().offsetToPaths({
    delta: Math.round(radiusMm * SCALE),
    arcTolerance: ARC_TOLERANCE,
    offsetInputs: [
      {
        data,
        joinType: clipperLib.JoinType.Round,
        endType: clipperLib.EndType.OpenRound,
      },
    ],
  });
  return fromIntPaths(result);
}

/**
 * Remove micro-vertices / near-collinear points (shapely simplify analog).
 * NOTE: Clipper's CleanPolygons is noticeably coarser than the distance
 * parameter suggests (deviation can reach a few x epsMm). Use for display
 * geometry (3D meshes) only — never for toolpath math.
 */
export function cleanPolygons(rings: KPoint[][], epsMm: number): KPoint[][] {
  const data = toIntPaths(rings, 3);
  if (data.length === 0) return [];
  const cleaned = lib().cleanPolygons(data, epsMm * SCALE);
  return fromIntPaths(cleaned);
}

/**
 * Clip OPEN polylines against polygons, keeping the parts OUTSIDE
 * (shapely `linework.difference(polygon)`). Open-path output requires
 * Clipper's PolyTree.
 */
export function clipOpenPathsOutside(lines: KPoint[][], clipRings: KPoint[][]): KPoint[][] {
  if (lines.length === 0) return [];
  const clipData = toIntPaths(clipRings, 3);
  if (clipData.length === 0) return lines;
  const subjectData: IntPoint[][] = [];
  for (const line of lines) {
    const converted: IntPoint[] = [];
    for (const p of line) {
      const x = Math.round(p.x * SCALE);
      const y = Math.round(p.y * SCALE);
      const last = converted[converted.length - 1];
      if (!last || last.x !== x || last.y !== y) converted.push({ x, y });
    }
    if (converted.length >= 2) subjectData.push(converted);
  }
  if (subjectData.length === 0) return [];
  const tree = lib().clipToPolyTree({
    clipType: clipperLib.ClipType.Difference,
    subjectFillType: clipperLib.PolyFillType.NonZero,
    subjectInputs: [{ data: subjectData, closed: false }],
    clipInputs: [{ data: clipData }],
  });
  const out: KPoint[][] = [];
  const visit = (node: clipperLib.PolyNode): void => {
    for (const child of node.childs) {
      if (child.isOpen && child.contour.length >= 2) out.push(fromIntPath(child.contour));
      visit(child);
    }
  };
  visit(tree);
  return out;
}

/**
 * Union a ring soup and return proper polygons with hole assignment, using
 * Clipper's PolyTree (outer nodes may contain hole children, which may in
 * turn contain nested outers).
 */
export function polysWithHoles(rings: KPoint[][]): PolyWithHoles[] {
  const data = toIntPaths(rings, 3);
  if (data.length === 0) return [];
  const tree = lib().clipToPolyTree({
    clipType: clipperLib.ClipType.Union,
    subjectFillType: clipperLib.PolyFillType.NonZero,
    subjectInputs: [{ data, closed: true }],
  });
  const out: PolyWithHoles[] = [];
  const visitOuter = (node: clipperLib.PolyNode): void => {
    const poly: PolyWithHoles = { outer: fromIntPath(node.contour), holes: [] };
    for (const child of node.childs) {
      if (child.contour.length >= 3) poly.holes.push(fromIntPath(child.contour));
      // Children of holes are nested outer polygons.
      for (const nested of child.childs) visitOuter(nested);
    }
    if (poly.outer.length >= 3) out.push(poly);
  };
  for (const top of tree.childs) visitOuter(top);
  return out;
}

/** Total signed area of a ring set in mm² (outers positive, holes negative). */
export function polygonSetArea(rings: KPoint[][]): number {
  let total = 0;
  for (const ring of rings) {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      sum += a.x * b.y - b.x * a.y;
    }
    total += sum / 2;
  }
  return total;
}
