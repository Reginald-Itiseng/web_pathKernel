import { useEffect, useRef, useState } from 'react';
import type { ValidationIssue } from '../types/geometry';

/**
 * Compact header badge summarizing validation issues; click for the full list.
 * Replaces the always-visible ValidationPanel dump.
 */
export function ValidationBadge({ issues }: { issues: ValidationIssue[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const infos = issues.length - errors - warnings;

  const tone =
    errors > 0
      ? 'bg-red-950 border-red-800 text-red-300'
      : warnings > 0
        ? 'bg-amber-950 border-amber-800 text-amber-300'
        : 'bg-zinc-800 border-zinc-700 text-zinc-400';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`px-2 py-0.5 rounded-full border text-xs transition-colors ${tone}`}
        title="Validation issues"
      >
        {issues.length === 0
          ? '✓ checks'
          : [errors && `${errors} err`, warnings && `${warnings} warn`, infos && `${infos} info`]
              .filter(Boolean)
              .join(' · ')}
      </button>

      {open && issues.length > 0 && (
        <div className="absolute right-0 top-8 z-50 w-96 max-h-96 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl p-3">
          <div className="flex flex-col gap-2">
            {issues.map((issue) => (
              <div key={issue.id} className="text-xs">
                <span
                  className={[
                    'inline-block mr-1 px-1 rounded text-[10px]',
                    issue.severity === 'error'
                      ? 'bg-red-900 text-red-200'
                      : issue.severity === 'warning'
                        ? 'bg-amber-900 text-amber-200'
                        : 'bg-zinc-800 text-zinc-300',
                  ].join(' ')}
                >
                  {issue.severity}
                </span>
                <span className="text-zinc-300">{issue.title}</span>
                <p className="text-zinc-500 mt-0.5">{issue.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
