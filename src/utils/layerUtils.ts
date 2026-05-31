export type LayerType =
  | 'top-copper'
  | 'bottom-copper'
  | 'top-silkscreen'
  | 'bottom-silkscreen'
  | 'top-soldermask'
  | 'bottom-soldermask'
  | 'board-outline'
  | 'drill'
  | 'unknown';

const EXT_TO_LAYER: Record<string, LayerType> = {
  gtl: 'top-copper',
  cmp: 'top-copper',
  top: 'top-copper',
  gbl: 'bottom-copper',
  sol: 'bottom-copper',
  bot: 'bottom-copper',
  gto: 'top-silkscreen',
  sst: 'top-silkscreen',
  gbo: 'bottom-silkscreen',
  ssb: 'bottom-silkscreen',
  gts: 'top-soldermask',
  stc: 'top-soldermask',
  gbs: 'bottom-soldermask',
  sts: 'bottom-soldermask',
  gko: 'board-outline',
  gm1: 'board-outline',
  drl: 'drill',
  xln: 'drill',
  gbr: 'unknown',
  ger: 'unknown',
  art: 'unknown',
};

export function detectLayerType(filename: string): LayerType {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LAYER[ext] ?? 'unknown';
}

export const LAYER_LABELS: Record<LayerType, string> = {
  'top-copper': 'Top Copper',
  'bottom-copper': 'Bottom Copper',
  'top-silkscreen': 'Top Silkscreen',
  'bottom-silkscreen': 'Bottom Silkscreen',
  'top-soldermask': 'Top Soldermask',
  'bottom-soldermask': 'Bottom Soldermask',
  'board-outline': 'Board Outline',
  drill: 'Drill File',
  unknown: 'Unknown Layer',
};

export const LAYER_COLORS: Record<LayerType, string> = {
  'top-copper': '#d4a843',
  'bottom-copper': '#4a9eda',
  'top-silkscreen': '#e2e8f0',
  'bottom-silkscreen': '#c4b5fd',
  'top-soldermask': '#86efac',
  'bottom-soldermask': '#6ee7b7',
  'board-outline': '#fbbf24',
  drill: '#f87171',
  unknown: '#94a3b8',
};
