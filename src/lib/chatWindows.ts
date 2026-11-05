import {CHAT_WINDOW_LAYOUT_KEY} from './chatWindowLayout';
/** Reuse the main workspace without navigating/reloading its existing grid. */
export function openChatWorkspace(newWindow = false): void {
  const target = newWindow ? `wellbuilt-chat-${crypto.randomUUID()}` : 'wellbuilt-chat-workspace';
  const chat = window.open('', target);
  if (!chat) return;
  if (chat.location.href === 'about:blank') {
    if(newWindow)try{chat.sessionStorage.setItem(CHAT_WINDOW_LAYOUT_KEY,JSON.stringify({scopes:{}}));}catch{}
    chat.location.replace('/chat/');
  }
  chat.focus();
}
