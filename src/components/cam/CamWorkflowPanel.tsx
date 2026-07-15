import React, { useState } from 'react';
import type { LayerEntry } from '../../utils/gerberUtils';
import { LAYER_LABELS } from '../../utils/layerUtils';
import { deriveIsolationToolGeometry } from '../../kernel/cncParams';
import { AUTO_STOCK_MARGIN_MM } from '../../kernel/board3d';
import type {
  CenteringParams,
  CutoutParams,
  DrillParams,
  IsolationParams,
  KernelJobResult,
  KernelOpResult,
  OperationRequest,
  StockSettings,
} from '../../kernel/types';

/** Synthetic key for the centering op (not tied to one layer). */
export const CENTERING_KEY = '__centering__';

/** Stock configuration held in App state. Auto → circuit bounds + margin. */
export interface StockConfig {
  auto: boolean;
  widthMm: number;
  heightMm: number;
  offsetXMm: number;
  offsetYMm: number;
}

export const DEFAULT_STOCK_CONFIG: StockConfig = {
  auto: true,
  widthMm: 100,
  heightMm: 80,
  offsetXMm: AUTO_STOCK_MARGIN_MM,
  offsetYMm: AUTO_STOCK_MARGIN_MM,
};

/** Resolve the config to concrete kernel StockSettings (undefined = auto). */
export function resolveStockSettings(config: StockConfig): StockSettings | undefined {
  if (config.auto) return undefined;
  return {
    widthMm: config.widthMm,
    heightMm: config.heightMm,
    offsetXMm: config.offsetXMm,
    offsetYMm: config.offsetYMm,
  };
}

export const DEFAULT_ISOLATION_PARAMS: IsolationParams = {
  toolDiameterMm: 0.2,
  passes: 1,
  overlap: 0.5,
  isoType: 'exterior',
  toolProfile: 'conical',
  tipDiameterMm: 0.1,
  toolAngleDeg: 30,
  cuttingDepthMm: 0.1,
  traceMarginMm: 0,
  hatchingMarginMm: 0,
  joinStyle: 'round',
  skipTightClearancePaths: false,
  extraPadContours: 0,
};

export const DEFAULT_DRILL_PARAMS: DrillParams = {
  toolDiameterMm: 0.8,
  lateralStepoverPct: 50,
  allowOversizeForSmallHoles: false,
};

export const DEFAULT_CUTOUT_PARAMS: CutoutParams = {
  toolDiameterMm: 2,
  compensation: 'outside',
  holdingTabCount: 4,
  holdingTabWidthMm: 1,
};

export const DEFAULT_CENTERING_PARAMS: CenteringParams = {
  orientation: 'horizontal',
  holeCount: 2,
  outlineToHoleCenterMm: 12,
  holeSpacingMm: 10,
  holeDiameterMm: 3,
  toolDiameterMm: 1,
  lateralStepoverPct: 50,
};

interface OpConfigBase {
  enabled: boolean;
  toolNumber: number;
  /** Mirror the generated toolpaths about the flip axis. */
  mirror: boolean;
  /** Show this op's toolpaths in the 2D/3D previews. */
  overlayVisible: boolean;
}

/** Per-layer operation configuration held in App state. */
export type OpConfig =
  | (OpConfigBase & { kind: 'isolation'; params: IsolationParams })
  | (OpConfigBase & { kind: 'drill'; params: DrillParams })
  | (OpConfigBase & { kind: 'cutout'; params: CutoutParams })
  | (OpConfigBase & { kind: 'centering'; params: CenteringParams });

export type OpConfigMap = Record<string, OpConfig>;

const CONFIG_DEFAULTS = { mirror: false, overlayVisible: true };

/** Seed one op config per CAM-relevant layer, preserving existing entries. */
export function seedOpConfigs(layers: LayerEntry[], existing: OpConfigMap): OpConfigMap {
  const next: OpConfigMap = {};
  for (const layer of layers) {
    if (existing[layer.id]) {
      next[layer.id] = existing[layer.id];
      continue;
    }
    if (layer.layerType === 'top-copper' || layer.layerType === 'bottom-copper') {
      next[layer.id] = {
        kind: 'isolation',
        enabled: true,
        toolNumber: 1,
        ...CONFIG_DEFAULTS,
        params: { ...DEFAULT_ISOLATION_PARAMS },
      };
    } else if (layer.layerType === 'drill') {
      next[layer.id] = {
        kind: 'drill',
        enabled: true,
        toolNumber: 2,
        ...CONFIG_DEFAULTS,
        params: { ...DEFAULT_DRILL_PARAMS },
      };
    } else if (layer.layerType === 'board-outline') {
      next[layer.id] = {
        kind: 'cutout',
        enabled: true,
        toolNumber: 3,
        ...CONFIG_DEFAULTS,
        params: { ...DEFAULT_CUTOUT_PARAMS },
      };
    }
  }
  // Double-sided boards get a centering-holes op (disabled until wanted).
  const copperCount = layers.filter(
    (l) => l.layerType === 'top-copper' || l.layerType === 'bottom-copper',
  ).length;
  if (copperCount >= 2) {
    next[CENTERING_KEY] =
      existing[CENTERING_KEY] ??
      ({
        kind: 'centering',
        enabled: false,
        toolNumber: 4,
        ...CONFIG_DEFAULTS,
        params: { ...DEFAULT_CENTERING_PARAMS },
      } as OpConfig);
  }
  return next;
}

/** Stable operation id for a config entry (used for overlay filtering too). */
export function opIdFor(key: string, config: OpConfig): string {
  return config.kind === 'centering' ? 'centering' : `${config.kind}:${key}`;
}

export function buildOperationRequests(layers: LayerEntry[], configs: OpConfigMap): OperationRequest[] {
  const out: OperationRequest[] = [];
  for (const layer of layers) {
    const config = configs[layer.id];
    if (!config || !config.enabled || !layer.primitives) continue;
    out.push({
      id: opIdFor(layer.id, config),
      kind: config.kind,
      layerId: layer.id,
      toolNumber: config.toolNumber,
      mirror: config.mirror,
      params: config.params,
    } as OperationRequest);
  }
  const centering = configs[CENTERING_KEY];
  if (centering && centering.kind === 'centering' && centering.enabled) {
    // Anchor to any layer with kernel geometry (bounds come from the job).
    const anchor =
      layers.find((l) => l.layerType === 'board-outline' && l.primitives) ??
      layers.find((l) => l.primitives);
    if (anchor) {
      out.push({
        id: opIdFor(CENTERING_KEY, centering),
        kind: 'centering',
        layerId: anchor.id,
        toolNumber: centering.toolNumber,
        mirror: false,
        params: centering.params,
      });
    }
  }
  return out;
}

/** Machining priority: registration first, cutout last. */
export const WORKFLOW_ORDER: Record<OpConfig['kind'] | 'top-copper' | 'bottom-copper', number> = {
  centering: 0,
  'top-copper': 1,
  'bottom-copper': 2,
  isolation: 1, // refined per layer below
  drill: 3,
  cutout: 4,
};

interface Props {
  layers: LayerEntry[];
  configs: OpConfigMap;
  onConfigChange: (layerId: string, config: OpConfig) => void;
  onGenerate: () => void;
  onGenerateCentering: () => void;
  onExport: () => void;
  busy: { stage: string; pct: number } | null;
  camResult: KernelJobResult | null;
  camStale: boolean;
  stock: StockConfig;
  onStockChange: (stock: StockConfig) => void;
  /** Circuit bounding box in mm [minX, minY, width, height], for auto stock. */
  circuitSizeMm: { width: number; height: number } | null;
  /** Actual stock panel size from the 3D model (auto stock can grow). */
  actualStockSizeMm: { width: number; height: number } | null;
}

export function CamWorkflowPanel({
  layers,
  configs,
  onConfigChange,
  onGenerate,
  onGenerateCentering,
  onExport,
  busy,
  camResult,
  camStale,
  stock,
  onStockChange,
  circuitSizeMm,
  actualStockSizeMm,
}: Props) {
  // Machining priority regardless of file load order:
  // 1 registration → 2 top iso → 3 bottom iso (mirrored) → 4 drill → 5 cutout.
  const OP_ORDER: Partial<Record<LayerEntry['layerType'], number>> = {
    'top-copper': 1,
    'bottom-copper': 2,
    drill: 3,
    'board-outline': 4,
  };
  const camLayers = layers
    .filter((l) => configs[l.id])
    .sort((a, b) => (OP_ORDER[a.layerType] ?? 9) - (OP_ORDER[b.layerType] ?? 9));
  const centeringConfig = configs[CENTERING_KEY];
  if (camLayers.length === 0 && !centeringConfig) return null;

  const resultsByOpId = new Map<string, KernelOpResult>(
    (camResult?.operations ?? []).map((op) => [op.id, op]),
  );
  const centeringResult = centeringConfig
    ? resultsByOpId.get(opIdFor(CENTERING_KEY, centeringConfig)) ?? null
    : null;

  const cards: React.ReactNode[] = [];
  let step = 2;
  for (const layer of camLayers) {
    const config = configs[layer.id];
    const title =
      config.kind === 'isolation' ? 'Isolation' : config.kind === 'drill' ? 'Drill' : 'Cutout';
    cards.push(
      <OperationCard
        key={layer.id}
        step={centeringConfig ? step++ : step++ - 1}
        title={title}
        subtitle={`${LAYER_LABELS[layer.layerType]} · ${layer.file.name}`}
        config={config}
        result={resultsByOpId.get(opIdFor(layer.id, config)) ?? null}
        stale={camStale}
        // Mirroring belongs to the bottom side only — the top is milled as-is.
        showMirror={config.kind === 'isolation' && layer.layerType === 'bottom-copper'}
        onChange={(next) => onConfigChange(layer.id, next)}
      />,
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mt-1">
        Stock
      </h3>
      <StockPanel
        stock={stock}
        onChange={onStockChange}
        circuitSizeMm={circuitSizeMm}
        actualStockSizeMm={actualStockSizeMm}
      />

      {centeringConfig && (
        <>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mt-1">
            1 · Registration
          </h3>
          <OperationCard
            key={CENTERING_KEY}
            step={1}
            title="Centering"
            subtitle="Registration holes on the flip axis"
            config={centeringConfig}
            result={centeringResult}
            stale={camStale}
            showMirror={false}
            hideEnable
            onChange={(next) => onConfigChange(CENTERING_KEY, next)}
          />
          <button
            onClick={onGenerateCentering}
            disabled={busy != null}
            className="w-full px-3 py-1.5 text-sm font-medium text-zinc-900 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {centeringResult ? 'Regenerate centering holes' : 'Drill centering holes'}
          </button>
          <p className="text-[11px] text-zinc-600 -mt-1">
            Drill these first, pin the stock, then machine the sides.
          </p>
        </>
      )}

      <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mt-1">
        {centeringConfig ? 'Machining steps' : 'Operations'}
      </h3>

      {cards}

      <button
        onClick={onGenerate}
        disabled={busy != null || camLayers.every((l) => !configs[l.id]?.enabled)}
        className="w-full px-3 py-2 text-sm font-medium text-zinc-900 bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? `${busy.stage}…` : camResult ? 'Regenerate toolpaths' : 'Generate toolpaths'}
      </button>
      {busy && (
        <div className="h-1 rounded bg-zinc-800 overflow-hidden">
          <div
            className="h-full bg-cyan-400 transition-all"
            style={{ width: `${Math.round(busy.pct * 100)}%` }}
          />
        </div>
      )}
      {camStale && camResult && !busy && (
        <p className="text-xs text-amber-300">Layers changed — toolpaths are stale. Regenerate before exporting.</p>
      )}

      {camResult && camResult.operations.length > 0 && (
        <button
          onClick={onExport}
          disabled={busy != null || camStale}
          className="w-full px-3 py-2 text-sm font-medium text-zinc-900 bg-green-400 hover:bg-green-300 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Export HPGL ({camResult.operations.length} file{camResult.operations.length !== 1 ? 's' : ''})
        </button>
      )}
    </div>
  );
}

function StockPanel({
  stock,
  onChange,
  circuitSizeMm,
  actualStockSizeMm,
}: {
  stock: StockConfig;
  onChange: (stock: StockConfig) => void;
  circuitSizeMm: { width: number; height: number } | null;
  actualStockSizeMm: { width: number; height: number } | null;
}) {
  // Prefer the real panel size from the kernel — auto stock grows to cover
  // generated geometry (centering holes, cutout compensation).
  const autoW =
    actualStockSizeMm?.width ??
    (circuitSizeMm ? circuitSizeMm.width + 2 * AUTO_STOCK_MARGIN_MM : null);
  const autoH =
    actualStockSizeMm?.height ??
    (circuitSizeMm ? circuitSizeMm.height + 2 * AUTO_STOCK_MARGIN_MM : null);

  const fits =
    stock.auto ||
    circuitSizeMm == null ||
    (circuitSizeMm.width + stock.offsetXMm <= stock.widthMm + 1e-9 &&
      circuitSizeMm.height + stock.offsetYMm <= stock.heightMm + 1e-9);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 flex flex-col gap-1.5">
      <CheckboxField
        label={`Auto size (circuit + ${AUTO_STOCK_MARGIN_MM} mm margin)`}
        checked={stock.auto}
        onChange={(auto) =>
          onChange(
            auto || autoW == null || autoH == null
              ? { ...stock, auto }
              : {
                  // Seed manual mode from the current auto values.
                  auto,
                  widthMm: Math.ceil(autoW),
                  heightMm: Math.ceil(autoH),
                  offsetXMm: AUTO_STOCK_MARGIN_MM,
                  offsetYMm: AUTO_STOCK_MARGIN_MM,
                },
          )
        }
      />
      {stock.auto ? (
        autoW != null &&
        autoH != null && (
          <p className="text-[11px] text-zinc-500 font-mono">
            {autoW.toFixed(1)} × {autoH.toFixed(1)} mm · circuit at {AUTO_STOCK_MARGIN_MM},{AUTO_STOCK_MARGIN_MM}
          </p>
        )
      ) : (
        <>
          <NumberField label="Stock width (mm)" value={stock.widthMm} step={5} min={1} onChange={(v) => onChange({ ...stock, widthMm: v })} />
          <NumberField label="Stock height (mm)" value={stock.heightMm} step={5} min={1} onChange={(v) => onChange({ ...stock, heightMm: v })} />
          <NumberField label="Circuit offset X (mm)" value={stock.offsetXMm} step={1} min={0} onChange={(v) => onChange({ ...stock, offsetXMm: v })} />
          <NumberField label="Circuit offset Y (mm)" value={stock.offsetYMm} step={1} min={0} onChange={(v) => onChange({ ...stock, offsetYMm: v })} />
          {!fits && (
            <p className="text-[11px] text-amber-300">
              Circuit ({circuitSizeMm!.width.toFixed(1)} × {circuitSizeMm!.height.toFixed(1)} mm) does not fit
              on the stock at this offset.
            </p>
          )}
        </>
      )}
    </div>
  );
}

const KIND_COLORS: Record<OpConfig['kind'], string> = {
  isolation: 'text-fuchsia-300',
  drill: 'text-cyan-300',
  cutout: 'text-green-300',
  centering: 'text-sky-300',
};

function OperationCard({
  step,
  title,
  subtitle,
  config,
  result,
  stale,
  showMirror,
  hideEnable,
  onChange,
}: {
  step: number;
  title: string;
  subtitle: string;
  config: OpConfig;
  result: KernelOpResult | null;
  stale: boolean;
  showMirror: boolean;
  hideEnable?: boolean;
  onChange: (config: OpConfig) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="w-4 h-4 shrink-0 rounded-full bg-zinc-800 text-zinc-400 text-[10px] font-mono flex items-center justify-center">
          {step}
        </span>
        {!hideEnable && (
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => onChange({ ...config, enabled: e.target.checked } as OpConfig)}
            className="accent-cyan-400"
          />
        )}
        <button className="flex-1 min-w-0 text-left" onClick={() => setOpen(!open)}>
          <span className="flex items-center gap-1.5">
            <span className={`text-xs font-medium ${KIND_COLORS[config.kind]}`}>{title}</span>
            {config.mirror && (
              <span className="px-1 rounded bg-sky-950 text-[10px] text-sky-300">mirrored</span>
            )}
          </span>
          <span className="block text-[11px] text-zinc-500 truncate leading-tight" title={subtitle}>
            {subtitle}
          </span>
        </button>
        <button
          onClick={() => onChange({ ...config, overlayVisible: !config.overlayVisible } as OpConfig)}
          title={config.overlayVisible ? 'Hide toolpaths in previews' : 'Show toolpaths in previews'}
          className={`p-1 rounded transition-colors hover:bg-zinc-700 ${config.overlayVisible ? 'text-zinc-400 hover:text-zinc-100' : 'text-zinc-600 hover:text-zinc-300'}`}
        >
          {config.overlayVisible ? <EyeIcon /> : <EyeOffIcon />}
        </button>
        <span className="text-xs text-zinc-600">{open ? '▾' : '▸'}</span>
      </div>

      {open && (
        <div className="px-3 pb-3 border-t border-zinc-800/60 pt-2">
          {config.kind === 'isolation' && (
            <IsolationParamsForm
              params={config.params}
              onChange={(params) => onChange({ ...config, params })}
            />
          )}
          {config.kind === 'drill' && (
            <DrillParamsForm
              params={config.params}
              onChange={(params) => onChange({ ...config, params })}
            />
          )}
          {config.kind === 'cutout' && (
            <CutoutParamsForm
              params={config.params}
              onChange={(params) => onChange({ ...config, params })}
            />
          )}
          {config.kind === 'centering' && (
            <CenteringParamsForm
              params={config.params}
              onChange={(params) => onChange({ ...config, params })}
            />
          )}
          {showMirror && (
            <CheckboxField
              label="Mirror at export (flip about registration axis)"
              checked={config.mirror}
              onChange={(mirror) => onChange({ ...config, mirror } as OpConfig)}
            />
          )}
          <NumberField
            label="Tool #"
            value={config.toolNumber}
            step={1}
            min={1}
            onChange={(v) => onChange({ ...config, toolNumber: Math.max(1, Math.round(v)) } as OpConfig)}
          />
        </div>
      )}

      {result && (
        <div className={`px-3 pb-2 flex flex-wrap gap-1 ${stale ? 'opacity-50' : ''}`}>
          <Chip>{result.stats.strokeCount} paths</Chip>
          <Chip>{result.stats.pathLengthMm.toFixed(0)} mm</Chip>
          {result.stats.plungeCount != null && <Chip>{result.stats.plungeCount} plunges</Chip>}
          {result.stats.borePassCount != null && result.stats.borePassCount > 0 && (
            <Chip>{result.stats.borePassCount} bores</Chip>
          )}
          {result.stats.loopCount != null && <Chip>{result.stats.loopCount} loop(s)</Chip>}
          {(result.stats.padContourCount ?? 0) > 0 && (
            <Chip>{result.stats.padContourCount} pad contours</Chip>
          )}
          {(result.stats.skippedSmallHoles ?? 0) > 0 && (
            <Chip tone="warn">{result.stats.skippedSmallHoles} skipped</Chip>
          )}
          {(result.stats.skippedPasses ?? 0) > 0 && (
            <Chip tone="warn">{result.stats.skippedPasses} passes skipped</Chip>
          )}
          {result.warnings.length > 0 && <Chip tone="warn">{result.warnings.length} warning(s)</Chip>}
        </div>
      )}
    </div>
  );
}

function IsolationParamsForm({
  params,
  onChange,
}: {
  params: IsolationParams;
  onChange: (params: IsolationParams) => void;
}) {
  const tool = deriveIsolationToolGeometry(params);
  return (
    <div className="flex flex-col gap-1.5">
      <SelectField
        label="Tool profile"
        value={params.toolProfile}
        options={[
          { value: 'conical', label: 'Conical (V-bit)' },
          { value: 'cylindrical', label: 'Cylindrical' },
        ]}
        onChange={(v) => onChange({ ...params, toolProfile: v as IsolationParams['toolProfile'] })}
      />
      {params.toolProfile === 'conical' ? (
        <>
          <NumberField label="Tip Ø (mm)" value={params.tipDiameterMm} step={0.01} min={0} onChange={(v) => onChange({ ...params, tipDiameterMm: v })} />
          <NumberField label="V angle (°)" value={params.toolAngleDeg} step={1} min={0} onChange={(v) => onChange({ ...params, toolAngleDeg: v })} />
          <NumberField label="Cut depth (mm)" value={params.cuttingDepthMm} step={0.01} min={0} onChange={(v) => onChange({ ...params, cuttingDepthMm: v })} />
        </>
      ) : (
        <>
          <NumberField label="Tool Ø (mm)" value={params.toolDiameterMm} step={0.05} min={0.01} onChange={(v) => onChange({ ...params, toolDiameterMm: v })} />
          <NumberField label="Overlap (0–0.9)" value={params.overlap} step={0.05} min={0} max={0.9} onChange={(v) => onChange({ ...params, overlap: v })} />
        </>
      )}
      <NumberField label="Passes" value={params.passes} step={1} min={1} max={10} onChange={(v) => onChange({ ...params, passes: Math.max(1, Math.round(v)) })} />
      <SelectField
        label="Side"
        value={params.isoType}
        options={[
          { value: 'exterior', label: 'Exterior only' },
          { value: 'both', label: 'Both (exterior + interior)' },
          { value: 'interior', label: 'Interior only' },
        ]}
        onChange={(v) => onChange({ ...params, isoType: v as IsolationParams['isoType'] })}
      />
      <NumberField label="Trace margin (mm)" value={params.traceMarginMm} step={0.01} min={0} onChange={(v) => onChange({ ...params, traceMarginMm: v })} />
      <NumberField
        label="Pad contours (extra)"
        value={params.extraPadContours}
        step={1}
        min={0}
        max={8}
        onChange={(v) => onChange({ ...params, extraPadContours: Math.max(0, Math.round(v)) })}
      />
      <CheckboxField
        label="Skip passes tighter than copper gap"
        checked={params.skipTightClearancePaths}
        onChange={(v) => onChange({ ...params, skipTightClearancePaths: v })}
      />
      <p className="text-[11px] text-zinc-500 font-mono mt-0.5">
        D<sub>eff</sub> {tool.effectiveDiameterMm.toFixed(3)} mm · step {tool.hatchingMarginMm.toFixed(3)} mm
      </p>
    </div>
  );
}

function CenteringParamsForm({
  params,
  onChange,
}: {
  params: CenteringParams;
  onChange: (params: CenteringParams) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <SelectField
        label="Flip axis"
        value={params.orientation}
        options={[
          { value: 'horizontal', label: 'Horizontal (holes left/right)' },
          { value: 'vertical', label: 'Vertical (holes top/bottom)' },
        ]}
        onChange={(v) => onChange({ ...params, orientation: v as CenteringParams['orientation'] })}
      />
      <NumberField label="Holes (2–4)" value={params.holeCount} step={1} min={2} max={4} onChange={(v) => onChange({ ...params, holeCount: Math.max(2, Math.min(4, Math.round(v))) })} />
      <NumberField label="Outline → hole (mm)" value={params.outlineToHoleCenterMm} step={1} min={2} onChange={(v) => onChange({ ...params, outlineToHoleCenterMm: v })} />
      {params.holeCount > 2 && (
        <NumberField label="Extra hole spacing (mm)" value={params.holeSpacingMm} step={1} min={2} onChange={(v) => onChange({ ...params, holeSpacingMm: v })} />
      )}
      <NumberField label="Hole Ø (mm)" value={params.holeDiameterMm} step={0.1} min={0.5} onChange={(v) => onChange({ ...params, holeDiameterMm: v })} />
      <NumberField label="Tool Ø (mm)" value={params.toolDiameterMm} step={0.1} min={0.1} onChange={(v) => onChange({ ...params, toolDiameterMm: v })} />
      <NumberField label="Stepover (% radius)" value={params.lateralStepoverPct} step={5} min={1} max={100} onChange={(v) => onChange({ ...params, lateralStepoverPct: v })} />
      <p className="text-[11px] text-zinc-500">
        All holes sit on the flip axis outside the board — drill through board AND spoilboard, pin, flip about the axis.
      </p>
    </div>
  );
}

function DrillParamsForm({
  params,
  onChange,
}: {
  params: DrillParams;
  onChange: (params: DrillParams) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <NumberField label="Tool Ø (mm)" value={params.toolDiameterMm} step={0.1} min={0.1} onChange={(v) => onChange({ ...params, toolDiameterMm: v })} />
      <NumberField label="Stepover (% radius)" value={params.lateralStepoverPct} step={5} min={1} max={100} onChange={(v) => onChange({ ...params, lateralStepoverPct: v })} />
      <CheckboxField
        label="Drill small holes oversize"
        checked={params.allowOversizeForSmallHoles}
        onChange={(v) => onChange({ ...params, allowOversizeForSmallHoles: v })}
      />
    </div>
  );
}

function CutoutParamsForm({
  params,
  onChange,
}: {
  params: CutoutParams;
  onChange: (params: CutoutParams) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <NumberField label="Tool Ø (mm)" value={params.toolDiameterMm} step={0.1} min={0.1} onChange={(v) => onChange({ ...params, toolDiameterMm: v })} />
      <SelectField
        label="Compensation"
        value={params.compensation}
        options={[
          { value: 'outside', label: 'Outside (keep board)' },
          { value: 'inside', label: 'Inside (keep hole)' },
          { value: 'onpath', label: 'On path' },
        ]}
        onChange={(v) => onChange({ ...params, compensation: v as CutoutParams['compensation'] })}
      />
      <NumberField label="Holding tabs" value={params.holdingTabCount} step={1} min={0} max={16} onChange={(v) => onChange({ ...params, holdingTabCount: Math.max(0, Math.round(v)) })} />
      <NumberField label="Tab width (mm)" value={params.holdingTabWidthMm} step={0.25} min={0} onChange={(v) => onChange({ ...params, holdingTabWidthMm: v })} />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="w-20 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-200 font-mono text-right"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">
      <span className="shrink-0">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-zinc-200"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-400 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-cyan-400"
      />
      {label}
    </label>
  );
}

// Same show/hide glyphs as the layer rows (LayerInfo) for visual consistency.
function EyeIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z" /><circle cx="8" cy="8" r="2" /></svg>;
}
function EyeOffIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 2l12 12M6.5 6.6A2 2 0 0 0 9.4 9.5" /><path d="M4.2 4.3C2.5 5.4 1 8 1 8s2.5 5 7 5c1.3 0 2.5-.4 3.5-1M7 3.1C7.3 3 7.7 3 8 3c4.5 0 7 5 7 5s-.6 1.2-1.7 2.4" /></svg>;
}

function Chip({ children, tone = 'normal' }: { children: React.ReactNode; tone?: 'normal' | 'warn' }) {
  return (
    <span
      className={[
        'px-1.5 py-0.5 rounded text-[10px] font-mono',
        tone === 'warn' ? 'bg-amber-950 text-amber-300 border border-amber-900' : 'bg-zinc-800 text-zinc-400',
      ].join(' ')}
    >
      {children}
    </span>
  );
}
