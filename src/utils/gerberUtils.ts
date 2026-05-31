import gerberToSvg from 'gerber-to-svg';
import type { LayerType } from './layerUtils';

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
      // color is a CSS property on the <svg> element; fills use currentColor
      attributes: { color },
      filetype,
      // Default backup to mm — most modern PCBs are metric and older Excellon
      // files often omit the METRIC/INCH header, which would otherwise default to 'in'
      backupUnits: 'mm',
    });

    converter.on('data', (chunk) => {
      chunks.push(String(chunk));
    });

    converter.on('end', () => {
      const result: ParseResult = {
        svgString: chunks.join(''),
        width: converter.width ?? null,
        height: converter.height ?? null,
        units: converter.units || null,
        viewBox: converter.viewBox ?? null,
        defsCount: converter.defs?.length ?? 0,
        layerCount: converter.layer?.length ?? 0,
      };
      // Debug: log each layer's parsed extent so unit mismatches are visible
      console.debug(
        `[gerber] ${filetype} parsed: units=${result.units} ` +
        `viewBox=${JSON.stringify(result.viewBox)} ` +
        `size=${result.width}×${result.height}`,
      );
      resolve(result);
    });

    converter.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Computes the union bounding box in mm-equivalent space.
 * Inch-based layers are scaled ×25.4 so the result is always in mm×1000 units.
 */
export function computeUnionViewBox(
  results: ParseResult[],
): [number, number, number, number] | null {
  const boxes = results
    .filter((r) => r.viewBox != null && r.viewBox.length === 4)
    .map((r) => {
      const scale = r.units === 'in' ? 25.4 : 1;
      const [x, y, w, h] = r.viewBox!;
      return [x * scale, y * scale, w * scale, h * scale];
    });

  if (boxes.length === 0) return null;

  const xMin = Math.min(...boxes.map((b) => b[0]));
  const yMin = Math.min(...boxes.map((b) => b[1]));
  const xMax = Math.max(...boxes.map((b) => b[0] + b[2]));
  const yMax = Math.max(...boxes.map((b) => b[1] + b[3]));

  return [xMin, yMin, xMax - xMin, yMax - yMin];
}

/**
 * Builds a single composite SVG from multiple layers.
 *
 * Each layer is embedded as a nested <svg> with its NATURAL viewBox so the
 * baked-in Y-flip transform (translate(0, viewBox[3]+2*viewBox[1]) scale(1,-1))
 * stays correct. The outer SVG uses the union viewBox (always in mm×1000).
 *
 * Inch-based layers have their viewport (x/y/width/height) scaled ×25.4 so they
 * map into the same mm coordinate space as the other layers.
 */
export function buildCompositeSvg(
  layers: Array<Pick<LayerEntry, 'id' | 'result' | 'color'>>,
  unionViewBox: [number, number, number, number],
): string {
  const [uvX, uvY, uvW, uvH] = unionViewBox;
  const domParser = new DOMParser();

  const nestedSvgs = layers.map(({ result, color }) => {
    const naturalVb = result.viewBox ?? unionViewBox;
    const [nvX, nvY, nvW, nvH] = naturalVb;

    // Scale viewport to mm coordinate space if this layer was parsed in inches
    const scale = result.units === 'in' ? 25.4 : 1;
    const vx = nvX * scale;
    const vy = nvY * scale;
    const vw = nvW * scale;
    const vh = nvH * scale;

    // Extract the inner XML of the layer SVG (defs + layer group).
    // The original outer <svg> had the `color` attribute on it; we carry that
    // forward onto the nested <svg> so currentColor resolves correctly per layer.
    const doc = domParser.parseFromString(result.svgString, 'image/svg+xml');
    const inner = Array.from(doc.documentElement.childNodes)
      .map((n) => new XMLSerializer().serializeToString(n))
      .join('');

    return (
      `<svg x="${vx}" y="${vy}" width="${vw}" height="${vh}" ` +
      `viewBox="${nvX} ${nvY} ${nvW} ${nvH}" overflow="visible" color="${color}">` +
      inner +
      `</svg>`
    );
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="100%" height="100%" ` +
    `viewBox="${uvX} ${uvY} ${uvW} ${uvH}" ` +
    `preserveAspectRatio="xMidYMid meet" ` +
    `stroke-linecap="round" stroke-linejoin="round" stroke-width="0" fill-rule="evenodd">` +
    nestedSvgs.join('') +
    `</svg>`
  );
}

/** Single-layer display — just make the SVG fill its container. */
export function prepareSvgForDisplay(svgString: string): string {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, 'image/svg+xml');
    const svg = doc.documentElement;
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
