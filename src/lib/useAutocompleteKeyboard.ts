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
  isSelectableIndex,
  optionDomId,
} from './autocompleteNavigation';
import { scrollActiveOptionIntoView } from './scrollActiveOption';

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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const optionRefs = useRef<Array<HTMLElement | null>>([]);
  const isNavigatingTabRef = useRef(false);

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
  // Uses rect math (offsetParent-independent) so it works even when the list
  // container is not positioned (e.g. the Projects Well list).
  useEffect(() => {
    if (activeIndex < 0) return;
    const list = listRef.current;
    const optEl = optionRefs.current[activeIndex];
    if (!list || !optEl) return;
    scrollActiveOptionIntoView(list, optEl); // container scroll ONLY
  }, [activeIndex]);

  const reset = useCallback(() => setActiveIndex(resetActiveIndex()), []);

  const isInside = useCallback((target: EventTarget | null) => {
    if (isNavigatingTabRef.current) return true;
    if (!target) return false;
    if (target === inputRef.current) return true;
    if (listRef.current?.contains(target as Node)) return true;
    return false;
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (!open || count === 0) return;
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
          if (!e.shiftKey) {
            // Tab from the search field focuses result 1
            e.preventDefault();
            setActiveIndex(0);
            isNavigatingTabRef.current = true;
            optionRefs.current[0]?.focus();
            isNavigatingTabRef.current = false;
          } else {
            // Shift+Tab moves backward (to previous form field before input).
            // Results close. Do NOT preventDefault so browser moves focus naturally.
            setActiveIndex(resetActiveIndex());
            onClose?.();
          }
          break;
        default:
          break;
      }
    },
    [open, count, activeIndex, onSelect, onClose],
  );

  const onOptionKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>, index: number) => {
      switch (e.key) {
        case 'Tab':
          if (e.shiftKey) {
            // Shift+Tab moves backward
            e.preventDefault();
            if (index > 0) {
              const prevIndex = index - 1;
              setActiveIndex(prevIndex);
              isNavigatingTabRef.current = true;
              optionRefs.current[prevIndex]?.focus();
              isNavigatingTabRef.current = false;
            } else {
              // At result 1 (index 0), Shift+Tab moves back to the search field input
              setActiveIndex(resetActiveIndex());
              isNavigatingTabRef.current = true;
              inputRef.current?.focus();
              isNavigatingTabRef.current = false;
            }
          } else {
            // Tab moves forward through visible results
            if (index < count - 1) {
              e.preventDefault();
              const nextIndex = index + 1;
              setActiveIndex(nextIndex);
              isNavigatingTabRef.current = true;
              optionRefs.current[nextIndex]?.focus();
              isNavigatingTabRef.current = false;
            } else {
              // Tab after the last result reaches the next normal form field!
              // Do NOT call preventDefault: browser naturally moves to next field.
              setActiveIndex(resetActiveIndex());
            }
          }
          break;
        case 'Enter':
          // Enter selects the focused result
          e.preventDefault();
          onSelect(index);
          break;
        case 'Escape':
          // Escape closes the results and returns focus to input
          e.preventDefault();
          setActiveIndex(resetActiveIndex());
          onClose?.();
          inputRef.current?.focus();
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (index < count - 1) {
            const nextIndex = index + 1;
            setActiveIndex(nextIndex);
            isNavigatingTabRef.current = true;
            optionRefs.current[nextIndex]?.focus();
            isNavigatingTabRef.current = false;
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (index > 0) {
            const prevIndex = index - 1;
            setActiveIndex(prevIndex);
            isNavigatingTabRef.current = true;
            optionRefs.current[prevIndex]?.focus();
            isNavigatingTabRef.current = false;
          } else {
            // At result 1 (index 0), ArrowUp moves focus back to input
            setActiveIndex(resetActiveIndex());
            isNavigatingTabRef.current = true;
            inputRef.current?.focus();
            isNavigatingTabRef.current = false;
          }
          break;
        default:
          break;
      }
    },
    [count, onSelect, onClose],
  );

  const inputProps = {
    ref: (el: HTMLInputElement | null) => {
      inputRef.current = el;
    },
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
    tabIndex: 0,
    'aria-selected': index === activeIndex,
    'data-active': index === activeIndex ? true : undefined,
    ref: (el: HTMLElement | null) => {
      optionRefs.current[index] = el;
    },
    // Keep input focus so the click selects before any blur closes the list.
    onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault(),
    onClick: () => onSelect(index),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => onOptionKeyDown(e, index),
    onFocus: () => {
      setActiveIndex(index);
    },
  });

  return {
    activeIndex,
    setActiveIndex,
    reset,
    listId,
    inputProps,
    listProps,
    getOptionProps,
    inputRef,
    listRef,
    isInside,
  };
}
