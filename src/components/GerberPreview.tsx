import React, { Suspense, lazy, useState, useCallback, useRef } from 'react';
import {
  computeUnionViewBox,
  buildCompositeSvg,
  prepareSvgForDisplay,
  type LayerEntry,
} from '../utils/gerberUtils';
import { LAYER_Z_ORDER } from '../utils/layerUtils';
import { SelectionPopup, type ElementSelection } from './SelectionPopup';
import type { GeometryHighlightTarget, PadHoleMatch } from '../types/geometry';

const BoardViewport3D = lazy(() =>
  import('./BoardViewport3D').then((m) => ({ default: m.BoardViewport3D })),
);

interface Props {
  layers: LayerEntry[];
  onAddFiles: (files: File[]) => void;
  padHoleMatches: PadHoleMatch[];
  onPadSizeChange:             (layerId: string, defId: string,   newDiameterMm: number) => void;
  onTraceWidthChange:          (layerId: string, oldRaw: number,  newWidthMm: number)    => void;
  onSingleTraceWidthChange:    (layerId: string, pathId: string,  newWidthMm: number)    => void;
  onHoleDiameterChange:        (layerId: string, defId: string,   newDiameterMm: number) => void;
  geometryHighlight: GeometryHighlightTarget | null;
}

type Tab = '2d' | '3d';

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

export function GerberPreview({
  layers, onAddFiles,
  padHoleMatches,
  onPadSizeChange, onTraceWidthChange, onSingleTraceWidthChange, onHoleDiameterChange,
  geometryHighlight,
}: Props) {
  const [tab, setTab]           = useState<Tab>('2d');
  const [zoom, setZoom]         = useState(1);
  const [dropOver, setDropOver] = useState(false);
  const [selection, setSelection] = useState<ElementSelection | null>(null);

  // Hover element tracked via ref — no re-render needed
  const hoveredElRef = useRef<Element | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelHighlightedElsRef = useRef<Element[]>([]);

  const zoomIn    = () => setZoom((z) => Math.min(z * ZOOM_STEP, MAX_ZOOM));
  const zoomOut   = () => setZoom((z) => Math.max(z / ZOOM_STEP, MIN_ZOOM));
  const fitScreen = () => setZoom(1);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDropOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onAddFiles(files);
  }, [onAddFiles]);

  // ── Hover highlighting ────────────────────────────────────────────────────
  // We mutate the SVG DOM directly (no React state) to keep it performant.
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const target = e.target as Element;
    if (target === e.currentTarget) {
      hoveredElRef.current?.removeAttribute('data-hovered');
      hoveredElRef.current = null;
      return;
    }

    const el: Element | null =
      (target.closest('use') as Element | null) ??
      (target.tagName.toLowerCase() === 'path' &&
       target.getAttribute('fill') === 'none'
        ? target
        : null);

    if (el === hoveredElRef.current) return;
    hoveredElRef.current?.removeAttribute('data-hovered');
    hoveredElRef.current = el;
    el?.setAttribute('data-hovered', 'true');
  }, []);

  const handleMouseLeave = useCallback(() => {
    hoveredElRef.current?.removeAttribute('data-hovered');
    hoveredElRef.current = null;
  }, []);

  const clearPanelHighlight = useCallback(() => {
    for (const el of panelHighlightedElsRef.current) {
      el.removeAttribute('data-panel-highlight');
    }
    panelHighlightedElsRef.current = [];
  }, []);

  const addPanelHighlight = useCallback((el: Element | null | undefined) => {
    if (!el || panelHighlightedElsRef.current.includes(el)) return;
    el.setAttribute('data-panel-highlight', 'true');
    panelHighlightedElsRef.current.push(el);
  }, []);

  const getLayerSvg = useCallback((layerId: string): SVGSVGElement | null => {
    const root = wrapperRef.current;
    if (!root) return null;
    return Array.from(root.querySelectorAll<SVGSVGElement>('svg[data-layer-id]'))
      .find((svg) => svg.getAttribute('data-layer-id') === layerId) ?? null;
  }, []);

  const highlightPadDef = useCallback((layerId: string, defId: string) => {
    const layerSvg = getLayerSvg(layerId);
    if (!layerSvg) return;
    for (const use of Array.from(layerSvg.querySelectorAll('use'))) {
      const href = use.getAttribute('xlink:href') ?? use.getAttribute('href') ?? '';
      if ((href.startsWith('#') ? href.slice(1) : href) === defId) {
        addPanelHighlight(use);
      }
    }
  }, [addPanelHighlight, getLayerSvg]);

  const highlightPadInstance = useCallback((layerId: string, defId: string, xMm: number, yMm: number) => {
    const layerSvg = getLayerSvg(layerId);
    const layer = layers.find((l) => l.id === layerId);
    if (!layerSvg || !layer) return;

    const scale = layer.result.units === 'in' ? 25.4 : 1;
    const toleranceMm = 0.001;
    for (const use of Array.from(layerSvg.querySelectorAll('use'))) {
      const href = use.getAttribute('xlink:href') ?? use.getAttribute('href') ?? '';
      const useDefId = href.startsWith('#') ? href.slice(1) : href;
      if (useDefId !== defId) continue;

      const useX = (parseFloat(use.getAttribute('x') ?? '0') / 1000) * scale;
      const useY = (parseFloat(use.getAttribute('y') ?? '0') / 1000) * scale;
      if (Math.abs(useX - xMm) <= toleranceMm && Math.abs(useY - yMm) <= toleranceMm) {
        addPanelHighlight(use);
      }
    }
  }, [addPanelHighlight, getLayerSvg, layers]);

  const highlightPadInstanceById = useCallback((layerId: string, instanceId: string) => {
    const layerSvg = getLayerSvg(layerId);
    if (!layerSvg) return;
    addPanelHighlight(layerSvg.querySelector(`[data-pad-instance-id="${cssEscape(instanceId)}"]`));
  }, [addPanelHighlight, getLayerSvg]);

  const highlightTraceWidth = useCallback((layerId: string, strokeWidthRaw: number) => {
    const layerSvg = getLayerSvg(layerId);
    if (!layerSvg) return;
    for (const path of Array.from(layerSvg.querySelectorAll('path[fill="none"]'))) {
      const raw = parseFloat(path.getAttribute('stroke-width') ?? '');
      if (Number.isFinite(raw) && Math.abs(raw - strokeWidthRaw) < 0.000001) {
        addPanelHighlight(path);
      }
    }
  }, [addPanelHighlight, getLayerSvg]);

  // ── Element selection on click ────────────────────────────────────────────
  const handleCompositeClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as Element;

    const layerSvg = target.closest('[data-layer-id]');
    const layerId  = layerSvg?.getAttribute('data-layer-id');
    if (!layerId) { setSelection(null); return; }

    const layer = layers.find((l) => l.id === layerId);
    if (!layer?.geometry) { setSelection(null); return; }

    // Pad / drill hole: <use xlink:href="#...pad-...">
    const useEl = (target.closest('use') as Element | null) ??
      (target.tagName.toLowerCase() === 'use' ? target : null);
    if (useEl) {
      const href  = useEl.getAttribute('xlink:href') ?? useEl.getAttribute('href') ?? '';
      const defId = href.startsWith('#') ? href.slice(1) : href;
      if (defId && layer.geometry.padDefs.some((d) => d.defId === defId)) {
        const scale = layer.result.units === 'in' ? 25.4 : 1;
        const xMm = (parseFloat(useEl.getAttribute('x') ?? '0') / 1000) * scale;
        const yMm = (parseFloat(useEl.getAttribute('y') ?? '0') / 1000) * scale;
        const instanceId = useEl.getAttribute('data-pad-instance-id') ?? undefined;
        setSelection({
          type: 'pad',
          layerId,
          defId,
          strokeWidthRaw: 0,
          pathId: undefined,
          instanceId,
          xMm,
          yMm,
          clientX: e.clientX,
          clientY: e.clientY,
        });
        return;
      }
    }

    // Trace: <path fill="none" stroke-width="...">
    const pathEl =
      (target.tagName.toLowerCase() === 'path' ? target : null) ??
      (target.closest('path') as Element | null);
    if (pathEl && pathEl.getAttribute('fill') === 'none') {
      const raw   = parseFloat(pathEl.getAttribute('stroke-width') ?? '0');
      const pathId = pathEl.getAttribute('data-path-id') ?? undefined;
      if (isFinite(raw) && raw > 0 && layer.geometry.traceClasses.some((t) => t.strokeWidthRaw === raw)) {
        setSelection({
          type: 'trace',
          layerId,
          defId: '',
          strokeWidthRaw: raw,
          pathId,
          instanceId: undefined,
          xMm: undefined,
          yMm: undefined,
          clientX: e.clientX,
          clientY: e.clientY,
        });
        return;
      }
    }

    setSelection(null);
  }, [layers]);

  // ─────────────────────────────────────────────────────────────────────────

  const visibleLayers = [...layers]
    .filter((l) => l.visible)
    .sort((a, b) => LAYER_Z_ORDER[a.layerType] - LAYER_Z_ORDER[b.layerType]);

  const unionViewBox = computeUnionViewBox(visibleLayers.map((l) => l.result));

  const compositeSvg = unionViewBox
    ? buildCompositeSvg(visibleLayers, unionViewBox)
    : visibleLayers.length === 1
      ? prepareSvgForDisplay(visibleLayers[0].result.svgString)
      : null;

  React.useEffect(() => {
    clearPanelHighlight();
    if (!geometryHighlight) return;

    if (geometryHighlight.type === 'trace-width') {
      highlightTraceWidth(geometryHighlight.layerId, geometryHighlight.strokeWidthRaw);
      return;
    }

    if (geometryHighlight.type === 'pad-instance') {
      highlightPadInstanceById(geometryHighlight.layerId, geometryHighlight.instanceId);
      for (const match of padHoleMatches) {
        if (match.pad.layerId === geometryHighlight.layerId && match.pad.instanceId === geometryHighlight.instanceId) {
          highlightPadInstanceById(match.hole.layerId, match.hole.instanceId.replace(':hole:', ':pad:'));
        }
        if (match.hole.layerId === geometryHighlight.layerId && match.hole.instanceId === geometryHighlight.instanceId.replace(':pad:', ':hole:')) {
          highlightPadInstanceById(match.pad.layerId, match.pad.instanceId);
        }
      }
      return;
    }

    highlightPadDef(geometryHighlight.layerId, geometryHighlight.defId);

    for (const match of padHoleMatches) {
      if (match.pad.layerId === geometryHighlight.layerId && match.pad.defId === geometryHighlight.defId) {
        highlightPadInstance(match.hole.layerId, match.hole.defId, match.hole.xMm, match.hole.yMm);
      }
      if (match.hole.layerId === geometryHighlight.layerId && match.hole.defId === geometryHighlight.defId) {
        highlightPadInstance(match.pad.layerId, match.pad.defId, match.pad.xMm, match.pad.yMm);
      }
    }
  }, [
    clearPanelHighlight,
    compositeSvg,
    geometryHighlight,
    highlightPadDef,
    highlightPadInstanceById,
    highlightPadInstance,
    highlightTraceWidth,
    padHoleMatches,
  ]);

  const firstUnits = layers.find((l) => l.result.units)?.result.units ?? 'mm';
  const boardXMin  = unionViewBox ? unionViewBox[0] / 1000 : null;
  const boardYMin  = unionViewBox ? unionViewBox[1] / 1000 : null;
  const boardW     = unionViewBox ? unionViewBox[2] / 1000 : null;
  const boardH     = unionViewBox ? unionViewBox[3] / 1000 : null;
  const has3d      = boardXMin != null && boardYMin != null && boardW != null && boardH != null;

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="shrink-0 flex items-center gap-1 mb-3">
        <TabButton active={tab === '2d'} onClick={() => setTab('2d')}>2D Preview</TabButton>
        <TabButton active={tab === '3d'} onClick={() => setTab('3d')} disabled={!has3d}>3D View</TabButton>
        <span className="ml-auto text-xs text-zinc-500">
          {visibleLayers.length} of {layers.length} layer{layers.length !== 1 ? 's' : ''} visible
        </span>
      </div>

      {/* Canvas */}
      <div
        className="relative flex-1 overflow-hidden preview-grid rounded-xl"
        onDragOver={(e) => { e.preventDefault(); setDropOver(true); }}
        onDragLeave={() => setDropOver(false)}
        onDrop={handleDrop}
      >
        {dropOver && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-green-400 bg-green-400/10 pointer-events-none">
            <p className="text-green-300 font-semibold text-lg">Drop to add layer</p>
          </div>
        )}

        {/* 2D composite */}
        {tab === '2d' && (
          <>
            <div
              ref={wrapperRef}
              className="absolute inset-0 p-4 gerber-svg-wrapper pcb-interactive"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center center', transition: 'transform 0.12s ease' }}
              dangerouslySetInnerHTML={{ __html: compositeSvg ?? '' }}
              onClick={handleCompositeClick}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
            />

            {/* Zoom controls */}
            <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-zinc-900/90 border border-zinc-700 rounded-lg p-1 backdrop-blur-sm">
              <ZoomButton onClick={zoomOut} title="Zoom out" disabled={zoom <= MIN_ZOOM}><MinusIcon /></ZoomButton>
              <button onClick={fitScreen} className="px-2 py-1 text-xs font-mono text-zinc-300 hover:text-zinc-100 hover:bg-zinc-700 rounded transition-colors min-w-[3.5rem] text-center">
                {Math.round(zoom * 100)}%
              </button>
              <ZoomButton onClick={zoomIn} title="Zoom in" disabled={zoom >= MAX_ZOOM}><PlusIcon /></ZoomButton>
              <div className="w-px h-4 bg-zinc-700 mx-0.5" />
              <ZoomButton onClick={fitScreen} title="Fit to screen"><FitIcon /></ZoomButton>
            </div>

            {!dropOver && !selection && (
              <div className="absolute bottom-3 left-3 text-xs text-zinc-600 pointer-events-none">
                Click a pad or trace to edit · Drag files to add layers
              </div>
            )}
          </>
        )}

        {/* 3D panel */}
        {tab === '3d' && has3d && (
          <div className="absolute inset-0">
            <Suspense fallback={
              <div className="flex items-center justify-center h-full gap-3 text-zinc-500 text-sm">
                <div className="w-5 h-5 rounded-full border-2 border-zinc-500 border-t-transparent animate-spin" />
                Loading 3D…
              </div>
            }>
              <BoardViewport3D
                boardXMin={boardXMin!} boardYMin={boardYMin!}
                boardWidth={boardW!}   boardHeight={boardH!}
              />
            </Suspense>
          </div>
        )}
        {tab === '3d' && (
          <div className="absolute bottom-3 left-3 text-xs text-zinc-500 bg-zinc-900/80 rounded px-2 py-1 pointer-events-none">
            Orbit · Scroll to zoom · Right-drag to pan
          </div>
        )}
      </div>

      {/* Board dimensions */}
      {boardW && boardH && (
        <div className="mt-2 flex items-center gap-2">
          <span className="px-3 py-1 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-mono">
            {boardW.toFixed(2)} × {boardH.toFixed(2)} {firstUnits}
          </span>
        </div>
      )}

      {/* Selection popup */}
      {selection && (
        <SelectionPopup
          selection={selection}
          layers={layers}
          padHoleMatches={padHoleMatches}
          onPadSizeChange={onPadSizeChange}
          onTraceWidthChange={onTraceWidthChange}
          onSingleTraceWidthChange={onSingleTraceWidthChange}
          onHoleDiameterChange={onHoleDiameterChange}
          onClose={() => setSelection(null)}
        />
      )}
    </div>
  );
}

// ─── Small components ─────────────────────────────────────────────────────────

function TabButton({ active, onClick, disabled, children }: { active: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={['px-4 py-1.5 text-sm rounded-lg transition-colors disabled:cursor-not-allowed',
        active ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-40'].join(' ')}>
      {children}
    </button>
  );
}
function ZoomButton({ onClick, title, disabled, children }: { onClick: () => void; title: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} disabled={disabled}
      className="p-1.5 rounded text-zinc-300 hover:text-zinc-100 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
      {children}
    </button>
  );
}
function PlusIcon()  { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10"/></svg>; }
function MinusIcon() { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 8h10"/></svg>; }
function FitIcon()   { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 5V2h3M12 2h3v3M15 11v3h-3M4 14H1v-3"/></svg>; }

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
