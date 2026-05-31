import React, { Suspense, lazy, useState, useCallback } from 'react';
import {
  computeUnionViewBox,
  prepareSvgWithViewBox,
  prepareSvgForDisplay,
  type LayerEntry,
} from '../utils/gerberUtils';
import { LAYER_Z_ORDER } from '../utils/layerUtils';

const BoardViewport3D = lazy(() =>
  import('./BoardViewport3D').then((m) => ({ default: m.BoardViewport3D })),
);

interface Props {
  layers: LayerEntry[];
  onAddFiles: (files: File[]) => void;
}

type Tab = '2d' | '3d';

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

export function GerberPreview({ layers, onAddFiles }: Props) {
  const [tab, setTab] = useState<Tab>('2d');
  const [zoom, setZoom] = useState(1);
  const [dropOver, setDropOver] = useState(false);

  const zoomIn = () => setZoom((z) => Math.min(z * ZOOM_STEP, MAX_ZOOM));
  const zoomOut = () => setZoom((z) => Math.max(z / ZOOM_STEP, MIN_ZOOM));
  const fitScreen = () => setZoom(1);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDropOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length) onAddFiles(files);
    },
    [onAddFiles],
  );

  const visibleLayers = [...layers]
    .filter((l) => l.visible)
    .sort((a, b) => LAYER_Z_ORDER[a.layerType] - LAYER_Z_ORDER[b.layerType]);

  const unionViewBox = computeUnionViewBox(visibleLayers.map((l) => l.result));

  const preparedLayers = visibleLayers.map((layer) => ({
    id: layer.id,
    html: unionViewBox
      ? prepareSvgWithViewBox(layer.result.svgString, unionViewBox)
      : prepareSvgForDisplay(layer.result.svgString),
  }));

  const firstUnits = layers.find((l) => l.result.units)?.result.units ?? 'mm';
  const boardW = unionViewBox ? (unionViewBox[2] / 1000) : null;
  const boardH = unionViewBox ? (unionViewBox[3] / 1000) : null;
  const has3d = boardW != null && boardH != null;

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="shrink-0 flex items-center gap-1 mb-3">
        <TabButton active={tab === '2d'} onClick={() => setTab('2d')}>
          2D Preview
        </TabButton>
        <TabButton active={tab === '3d'} onClick={() => setTab('3d')} disabled={!has3d}>
          3D View
        </TabButton>
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
        {/* Drop-to-add overlay */}
        {dropOver && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-green-400 bg-green-400/10 pointer-events-none">
            <p className="text-green-300 font-semibold text-lg">Drop to add layer</p>
          </div>
        )}

        {/* 2D composite */}
        {tab === '2d' && (
          <>
            <div
              className="absolute inset-0 p-4"
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: 'center center',
                transition: 'transform 0.12s ease',
              }}
            >
              {preparedLayers.map((layer) => (
                <div
                  key={layer.id}
                  className="absolute inset-0 gerber-svg-wrapper"
                  dangerouslySetInnerHTML={{ __html: layer.html }}
                />
              ))}
            </div>

            {/* Zoom controls */}
            <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-zinc-900/90 border border-zinc-700 rounded-lg p-1 backdrop-blur-sm">
              <ZoomButton onClick={zoomOut} title="Zoom out" disabled={zoom <= MIN_ZOOM}>
                <MinusIcon />
              </ZoomButton>
              <button
                onClick={fitScreen}
                title="Fit to screen"
                className="px-2 py-1 text-xs font-mono text-zinc-300 hover:text-zinc-100 hover:bg-zinc-700 rounded transition-colors min-w-[3.5rem] text-center"
              >
                {Math.round(zoom * 100)}%
              </button>
              <ZoomButton onClick={zoomIn} title="Zoom in" disabled={zoom >= MAX_ZOOM}>
                <PlusIcon />
              </ZoomButton>
              <div className="w-px h-4 bg-zinc-700 mx-0.5" />
              <ZoomButton onClick={fitScreen} title="Fit to screen">
                <FitIcon />
              </ZoomButton>
            </div>
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
              <BoardViewport3D boardWidth={boardW!} boardHeight={boardH!} />
            </Suspense>
          </div>
        )}

        {tab === '3d' && (
          <div className="absolute bottom-3 left-3 text-xs text-zinc-500 bg-zinc-900/80 rounded px-2 py-1 pointer-events-none">
            Orbit · Scroll to zoom · Right-drag to pan
          </div>
        )}

        {/* Drag-to-add hint */}
        {tab === '2d' && !dropOver && (
          <div className="absolute bottom-3 left-3 text-xs text-zinc-600 pointer-events-none">
            Drag more files here to add layers
          </div>
        )}
      </div>

      {/* Board dimensions row */}
      {boardW && boardH && (
        <div className="mt-2 flex items-center gap-2">
          <span className="px-3 py-1 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-mono">
            {boardW.toFixed(2)} × {boardH.toFixed(2)} {firstUnits}
          </span>
        </div>
      )}
    </div>
  );
}

function TabButton({
  active, onClick, disabled, children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        'px-4 py-1.5 text-sm rounded-lg transition-colors disabled:cursor-not-allowed',
        active
          ? 'bg-zinc-700 text-zinc-100'
          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-40',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function ZoomButton({ onClick, title, disabled, children }: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="p-1.5 rounded text-zinc-300 hover:text-zinc-100 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  );
}

function PlusIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>;
}
function MinusIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 8h10" /></svg>;
}
function FitIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 5V2h3M12 2h3v3M15 11v3h-3M4 14H1v-3" /></svg>;
}
