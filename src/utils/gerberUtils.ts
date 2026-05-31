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

export function parseGerber(content: string, color: string): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];

    const converter = gerberToSvg(content, {
      id: `board-${Math.random().toString(36).slice(2, 8)}`,
      // color is a CSS property on the <svg> element; fills use currentColor
      attributes: { color },
    });

    converter.on('data', (chunk) => {
      chunks.push(String(chunk));
    });

    converter.on('end', () => {
      resolve({
        svgString: chunks.join(''),
        width: converter.width ?? null,
        height: converter.height ?? null,
        units: converter.units || null,
        viewBox: converter.viewBox ?? null,
        defsCount: converter.defs?.length ?? 0,
        layerCount: converter.layer?.length ?? 0,
      });
    });

    converter.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Computes the union bounding box across all provided viewBoxes.
 * All gerber-to-svg viewBoxes share the same board coordinate space, so
 * this gives a viewBox that fits every layer at once.
 */
export function computeUnionViewBox(
  results: ParseResult[],
): [number, number, number, number] | null {
  const boxes = results
    .map((r) => r.viewBox)
    .filter((v): v is number[] => v != null && v.length === 4);

  if (boxes.length === 0) return null;

  const xMin = Math.min(...boxes.map((b) => b[0]));
  const yMin = Math.min(...boxes.map((b) => b[1]));
  const xMax = Math.max(...boxes.map((b) => b[0] + b[2]));
  const yMax = Math.max(...boxes.map((b) => b[1] + b[3]));

  return [xMin, yMin, xMax - xMin, yMax - yMin];
}

/**
 * Overrides viewBox, width and height on the root <svg> so multiple layers
 * can be stacked in the same coordinate space.
 */
export function prepareSvgWithViewBox(
  svgString: string,
  viewBox: [number, number, number, number],
): string {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg.tagName.toLowerCase() === 'svg') {
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.setAttribute('viewBox', viewBox.join(' '));
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }
    return new XMLSerializer().serializeToString(doc);
  } catch {
    return svgString;
  }
}

/** Falls back to the SVG's own viewBox when no union is available (single layer). */
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
