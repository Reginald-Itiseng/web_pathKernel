import gerberToSvg from 'gerber-to-svg';

export interface ParseResult {
  svgString: string;
  width: number | null;
  height: number | null;
  units: string | null;
  viewBox: number[] | null;
  defsCount: number;
  layerCount: number;
}

export function parseGerber(content: string, color: string): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];

    const converter = gerberToSvg(content, {
      id: 'board-preview',
      // color is a CSS property — set it on the <svg> element so currentColor resolves correctly
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
 * Overrides width/height on the root <svg> so it fills its CSS container
 * while the viewBox keeps correct scaling and aspect ratio.
 */
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
