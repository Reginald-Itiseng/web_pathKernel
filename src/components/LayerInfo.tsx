import {
  detectLayerType,
  LAYER_LABELS,
  LAYER_COLORS,
} from '../utils/layerUtils';
import type { ParseResult } from '../utils/gerberUtils';

interface Props {
  file: File;
  result: ParseResult;
}

export function LayerInfo({ file, result }: Props) {
  const layerType = detectLayerType(file.name);
  const label = LAYER_LABELS[layerType];
  const color = LAYER_COLORS[layerType];
  const { width, height, units, defsCount, layerCount } = result;

  return (
    <aside className="w-56 shrink-0 flex flex-col gap-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
        Layer Info
      </h2>

      <Section title="File">
        <InfoRow label="Name">
          <span className="font-mono text-xs break-all text-zinc-200">{file.name}</span>
        </InfoRow>
        <InfoRow label="Size">
          <span className="text-zinc-300">{formatBytes(file.size)}</span>
        </InfoRow>
      </Section>

      <Section title="Layer">
        <InfoRow label="Type">
          <span className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: color }}
            />
            <span className="text-zinc-200">{label}</span>
          </span>
        </InfoRow>
      </Section>

      {(width != null || defsCount > 0 || layerCount > 0) && (
        <Section title="Parsed Data">
          {width != null && height != null && (
            <InfoRow label="Size">
              <span className="font-mono text-xs text-zinc-200">
                {width.toFixed(2)} × {height.toFixed(2)}{' '}
                <span className="text-zinc-400">{units ?? 'mm'}</span>
              </span>
            </InfoRow>
          )}
          {defsCount > 0 && (
            <InfoRow label="Pads">
              <span className="text-zinc-200">{defsCount}</span>
            </InfoRow>
          )}
          {layerCount > 0 && (
            <InfoRow label="Elements">
              <span className="text-zinc-200">{layerCount}</span>
            </InfoRow>
          )}
        </Section>
      )}
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-zinc-900 border border-zinc-800 overflow-hidden">
      <div className="px-3 py-1.5 bg-zinc-800/50 border-b border-zinc-800">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
          {title}
        </span>
      </div>
      <div className="px-3 py-2 flex flex-col gap-2">{children}</div>
    </div>
  );
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-zinc-500">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
