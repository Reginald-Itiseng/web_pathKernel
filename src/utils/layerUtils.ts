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
  exc: 'drill',
  ncd: 'drill',
  txt: 'unknown',
  gbr: 'unknown',
  ger: 'unknown',
  art: 'unknown',
};

/**
 * Detect layer type.  Priority order:
 *   1. Unambiguous file extension (e.g. .gtl, .drl)
 *   2. Gerber X2 TF.FileFunction attribute in file content  ← most reliable for .gbr
 *   3. KiCad-style filename suffix  (e.g. -F_Cu.gbr, -Edge_Cuts.gbr)
 */
export function detectLayerType(filename: string, content?: string): LayerType {
  const lower = filename.toLowerCase();
  const ext   = lower.split('.').pop() ?? '';

  // 1. Fast-path: unambiguous extension
  const byExt = EXT_TO_LAYER[ext];
  if (byExt && byExt !== 'unknown') return byExt;

  // 2. Content-based: Gerber X2 attributes + Excellon markers
  if (content) {
    const sniffed = sniffLayerType(content);
    if (sniffed !== 'unknown') return sniffed;
  }

  // 3. KiCad filename-suffix patterns
  for (const [pattern, type] of KICAD_SUFFIXES) {
    if (pattern.test(lower)) return type;
  }

  return byExt ?? 'unknown';
}

/**
 * Detect layer type purely from file content.
 *
 * Reads the Gerber X2 TF.FileFunction attribute if present (KiCad ≥ 5,
 * Altium, EasyEDA, etc.) — this is authoritative.  Falls back to
 * Excellon/drill heuristics for drill files.
 */
export function sniffLayerType(content: string): LayerType {
  const head = content.slice(0, 6000);
  const headUpper = head.toUpperCase();

  // ── Gerber X2: %TF.FileFunction,<function>,<args>*% ──────────────────
  // KiCad, Altium, EasyEDA, Fusion360 and many others write this.
  const tfMatch = head.match(/%TF\.FileFunction,([^*%\r\n]+)/i);
  if (tfMatch) {
    const parts = tfMatch[1].split(',').map((s) => s.trim().toUpperCase());
    const func  = parts[0];
    const isTop = parts.includes('TOP');
    const isBot = parts.includes('BOT') || parts.includes('BOTTOM');

    if (func === 'COPPER') {
      if (isTop) return 'top-copper';
      if (isBot) return 'bottom-copper';
      // Fallback: use layer number (L1 = top, any higher = bottom for 2-layer)
      const lNum = parts.find((p) => /^L\d+$/.test(p));
      if (lNum) return parseInt(lNum.slice(1)) === 1 ? 'top-copper' : 'bottom-copper';
      return 'top-copper'; // default to top if side is unknown
    }
    if (func === 'PROFILE') return 'board-outline';
    if (func === 'SOLDERMASK') {
      if (isTop) return 'top-soldermask';
      if (isBot) return 'bottom-soldermask';
    }
    if (func === 'LEGEND') {
      if (isTop) return 'top-silkscreen';
      if (isBot) return 'bottom-silkscreen';
    }
    // SolderPaste, Glue, DrillMap, AssemblyDrawing etc. → unknown
  }

  // ── Excellon drill file detection ────────────────────────────────────
  // KiCad drill: "; #@! TF.FileFunction,MixedPlating,1,2" in comments
  if (/;\s*#@!\s*TF\.FileFunction,(?:Mixed|Non)?Plat/i.test(head)) return 'drill';

  const hasExcellonHeader = /\bM48\b/.test(headUpper);
  const hasExcellonUnits  = /\b(METRIC|INCH)(?:,\s*(LZ|TZ))?\b/.test(headUpper);
  const hasToolDefs       = /(?:^|\n)\s*T\d{1,3}\s*C\d*\.?\d+/m.test(head);
  const hasGerberMarkers  = /%FS|%MO|%ADD|D0[123]\*/.test(headUpper);

  if ((hasExcellonHeader || hasToolDefs || hasExcellonUnits) && !hasGerberMarkers) return 'drill';

  return 'unknown';
}

export function layerDetectionConfidence(
  filename: string,
  content: string,
  layerType: LayerType,
): 'high' | 'medium' | 'low' {
  const lower   = filename.toLowerCase();
  const ext     = lower.split('.').pop() ?? '';
  const sniffed = sniffLayerType(content);

  // Content-based detection via X2 attribute or Excellon header = highest confidence
  if (sniffed !== 'unknown' && sniffed === layerType) return 'high';
  if (EXT_TO_LAYER[ext] === layerType && layerType !== 'unknown') return ext === 'txt' ? 'low' : 'high';
  if (KICAD_SUFFIXES.some(([pattern, type]) => type === layerType && pattern.test(lower))) return 'high';
  if (layerType === 'unknown') return 'low';
  return 'medium';
}

export function acceptedFileExtensions(): string {
  return '.gbr,.gtl,.gbl,.gts,.gbs,.ger,.art,.gto,.gbo,.gko,.gm1,.drl,.xln,.exc,.ncd,.txt,.gbrjob';
}

/**
 * Ordered list of [regex, LayerType] pairs.
 * Match against the lowercased full filename.
 * More-specific rules come first.
 */
const KICAD_SUFFIXES: [RegExp, LayerType][] = [
  // Copper
  [/[-_]f[._]cu\b/, 'top-copper'],
  [/[-_]b[._]cu\b/, 'bottom-copper'],
  // Silkscreen  (KiCad 6+: Silkscreen, KiCad 5: SilkS)
  [/[-_]f[._](silkscreen|silks)\b/, 'top-silkscreen'],
  [/[-_]b[._](silkscreen|silks)\b/, 'bottom-silkscreen'],
  // Soldermask
  [/[-_]f[._]mask\b/, 'top-soldermask'],
  [/[-_]b[._]mask\b/, 'bottom-soldermask'],
  // Board outline (Edge.Cuts / Edge_Cuts)
  [/[-_]edge[._]cuts\b/, 'board-outline'],
  // Drill variants sometimes exported as .gbr
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
  drill: 9,
  'board-outline': 8,
  'top-silkscreen': 7,
  'bottom-silkscreen': 6,
  'top-soldermask': 5,
  'bottom-soldermask': 4,
  'top-copper': 3,
  'bottom-copper': 2,
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
