/**
 * Scroll the keyboard-active option fully into view within its OWN scroll container.
 *
 * Uses getBoundingClientRect so it is INDEPENDENT of the option's offsetParent. The
 * previous implementation used `option.offsetTop`, which is measured relative to the
 * nearest positioned ancestor: it worked only for the autocomplete lists that happen
 * to be `position: absolute` (their container is the offsetParent), but broke for the
 * Projects Well list, whose container is NOT positioned — there `offsetTop` was
 * relative to a far ancestor, so the computed scrollTop was wrong and the highlighted
 * row could move out of the visible dropdown. Rect math fixes this for every field.
 *
 * Nearest-edge: align the top edge if the option is above the viewport, the bottom
 * edge if below, otherwise leave it. ONLY the container's scrollTop is changed — the
 * page, modal, and Dispatch screen are never moved (no scrollIntoView, no window scroll).
 */
export function scrollActiveOptionIntoView(list: HTMLElement, opt: HTMLElement): void {
  const listRect = list.getBoundingClientRect();
  const optRect = opt.getBoundingClientRect();
  const viewTop = list.scrollTop;
  const viewH = list.clientHeight;
  // Option position relative to the container's scrollable (client) area.
  const optTop = optRect.top - listRect.top - list.clientTop + list.scrollTop;
  const optBottom = optTop + optRect.height;
  let desired = viewTop;
  if (optTop < viewTop) desired = optTop; // align to the top edge
  else if (optBottom > viewTop + viewH) desired = optBottom - viewH; // align to the bottom edge
  if (desired !== list.scrollTop) list.scrollTop = desired; // CONTAINER scroll only
}
