import gerberToSvg from 'gerber-to-svg';
import type { LayerType } from './layerUtils';
import type { LayerGeometry } from '../types/geometry';

export interface ParseResult {
  svgString: string;
  width: number | null;
  height: number | null;
  units: string | null;
  viewBox: number[] | null;
  defsCount: number;
  layerCount: number;
}

export interface LayerEntry {
  id: string;
  file: File;
  result: ParseResult;
  layerType: LayerType;
  color: string;
  visible: boolean;
  /** Populated after parsing via extractLayerGeometry; undefined until then. */
  geometry?: LayerGeometry;
}

export function parseGerber(
  content: string,
  color: string,
  filetype: 'gerber' | 'drill' = 'gerber',
): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];

    const converter = gerberToSvg(content, {
      id: `board-${Math.random().toString(36).slice(2, 8)}`,
      attributes: { color },
      filetype,
      // Default backup to mm — most modern PCBs are metric and older Excellon
      // files often omit the METRIC/INCH header, which would otherwise default to 'in'
      backupUnits: 'mm',
    });

    converter.on('data', (chunk) => chunks.push(String(chunk)));

    converter.on('end', () => {
      const result: ParseResult = {
        svgString: chunks.join(''),
        width:     converter.width  ?? null,
        height:    converter.height ?? null,
        units:     converter.units  || null,
        viewBox:   converter.viewBox ?? null,
        defsCount: converter.defs?.length  ?? 0,
        layerCount: converter.layer?.length ?? 0,
      };
      console.debug(
        `[gerber] ${filetype} parsed: units=${result.units} ` +
        `viewBox=${JSON.stringify(result.viewBox)} ` +
        `size=${result.width}×${result.height}`,
      );
      resolve(result);
    });

    converter.on('error', reject);
  });
}

/**
 * Computes the union bounding box in mm×1000 space.
 *
 * Inch-based layers are scaled ×25.4 before the union is taken so that
 * every layer contributes to the same coordinate space regardless of the
 * units the parser reported.
 *
 * Layers with a severely different scale (>10× the median) are excluded
 * from the union — this catches drill files whose coordinate format was
 * guessed wrong so that one bad layer doesn't blow out the union and
 * break all other layers.
 */
export function computeUnionViewBox(
  results: ParseResult[],
): [number, number, number, number] | null {
  const valid = results.filter((r) => r.viewBox != null && r.viewBox.length === 4);
  if (valid.length === 0) return null;

  const normalised = valid.map((r) => {
    const s = r.units === 'in' ? 25.4 : 1;
    const [x, y, w, h] = r.viewBox!;
    return { x: x * s, y: y * s, w: w * s, h: h * s, diag: Math.sqrt(w * w + h * h) * s };
  });

  const diags   = [...normalised].map((b) => b.diag).sort((a, b) => a - b);
  const median  = diags[Math.floor(diags.length / 2)];
  const inBound = normalised.filter((b) => b.diag > median / 10 && b.diag < median * 10);
  const boxes   = inBound.length > 0 ? inBound : normalised;

  const xMin = Math.min(...boxes.map((b) => b.x));
  const yMin = Math.min(...boxes.map((b) => b.y));
  const xMax = Math.max(...boxes.map((b) => b.x + b.w));
  const yMax = Math.max(...boxes.map((b) => b.y + b.h));

  return [xMin, yMin, xMax - xMin, yMax - yMin];
}

/**
 * Builds a single composite SVG from multiple layers.
 *
 * Each layer is a nested <svg> with its NATURAL viewBox so the baked-in
 * Y-flip transform (translate(0, vbH + 2·vbY) scale(1,-1)) stays valid.
 *
 * Inch-based layers have their viewport (x/y/width/height) scaled ×25.4
 * so they land in the same mm coordinate space as the other layers.
 * The colour attribute is copied onto each nested <svg> so currentColor
 * resolves per-layer.
 */
export function buildCompositeSvg(
  layers: Array<Pick<LayerEntry, 'id' | 'result' | 'color'>>,
  unionViewBox: [number, number, number, number],
): string {
  const [uvX, uvY, uvW, uvH] = unionViewBox;
  const domParser  = new DOMParser();
  const serializer = new XMLSerializer();
  const unionYTranslate = uvH + 2 * uvY;

  const nestedSvgs = layers.map(({ id, result, color }) => {
    const naturalVb = result.viewBox ?? unionViewBox;
    const [nvX, nvY, nvW, nvH] = naturalVb;

    const scale = result.units === 'in' ? 25.4 : 1;
    const layerYTranslate = unionYTranslate / scale;
    const vx = nvX * scale;
    const vy = nvY * scale;
    const vw = nvW * scale;
    const vh = nvH * scale;

    const doc = domParser.parseFromString(result.svgString, 'image/svg+xml');
    normaliseLayerYFlip(doc, layerYTranslate);

    const inner = Array.from(doc.documentElement.childNodes)
      .map((n) => serializer.serializeToString(n))
      .join('');

    return (
      `<svg x="${vx}" y="${vy}" width="${vw}" height="${vh}" ` +
      `viewBox="${nvX} ${nvY} ${nvW} ${nvH}" overflow="visible" color="${color}" data-layer-id="${id}">` +
      inner +
      `</svg>`
    );
  });

  // Origin marker — Gerber (0,0) sits at SVG y = uvH + 2·uvY
  const y0  = unionYTranslate;
  const arm = Math.max(uvW, uvH) * 0.05;
  const sw  = Math.max(arm * 0.08, 50);
  const dot = arm * 0.12;
  const fs  = arm * 0.55;

  const originMarker =
    `<g id="gerber-origin" stroke-linecap="round" fill-rule="nonzero">` +
      `<line x1="0" y1="${y0}" x2="${arm}" y2="${y0}" stroke="#f87171" stroke-width="${sw}"/>` +
      `<line x1="0" y1="${y0}" x2="0" y2="${y0 - arm}" stroke="#4ade80" stroke-width="${sw}"/>` +
      `<circle cx="0" cy="${y0}" r="${dot}" fill="white"/>` +
      `<text x="${dot * 1.8}" y="${y0 - dot * 1.8}" fill="#94a3b8" ` +
        `font-size="${fs}" font-family="monospace" stroke="none">(0,0)</text>` +
    `</g>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="100%" height="100%" ` +
    `viewBox="${uvX} ${uvY} ${uvW} ${uvH}" ` +
    `preserveAspectRatio="xMidYMid meet" overflow="visible" ` +
    `stroke-linecap="round" stroke-linejoin="round" stroke-width="0" fill-rule="evenodd">` +
    nestedSvgs.join('') +
    originMarker +
    `</svg>`
  );
}

/** Align each layer's baked Y-flip to the composite board-space viewBox. */
function normaliseLayerYFlip(doc: Document, yTranslate: number): void {
  const groups = Array.from(doc.documentElement.getElementsByTagName('g'));
  const yFlipPattern = /translate\(\s*0\s*,\s*[-+0-9.eE]+\s*\)\s*scale\(\s*1\s*,\s*-1\s*\)/;
  const yFlip = `translate(0,${formatSvgNumber(yTranslate)}) scale(1,-1)`;

  const flippedGroup = groups.find((g) => yFlipPattern.test(g.getAttribute('transform') ?? ''));
  if (!flippedGroup) return;

  flippedGroup.setAttribute(
    'transform',
    (flippedGroup.getAttribute('transform') ?? '').replace(yFlipPattern, yFlip),
  );
}

export function formatSvgNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/\.?0+$/, '');
}

/** Single-layer display — make the SVG fill its container. */
export function prepareSvgForDisplay(svgString: string): string {
  try {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(svgString, 'image/svg+xml');
    const svg    = doc.documentElement;
    if (svg.tagName.toLowerCase() === 'svg') {
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }
    return new XMLSerializer().serializeToString(doc);
  } catch {
    return svgString;
  }
}
