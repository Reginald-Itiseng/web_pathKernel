import React, { Suspense, lazy, useState } from 'react';
import { prepareSvgForDisplay, type ParseResult } from '../utils/gerberUtils';

const BoardViewport3D = lazy(() =>
  import('./BoardViewport3D').then((m) => ({ default: m.BoardViewport3D })),
);

interface Props {
  result: ParseResult;
  onClear: () => void;
}

type Tab = '2d' | '3d';

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

export function GerberPreview({ result, onClear }: Props) {
  const [tab, setTab] = useState<Tab>('2d');
  const [zoom, setZoom] = useState(1);

  const zoomIn = () => setZoom((z) => Math.min(z * ZOOM_STEP, MAX_ZOOM));
  const zoomOut = () => setZoom((z) => Math.max(z / ZOOM_STEP, MIN_ZOOM));
  const fitScreen = () => setZoom(1);

  const preparedSvg = prepareSvgForDisplay(result.svgString);
  const has3d = result.width != null && result.height != null;

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="shrink-0 flex items-center gap-1 mb-3">
        <TabButton active={tab === '2d'} onClick={() => setTab('2d')}>
          2D Preview
        </TabButton>
        <TabButton active={tab === '3d'} onClick={() => setTab('3d')} disabled={!has3d}>
          3D View{!has3d && <span className="ml-1 text-zinc-600 text-xs">(no dims)</span>}
        </TabButton>
      </div>

      {/* Canvas area */}
      <div className="relative flex-1 overflow-hidden preview-grid rounded-xl">
        {/* 2D panel */}
        {tab === '2d' && (
          <>
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  transform: `scale(${zoom})`,
                  transformOrigin: 'center center',
                  transition: 'transform 0.12s ease',
                }}
                className="gerber-svg-wrapper"
                dangerouslySetInnerHTML={{ __html: preparedSvg }}
              />
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

        {/* 3D panel — lazy loaded so Three.js doesn't block initial render */}
        {tab === '3d' && has3d && (
          <div className="absolute inset-0">
            <Suspense fallback={
              <div className="flex items-center justify-center h-full gap-3 text-zinc-500 text-sm">
                <div className="w-5 h-5 rounded-full border-2 border-zinc-500 border-t-transparent animate-spin" />
                Loading 3D…
              </div>
            }>
              <BoardViewport3D
                boardWidth={result.width!}
                boardHeight={result.height!}
              />
            </Suspense>
          </div>
        )}

        {/* 3D hint label */}
        {tab === '3d' && (
          <div className="absolute bottom-3 left-3 text-xs text-zinc-500 bg-zinc-900/80 rounded px-2 py-1 pointer-events-none">
            Orbit · Scroll to zoom · Right-drag to pan
          </div>
        )}
      </div>

      {/* Dimensions + clear row */}
      <div className="mt-3 flex items-center justify-between gap-4">
        <DimensionBadges result={result} />
        <button
          onClick={onClear}
          className="shrink-0 px-4 py-2 text-sm text-zinc-300 hover:text-zinc-100 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-colors"
        >
          Clear / Load new file
        </button>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  disabled,
  children,
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

function DimensionBadges({ result }: { result: ParseResult }) {
  const { width, height, units, defsCount, layerCount } = result;
  const hasSize = width != null && height != null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasSize && (
        <span className="px-3 py-1 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-mono">
          {width!.toFixed(2)} × {height!.toFixed(2)} {units ?? 'mm'}
        </span>
      )}
      {defsCount > 0 && (
        <span className="px-3 py-1 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-400 text-xs">
          {defsCount} pad{defsCount !== 1 ? 's' : ''}
        </span>
      )}
      {layerCount > 0 && (
        <span className="px-3 py-1 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-400 text-xs">
          {layerCount} element{layerCount !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
}

function ZoomButton({
  onClick,
  title,
  disabled,
  children,
}: {
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
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3 8h10" />
    </svg>
  );
}

function FitIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 5V2h3M12 2h3v3M15 11v3h-3M4 14H1v-3" />
    </svg>
  );
}
