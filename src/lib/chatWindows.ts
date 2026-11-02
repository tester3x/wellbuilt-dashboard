/** Reuse the main workspace without navigating/reloading its existing grid. */
export function openChatWorkspace(newWindow = false): void {
  const target = newWindow ? `wellbuilt-chat-${crypto.randomUUID()}` : 'wellbuilt-chat-workspace';
  const chat = window.open('', target);
  if (!chat) return;
  if (chat.location.href === 'about:blank') chat.location.replace('/chat/');
  chat.focus();
}
