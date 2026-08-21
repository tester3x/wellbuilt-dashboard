'use client';

import { useState } from 'react';

/**
 * Canonical keyboard typeahead nav restored from
 * d7730af6f732ad0af4cc2e5c0fc699bde9c6052b
 * (tester3x/wellbuilt-dashboard).
 *
 * Callers MUST pass a referentially stable options array (useState or
 * useMemo). Reset compares item identity, not array identity, so a freshly
 * allocated filter result with the same members cannot loop setState.
 */
export function optionsShallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function useTypeaheadNav<T>(options: T[], onSelect: (item: T) => void) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [prevOptions, setPrevOptions] = useState(options);
  if (!optionsShallowEqual(options, prevOptions)) {
    setPrevOptions(options);
    setActiveIndex(0);
    setDismissed(false);
  }
  const onKeyDown = (e: { key: string; shiftKey?: boolean; preventDefault: () => void }) => {
    if (!options.length || dismissed) return;
    const last = options.length - 1;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => (i >= last ? 0 : i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => (i <= 0 ? last : i - 1)); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) setActiveIndex(i => (i <= 0 ? last : i - 1));
      else setActiveIndex(i => (i >= last ? 0 : i + 1));
    }
    else if (e.key === 'Enter') {
      const item = options[Math.min(activeIndex, last)];
      if (item) { e.preventDefault(); onSelect(item); }
    }
    else if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); }
  };
  return { activeIndex, setActiveIndex, onKeyDown, open: options.length > 0 && !dismissed, dismissed };
}

export function typeaheadRowClass(kind: 'keyboard' | 'hover' | 'idle' | 'committed', accent: 'cyan' | 'blue' | 'purple' = 'cyan'): string {
  const accentFill = accent === 'cyan'
    ? 'bg-cyan-600/40 text-white ring-1 ring-inset ring-cyan-400'
    : accent === 'purple'
      ? 'bg-purple-600/40 text-white ring-1 ring-inset ring-purple-400'
      : 'bg-blue-600/40 text-white ring-1 ring-inset ring-blue-400';
  if (kind === 'keyboard') return accentFill;
  if (kind === 'committed') return 'bg-cyan-950/40 text-cyan-100 ring-1 ring-inset ring-cyan-500';
  if (kind === 'hover') return 'text-white bg-gray-700';
  return 'text-white';
}
