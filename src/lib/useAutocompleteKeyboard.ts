'use client';

/**
 * useAutocompleteKeyboard — the ONE shared combobox keyboard/scroll contract for
 * every Job Builder autocomplete field. Built on the pure autocompleteNavigation
 * core so the visibility math is proven in node; this hook only binds it to the DOM.
 *
 * Contract (all fields, one implementation):
 *  - ArrowDown / ArrowUp move the active option consistently (clamped, no wrap).
 *  - After every change the active option is scrolled fully into view using
 *    nearest-edge scrolling of the LIST CONTAINER ONLY (never the page/modal).
 *  - Enter selects the visibly-active option; Escape closes without touching input.
 *  - Tab / Shift+Tab close the list and move focus normally (no focus trap, no
 *    invisible active option left behind).
 *  - A changed query, or a close/reopen, resets the active option to none (-1) —
 *    no stale/invisible highlight survives.
 *  - Empty/loading/no-result lists have no active option and nothing selectable.
 *  - Proper combobox/listbox semantics: aria-expanded, aria-controls,
 *    aria-activedescendant on the input; role=option + aria-selected per row.
 *  - Mouse click uses onMouseDown-preventDefault so the input never blurs the list
 *    away before the click selects; hover styling (:hover) stays distinct from the
 *    keyboard-active styling ([data-active]/[aria-selected]).
 */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  nextActiveIndex,
  reconcileActiveIndex,
  resetActiveIndex,
  scrollTopForOption,
  isSelectableIndex,
  optionDomId,
} from './autocompleteNavigation';

export interface UseAutocompleteKeyboardOptions {
  /** Number of selectable result rows currently rendered. */
  count: number;
  /** Whether the suggestion list is open/visible. */
  open: boolean;
  /** The current query text — the active option resets whenever this changes. */
  query: string;
  /** Select the result at `index` (the field maps index → its own item + action). */
  onSelect: (index: number) => void;
  /** Close the suggestion list (Escape / Tab / after select). */
  onClose?: () => void;
}

export function useAutocompleteKeyboard({ count, open, query, onSelect, onClose }: UseAutocompleteKeyboardOptions) {
  const rawId = useId();
  const listId = `wb-ac-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLElement | null>(null);
  const optionRefs = useRef<Array<HTMLElement | null>>([]);

  // Reset when the list closes — never reopen onto a stale highlight.
  useEffect(() => {
    if (!open) setActiveIndex(resetActiveIndex());
  }, [open]);

  // A changed query resets to "no active option".
  useEffect(() => {
    setActiveIndex(resetActiveIndex());
  }, [query]);

  // Defensive clamp if the OPEN list changes size in place (async results).
  useEffect(() => {
    setActiveIndex((a) => reconcileActiveIndex(a, count));
  }, [count]);

  // Keep the active option fully visible — scroll the CONTAINER only, nearest-edge.
  useEffect(() => {
    if (activeIndex < 0) return;
    const list = listRef.current;
    const optEl = optionRefs.current[activeIndex];
    if (!list || !optEl) return;
    const desired = scrollTopForOption(
      { scrollTop: list.scrollTop, clientHeight: list.clientHeight },
      { offsetTop: optEl.offsetTop, offsetHeight: optEl.offsetHeight },
    );
    if (desired !== list.scrollTop) list.scrollTop = desired; // container scroll ONLY
  }, [activeIndex]);

  const reset = useCallback(() => setActiveIndex(resetActiveIndex()), []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (!open) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((a) => nextActiveIndex(a, count, 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((a) => nextActiveIndex(a, count, -1));
          break;
        case 'Enter':
          if (isSelectableIndex(activeIndex, count)) {
            e.preventDefault();
            onSelect(activeIndex);
          }
          break;
        case 'Escape':
          e.preventDefault();
          setActiveIndex(resetActiveIndex());
          onClose?.();
          break;
        case 'Tab':
          // Do NOT preventDefault: focus must move to the next field normally.
          setActiveIndex(resetActiveIndex());
          onClose?.();
          break;
        default:
          break;
      }
    },
    [open, count, activeIndex, onSelect, onClose],
  );

  const inputProps = {
    role: 'combobox' as const,
    'aria-expanded': open,
    'aria-controls': listId,
    'aria-autocomplete': 'list' as const,
    'aria-activedescendant': open && activeIndex >= 0 ? optionDomId(listId, activeIndex) : undefined,
    onKeyDown,
  };

  const listProps = {
    id: listId,
    role: 'listbox' as const,
    ref: (el: HTMLElement | null) => {
      listRef.current = el;
    },
  };

  const getOptionProps = (index: number) => ({
    id: optionDomId(listId, index),
    role: 'option' as const,
    'aria-selected': index === activeIndex,
    'data-active': index === activeIndex ? true : undefined,
    ref: (el: HTMLElement | null) => {
      optionRefs.current[index] = el;
    },
    // Keep input focus so the click selects before any blur closes the list.
    onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault(),
    onClick: () => onSelect(index),
  });

  return { activeIndex, setActiveIndex, reset, listId, inputProps, listProps, getOptionProps };
}
