/**
 * Shared autocomplete / combobox navigation core — pure and node-testable.
 *
 * This is the ONE implementation of the keyboard/scroll contract used by every
 * Job Builder autocomplete field (well, pickup, drop-off, SWD, operator, project
 * well). It is deliberately DOM-free so the visibility guarantee can be proven with
 * plain numbers: given option offsets and the container viewport, the active option
 * is always scrolled fully into view using nearest-edge scrolling, and ONLY the
 * container scrollTop changes (never the page/modal).
 */

export interface OptionMetrics {
  /** Option's offsetTop within the scroll container's content. */
  offsetTop: number;
  offsetHeight: number;
}
export interface ViewportMetrics {
  /** Current container scrollTop. */
  scrollTop: number;
  /** Container's visible height (clientHeight). */
  clientHeight: number;
}

/**
 * The next active index for an Arrow key. Clamped (no wrap) so navigation never
 * jumps end-to-end: the first Arrow (from none, -1) highlights the first row;
 * ArrowDown past the last row stays on the last; ArrowUp past the first stays first.
 * An empty list has no active option (-1).
 */
export function nextActiveIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return 0; // first navigation highlights the first row
  return Math.max(0, Math.min(count - 1, current + dir));
}

/**
 * The safe active index whenever the query changes or the list is (re)opened:
 * ALWAYS none (-1). We never auto-restore a prior highlight, so a stale or
 * now-invisible highlight can never survive a query change or a close/reopen.
 */
export function resetActiveIndex(): number {
  return -1;
}

/**
 * Defensive clamp for when the SAME open list changes size in place (e.g. async
 * results arrive and shrink the set) without a fresh query: keep a still-valid
 * highlight, drop it if it fell off the end, none when empty.
 */
export function reconcileActiveIndex(current: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return -1;
  return Math.min(current, count - 1);
}

/**
 * Nearest-edge container scrollTop that makes the active option fully visible.
 * If the option is above the viewport, align its top edge; if below, align its
 * bottom edge; otherwise leave the scroll unchanged (no unnecessary jump).
 */
export function scrollTopForOption(vp: ViewportMetrics, opt: OptionMetrics): number {
  const top = opt.offsetTop;
  const bottom = opt.offsetTop + opt.offsetHeight;
  if (top < vp.scrollTop) return top;
  if (bottom > vp.scrollTop + vp.clientHeight) return bottom - vp.clientHeight;
  return vp.scrollTop;
}

/** True when the option is fully within the container viewport. */
export function isOptionFullyVisible(vp: ViewportMetrics, opt: OptionMetrics): boolean {
  return opt.offsetTop >= vp.scrollTop && opt.offsetTop + opt.offsetHeight <= vp.scrollTop + vp.clientHeight;
}

/**
 * Whether an option at `index` is a selectable result (guards empty / loading /
 * no-result placeholder rows from becoming keyboard-active or Enter-selectable).
 */
export function isSelectableIndex(index: number, count: number): boolean {
  return count > 0 && index >= 0 && index < count;
}

/** Stable DOM id for an option, so the input can point aria-activedescendant at it. */
export function optionDomId(listId: string, index: number): string {
  return `${listId}-opt-${index}`;
}

export type TabTarget =
  | { type: 'option'; index: number }
  | { type: 'input' }
  | { type: 'next-field' }
  | { type: 'prev-field' };

/**
 * Pure state machine for Tab / Shift+Tab navigation in combobox.
 * - From input (current < 0): Tab -> option 0; Shift+Tab -> prev-field.
 * - From option (0 <= current < count):
 *   - Tab: next option if current < count - 1; next-field if current === count - 1.
 *   - Shift+Tab: prev option if current > 0; input if current === 0.
 * - When count <= 0: Tab -> next-field; Shift+Tab -> prev-field.
 */
export function tabNavigation(current: number, count: number, shift: boolean): TabTarget {
  if (count <= 0) {
    return shift ? { type: 'prev-field' } : { type: 'next-field' };
  }
  if (current < 0) {
    return shift ? { type: 'prev-field' } : { type: 'option', index: 0 };
  }
  if (shift) {
    if (current > 0) return { type: 'option', index: current - 1 };
    return { type: 'input' };
  } else {
    if (current < count - 1) return { type: 'option', index: current + 1 };
    return { type: 'next-field' };
  }
}
