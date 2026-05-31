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

/**
 * KiCad exports every Gerber layer with a `.gbr` extension and encodes the
 * layer in the filename suffix.  We try the extension map first (handles
 * Protel / RS-274X naming), then fall back to a filename-suffix scan for
 * KiCad ≥5 and ≥6 conventions.
 *
 * KiCad 5  uses dots:       project-F.Cu.gbr, project-Edge.Cuts.gbr …
 * KiCad 6+ uses underscores: project-F_Cu.gbr, project-Edge_Cuts.gbr …
 */
export function detectLayerType(filename: string): LayerType {
  const lower = filename.toLowerCase();
  const ext   = lower.split('.').pop() ?? '';

  // 1. Fast-path: unambiguous extension
  const byExt = EXT_TO_LAYER[ext];
  if (byExt && byExt !== 'unknown') return byExt;

  // 2. KiCad filename-suffix detection (both dot and underscore variants)
  if (SUFFIX_MATCH.test(lower)) {
    for (const [pattern, type] of KICAD_SUFFIXES) {
      if (pattern.test(lower)) return type;
    }
  }

  return byExt ?? 'unknown';
}

/** Quick pre-filter — only run the heavy loop if the file looks like a KiCad export */
const SUFFIX_MATCH = /[-_](f|b)[._]/;

/**
 * Ordered list of [regex, LayerType] pairs.
 * Patterns match against the lowercased full filename.
 * More-specific rules come first.
 */
const KICAD_SUFFIXES: [RegExp, LayerType][] = [
  // Copper
  [/[-_]f[._]cu\b/, 'top-copper'],
  [/[-_]b[._]cu\b/, 'bottom-copper'],
  // Silkscreen  (KiCad 6: Silkscreen, KiCad 5: SilkS)
  [/[-_]f[._](silkscreen|silks)\b/, 'top-silkscreen'],
  [/[-_]b[._](silkscreen|silks)\b/, 'bottom-silkscreen'],
  // Soldermask
  [/[-_]f[._]mask\b/, 'top-soldermask'],
  [/[-_]b[._]mask\b/, 'bottom-soldermask'],
  // Board outline (Edge.Cuts / Edge_Cuts)
  [/[-_]edge[._]cuts\b/, 'board-outline'],
  // Drill  (KiCad sometimes names these .gbr too)
  [/[-_](npth|pth|drill)[._]/, 'drill'],
];

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

/** Higher number = rendered on top in the composite stack. */
export const LAYER_Z_ORDER: Record<LayerType, number> = {
  'board-outline': 8,
  'top-silkscreen': 7,
  'bottom-silkscreen': 6,
  'top-soldermask': 5,
  'bottom-soldermask': 4,
  'top-copper': 3,
  'bottom-copper': 2,
  drill: 1,
  unknown: 0,
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
