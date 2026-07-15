import React, { useRef, useState } from 'react';
import type { LayerEntry } from '../utils/gerberUtils';
import type {
  PadDefinition,
  GeometryHighlightTarget,
  TraceClass,
} from '../types/geometry';

interface Props {
  layer: LayerEntry;
  onPadSizeChange:      (layerId: string, defId: string, newDiameterMm: number) => void;
  onTraceWidthChange:   (layerId: string, oldRaw: number, newWidthMm: number) => void;
  onHoleDiameterChange: (layerId: string, defId: string, newDiameterMm: number) => void;
  onGeometryHighlight:  (target: GeometryHighlightTarget | null) => void;
}

export function GeometryPanel({
  layer,
  onPadSizeChange, onTraceWidthChange, onHoleDiameterChange,
  onGeometryHighlight,
}: Props) {
  const [open, setOpen] = useState(false);
  const geo = layer.geometry;
  const isCopper = layer.layerType === 'top-copper' || layer.layerType === 'bottom-copper';
  const isDrill  = layer.layerType === 'drill';
  const hasGeo   = isCopper || isDrill;

  if (!hasGeo) return null;

  return (
    <div className="rounded-lg overflow-hidden border border-zinc-800">
      {/* Header */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 bg-zinc-800/50 hover:bg-zinc-800 transition-colors text-left"
      >
        <span className="text-xs font-medium text-zinc-300">Inspect &amp; edit</span>
        <span className="text-xs text-zinc-500 flex items-center gap-1">
          {geo
            ? isCopper
              ? `${geo.padDefs.length} pad type${geo.padDefs.length !== 1 ? 's' : ''} · ${geo.traceClasses.length} trace width${geo.traceClasses.length !== 1 ? 's' : ''}`
              : `${geo.holeInstances.length} hole${geo.holeInstances.length !== 1 ? 's' : ''}`
            : '—'}
          <Chevron open={open} />
        </span>
      </button>

      {open && (
        <div className="px-3 py-2.5 flex flex-col gap-3 bg-zinc-900/60">
          {isCopper && geo && (
            <>
              <PadSection
                defs={geo.padDefs}
                layerId={layer.id}
                onApply={onPadSizeChange}
                onGeometryHighlight={onGeometryHighlight}
              />
              <TraceSection
                classes={geo.traceClasses}
                layerId={layer.id}
                onApply={onTraceWidthChange}
                onGeometryHighlight={onGeometryHighlight}
              />
            </>
          )}

          {isDrill && geo && (
            <DrillSection
              defs={geo.padDefs}
              holeCount={geo.holeInstances.length}
              layerId={layer.id}
              onApply={onHoleDiameterChange}
              onGeometryHighlight={onGeometryHighlight}
            />
          )}

          {!geo && (
            <p className="text-xs text-zinc-500 text-center py-1">No geometry extracted</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Pad types section ────────────────────────────────────────────────────────

function PadSection({ defs, layerId, onApply, onGeometryHighlight }: {
  defs: PadDefinition[];
  layerId: string;
  onApply: (layerId: string, defId: string, newDiameterMm: number) => void;
  onGeometryHighlight: (target: GeometryHighlightTarget | null) => void;
}) {
  if (defs.length === 0) return null;
  return (
    <div>
      <SectionLabel>Pad Types</SectionLabel>
      <div className="flex flex-col gap-1.5 mt-1">
        {defs.map((def) => (
          <PadRow
            key={def.defId}
            def={def}
            layerId={layerId}
            onApply={onApply}
            onGeometryHighlight={onGeometryHighlight}
          />
        ))}
      </div>
    </div>
  );
}

function PadRow({ def, layerId, onApply, onGeometryHighlight }: {
  def: PadDefinition;
  layerId: string;
  onApply: (layerId: string, defId: string, newDiameterMm: number) => void;
  onGeometryHighlight: (target: GeometryHighlightTarget | null) => void;
}) {
  const isEditable = def.shape === 'circle' || def.shape === 'ring' || def.shape === 'rect';
  const currentValue = def.diameterMm ?? (def.widthMm ? Math.max(def.widthMm, def.heightMm ?? 0) : null);

  return (
    <div
      className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-zinc-800/70"
      onMouseEnter={() => onGeometryHighlight({ type: 'pad-def', layerId, defId: def.defId })}
      onMouseLeave={() => onGeometryHighlight(null)}
    >
      <ShapeTag shape={def.shape} />
      <span className="text-xs text-zinc-400 font-mono truncate max-w-[60px]" title={def.toolCode}>
        {def.toolCode}
      </span>
      <div className="flex-1" />
      {isEditable && currentValue != null ? (
        <EditableValue
          initialMm={currentValue}
          label="⌀"
          onApply={(v) => onApply(layerId, def.defId, v)}
        />
      ) : (
        <span className="text-xs text-zinc-600 italic" title="Complex macro — editing not supported">
          complex
        </span>
      )}
    </div>
  );
}

// ─── Trace widths section ─────────────────────────────────────────────────────

function TraceSection({ classes, layerId, onApply, onGeometryHighlight }: {
  classes: TraceClass[];
  layerId: string;
  onApply: (layerId: string, oldRaw: number, newWidthMm: number) => void;
  onGeometryHighlight: (target: GeometryHighlightTarget | null) => void;
}) {
  if (classes.length === 0) return null;
  return (
    <div>
      <SectionLabel>Trace Widths</SectionLabel>
      <div className="flex flex-col gap-1.5 mt-1">
        {classes.map((tc) => (
          <div
            key={tc.strokeWidthRaw}
            className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-zinc-800/70"
            onMouseEnter={() => onGeometryHighlight({
              type: 'trace-width',
              layerId,
              strokeWidthRaw: tc.strokeWidthRaw,
            })}
            onMouseLeave={() => onGeometryHighlight(null)}
          >
            <span className="text-zinc-600 text-sm">—</span>
            <span className="text-xs text-zinc-500">({tc.instanceCount}×)</span>
            <div className="flex-1" />
            <EditableValue
              initialMm={tc.widthMm}
              label="w"
              onApply={(v) => onApply(layerId, tc.strokeWidthRaw, v)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Drill sizes section ──────────────────────────────────────────────────────

function DrillSection({ defs, holeCount, layerId, onApply, onGeometryHighlight }: {
  defs: PadDefinition[];
  holeCount: number;
  layerId: string;
  onApply: (layerId: string, defId: string, newDiameterMm: number) => void;
  onGeometryHighlight: (target: GeometryHighlightTarget | null) => void;
}) {
  const drillDefs = defs.filter((d) => d.shape === 'circle' && d.diameterMm != null);
  if (drillDefs.length === 0) return null;

  return (
    <div>
      <SectionLabel>Drill Sizes ({holeCount} holes)</SectionLabel>
      <div className="flex flex-col gap-1.5 mt-1">
        {drillDefs.map((def) => (
          <div
            key={def.defId}
            className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-zinc-800/70"
            onMouseEnter={() => onGeometryHighlight({ type: 'pad-def', layerId, defId: def.defId })}
            onMouseLeave={() => onGeometryHighlight(null)}
          >
            <span className="text-zinc-500 text-sm">○</span>
            <span className="text-xs text-zinc-400 font-mono truncate max-w-[60px]" title={def.toolCode}>
              {def.toolCode}
            </span>
            <div className="flex-1" />
            <EditableValue
              initialMm={def.diameterMm!}
              label="⌀"
              onApply={(v) => onApply(layerId, def.defId, v)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Reusable editable value input ───────────────────────────────────────────

function EditableValue({ initialMm, label, onApply }: {
  initialMm: number;
  label: string;
  onApply: (value: number) => void;
}) {
  const [value, setValue] = useState(initialMm.toFixed(3));
  const [flash, setFlash] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleApply = () => {
    const v = parseFloat(value);
    if (!isFinite(v) || v <= 0) return;
    onApply(Math.max(0.001, Math.min(99.999, v)));
    setFlash(true);
    setTimeout(() => setFlash(false), 600);
  };

  // Sync if parent commits a change (re-extract updates initialMm)
  const prevInitial = useRef(initialMm);
  if (prevInitial.current !== initialMm) {
    prevInitial.current = initialMm;
    setValue(initialMm.toFixed(3));
  }

  const dirty = parseFloat(value).toFixed(3) !== initialMm.toFixed(3);

  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-zinc-600">{label}</span>
      <input
        ref={inputRef}
        type="number"
        min="0.001"
        max="99.999"
        step="0.001"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          const v = parseFloat(value);
          if (!isFinite(v) || v <= 0) setValue(initialMm.toFixed(3));
          else setValue(Math.max(0.001, Math.min(99.999, v)).toFixed(3));
        }}
        onKeyDown={(e) => e.key === 'Enter' && handleApply()}
        className={[
          'w-20 bg-zinc-800 border rounded px-1.5 py-0.5 text-xs font-mono text-zinc-200',
          'focus:outline-none transition-colors',
          flash
            ? 'border-green-500'
            : dirty
            ? 'border-amber-600'
            : 'border-zinc-700 focus:border-zinc-500',
        ].join(' ')}
      />
      <span className="text-xs text-zinc-600">mm</span>
      <button
        onClick={handleApply}
        disabled={!dirty}
        className="px-1.5 py-0.5 text-xs rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        ✓
      </button>
    </div>
  );
}

// ─── Small reusable pieces ────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-zinc-500 font-medium">{children}</p>;
}

function ShapeTag({ shape }: { shape: string }) {
  const colors: Record<string, string> = {
    circle: 'bg-blue-900/50 text-blue-300',
    ring:   'bg-purple-900/50 text-purple-300',
    rect:   'bg-amber-900/50 text-amber-300',
    polygon:'bg-green-900/50 text-green-300',
    complex:'bg-zinc-800 text-zinc-500',
  };
  return (
    <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${colors[shape] ?? colors.complex}`}>
      {shape === 'complex' ? 'macro' : shape}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 10 10"
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      className={`transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <path d="M2 3.5l3 3 3-3" />
    </svg>
  );
}
