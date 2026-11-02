/** Prepare a message for the browser's own context menu. Do not cancel the
 * event or replace that menu with an alert/custom menu/clipboard write. */
export function selectChatMessageText(event: { currentTarget: HTMLElement; target: EventTarget | null }): void {
  const bubble = event.currentTarget;
  const target = event.target;
  if (target instanceof Element && target.closest('a, img, input, textarea, button')) return;
  const body = bubble.querySelector<HTMLElement>('[data-chat-message-text]');
  const selection = bubble.ownerDocument.getSelection();
  if (!body || !selection || !body.textContent?.trim()) return;
  // Keep a deliberately selected word/portion when right-clicked within it.
  if (!selection.isCollapsed && body.contains(selection.anchorNode) && body.contains(selection.focusNode)) return;
  const range = bubble.ownerDocument.createRange();
  range.selectNodeContents(body);
  selection.removeAllRanges();
  selection.addRange(range);
}
