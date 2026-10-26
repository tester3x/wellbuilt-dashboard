'use client';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseAuth, getFirebaseFunctions } from './firebase';

const listeners = new Set<() => void>();
export const chatIntentId = () => crypto.randomUUID();
export async function staffChatCall(data: Record<string, unknown>): Promise<any> {
  const owner = getFirebaseAuth().currentUser;
  if (!owner) throw new Error('Sign in to use chat');
  const result = await httpsCallable(getFirebaseFunctions(), 'staffChat')(data);
  if (getFirebaseAuth().currentUser !== owner) throw new Error('Chat account changed');
  for (const refresh of listeners) refresh();
  return result.data;
}
/** Foreground reads with account and disposal fences; one request at a time. */
export function watchStaffChat(data: Record<string, unknown>, onRows: (rows: any[]) => void, onError?: (error: Error) => void, interval = 10000): () => void {
  let stopped = false, busy = false, timer: ReturnType<typeof setTimeout>;
  const owner = getFirebaseAuth().currentUser;
  const refresh = async () => {
    clearTimeout(timer);
    if (stopped || busy) return;
    if (getFirebaseAuth().currentUser !== owner) { onRows([]); return; }
    if (document.visibilityState === 'hidden') { timer = setTimeout(refresh, interval); return; }
    busy = true;
    try {
      void flushStaffChat();
      const result = await httpsCallable(getFirebaseFunctions(), 'staffChat')(data);
      if (!stopped && getFirebaseAuth().currentUser === owner) {
        const rows = (result.data as any).rows || [];
        if (data.action === 'messages' && owner) {
          const pending: Pending[] = JSON.parse(localStorage.getItem(queueKey(owner.uid)) || '[]');
          const known = new Set(rows.map((row: any) => row.clientId));
          onRows([...rows, ...pending.filter(row => row.threadId === data.threadId && !known.has(row.clientId)).map(row => ({ ...row,
            id: `c_${row.clientId}`, senderId: `user:${owner.uid}`, senderName: 'You', type: 'text', pending: true, timestamp: row.queuedAt }))]);
        } else onRows(rows);
      }
    } catch (e) { if (!stopped && getFirebaseAuth().currentUser === owner) onError?.(e instanceof Error ? e : new Error('Chat unavailable')); }
    finally { busy = false; if (!stopped) timer = setTimeout(refresh, interval); }
  };
  const signal = () => { void refresh(); };
  listeners.add(signal); document.addEventListener('visibilitychange', signal); signal();
  return () => { stopped = true; clearTimeout(timer); listeners.delete(signal); document.removeEventListener('visibilitychange', signal); };
}

/** Persist the exact send identity before attempting delivery. Failed responses
 * keep the same ID for automatic reconnect retries instead of duplicating it. */
type Pending = { clientId: string; threadId: string; text: string; companyId: string; queuedAt: string };
const queueKey = (uid: string) => `wb_staff_chat_v1:${uid}`;
let draining: Promise<void> | null = null;
export async function sendStaffChat(threadId: string, text: string, companyId: string): Promise<void> {
  const owner = getFirebaseAuth().currentUser;
  if (!owner) throw new Error('Sign in to send messages');
  const key = queueKey(owner.uid), rows: Pending[] = JSON.parse(localStorage.getItem(key) || '[]');
  rows.push({ threadId, text, companyId, clientId: chatIntentId(), queuedAt: new Date().toISOString() });
  localStorage.setItem(key, JSON.stringify(rows));
  void flushStaffChat();
}
export function flushStaffChat(): Promise<void> {
  if (draining) return draining;
  draining = (async () => {
    const owner = getFirebaseAuth().currentUser;
    if (!owner) return;
    const key = queueKey(owner.uid), pending: Pending[] = JSON.parse(localStorage.getItem(key) || '[]');
    for (const item of pending) {
      if (getFirebaseAuth().currentUser !== owner) break;
      try {
        const result = await staffChatCall({ ...item, action: 'send' });
        if (!result.ok || result.messageId !== `c_${item.clientId}`) break;
        const current: Pending[] = JSON.parse(localStorage.getItem(key) || '[]');
        localStorage.setItem(key, JSON.stringify(current.filter(row => row.clientId !== item.clientId)));
      } catch { break; }
    }
  })().finally(() => { draining = null; });
  return draining;
}
