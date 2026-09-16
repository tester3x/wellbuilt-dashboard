'use client';

/**
 * BuilderAutocomplete — the single shared autocomplete/combobox UI for every WB Job
 * Builder suggestion field (well, pickup, drop-off, SWD, operator, project well).
 * It encapsulates the full keyboard/scroll/ARIA contract via useAutocompleteKeyboard
 * so each field is one call site with no per-field keyboard logic:
 *
 *   - ArrowUp/ArrowDown move a keyboard-active option that is always scrolled fully
 *     into view inside THIS list's container (never the page/modal).
 *   - Enter selects the active option; Escape closes without corrupting the input;
 *     Tab / Shift+Tab close and move focus normally (no trap).
 *   - A changed query, blur, or close/reopen never leaves a stale/invisible highlight.
 *   - Empty/no-result lists don't render (nothing keyboard-selectable).
 *   - Mouse hover styling stays distinct from keyboard-active styling (see
 *     .wb-option-row in globals.css); onMouseDown-preventDefault keeps input focus so
 *     a click selects before blur can close the list.
 *   - Proper combobox/listbox semantics (aria-expanded / -controls / -activedescendant).
 */

import { useState, type ReactNode } from 'react';
import { useAutocompleteKeyboard } from '@/lib/useAutocompleteKeyboard';

export interface BuilderAutocompleteProps<T> {
  value: string;
  onValueChange: (v: string) => void;
  /** Result rows to show (the caller computes these from `value`). */
  items: T[];
  onSelect: (item: T, index: number) => void;
  renderItem: (item: T) => ReactNode;
  getItemKey: (item: T, index: number) => string;
  placeholder?: string;
  inputClassName?: string;
  /** Class for the suggestion container. Must establish a scroll box (overflow-y-auto + max-h-*). */
  listClassName?: string;
  /** Class for each option row (typically includes "wb-option-row"). */
  optionClassName?: string;
  /** Minimum query length before the list opens (default 0 — caller may pre-gate items). */
  minChars?: number;
  ariaLabel?: string;
  inputId?: string;
  disabled?: boolean;
  autoComplete?: string;
}

export function BuilderAutocomplete<T>({
  value,
  onValueChange,
  items,
  onSelect,
  renderItem,
  getItemKey,
  placeholder,
  inputClassName,
  listClassName,
  optionClassName,
  minChars = 0,
  ariaLabel,
  inputId,
  disabled,
  autoComplete = 'off',
}: BuilderAutocompleteProps<T>) {
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const meetsMin = value.trim().length >= minChars;
  const open = focused && !dismissed && meetsMin && items.length > 0;

  const kb = useAutocompleteKeyboard({
    count: items.length,
    open,
    query: value,
    onSelect: (i) => {
      if (i >= 0 && i < items.length) {
        onSelect(items[i], i);
        setDismissed(true);
      }
    },
    onClose: () => setDismissed(true),
  });

  return (
    <>
      <input
        type="text"
        id={inputId}
        value={value}
        disabled={disabled}
        autoComplete={autoComplete}
        onChange={(e) => {
          onValueChange(e.target.value);
          setDismissed(false);
        }}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={inputClassName}
        {...kb.inputProps}
      />
      {open && (
        <div className={listClassName} {...kb.listProps}>
          {items.map((item, i) => (
            <button key={getItemKey(item, i)} type="button" className={optionClassName} {...kb.getOptionProps(i)}>
              {renderItem(item)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
