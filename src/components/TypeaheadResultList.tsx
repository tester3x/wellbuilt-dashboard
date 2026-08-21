'use client';

import { typeaheadRowClass } from '@/lib/useTypeaheadNav';

/**
 * Shared typeahead row renderer restored from canonical
 * d7730af6f732ad0af4cc2e5c0fc699bde9c6052b (tester3x/wellbuilt-dashboard).
 *
 * Distinct states: keyboard-highlighted, mouse-hovered (idle+hover),
 * committed/current selection, dark-mode fill, focus-visible on the
 * controlling input (rows are tabIndex=-1 so Tab stays on the input).
 */
export function TypeaheadResultList<T>(props: {
  items: T[];
  activeIndex: number;
  onSelect: (item: T) => void;
  setActiveIndex: (i: number) => void;
  accent?: 'cyan' | 'blue' | 'purple';
  committedValue?: string;
  getKey: (item: T, i: number) => string;
  getLabel: (item: T) => string;
  getSub?: (item: T) => string | undefined;
  open?: boolean;
  className?: string;
  itemClassName?: string;
}) {
  const accent = props.accent || 'cyan';
  if (props.open === false || props.items.length === 0) return null;
  return (
    <div
      role="listbox"
      className={props.className || 'absolute z-50 w-full mt-1 bg-gray-800 border border-gray-600 rounded max-h-36 overflow-y-auto shadow-lg'}
    >
      {props.items.map((item, i) => {
        const focused = i === props.activeIndex;
        const label = props.getLabel(item);
        const committed = !!props.committedValue && props.committedValue === label;
        const kind = focused ? 'keyboard' : committed ? 'committed' : 'idle';
        const sub = props.getSub?.(item);
        return (
          <button
            key={props.getKey(item, i)}
            type="button"
            tabIndex={-1}
            role="option"
            aria-selected={focused}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onSelect(item)}
            onMouseEnter={() => props.setActiveIndex(i)}
            ref={focused ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
            className={`${props.itemClassName || 'w-full text-left px-3 py-1.5 border-b border-gray-700/50 last:border-0 text-sm outline-none'} ${typeaheadRowClass(kind, accent)} ${kind === 'idle' ? 'hover:bg-gray-700' : ''}`}
          >
            {label}
            {sub ? (
              <span className={`text-xs ml-1 ${focused ? 'text-cyan-200' : 'text-gray-400'}`}>{sub}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
