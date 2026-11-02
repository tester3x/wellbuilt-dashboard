import { selectChatMessageText } from '@/lib/chatTextSelection';
import type { ChatMessage } from './ChatTypes';
import { formatChatTime } from './ChatTypes';

/** Server-owned recipient snapshot; opening a notice never creates a receipt. */
export function AnnouncementMessage({ message }: { message: ChatMessage }) {
  const recipients = message.receiptSummary || [];
  const pending = recipients.filter(row => !row.acknowledgedAt);
  return <article onContextMenu={selectChatMessageText} className="w-full border border-[#FFD700]/40 rounded-xl p-3 bg-[#211d08] text-white" data-announcement={message.id}>
    <p className="text-xs text-[#FFD700] font-semibold">{message.senderName} · Dispatch announcement</p>
    <p data-chat-message-text className="whitespace-pre-wrap break-words select-text text-sm my-2">{message.text}</p>
    <p className="text-xs text-gray-400">{formatChatTime(message.timestamp)}{message.pending ? ' · Sending…' : ''}</p>
    {!message.pending && <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-[#FFD700]">{recipients.length - pending.length}/{recipients.length} acknowledged · {pending.length} pending</summary>
      <p className="mt-2 text-gray-300">Recipients include drivers who are off shift.</p>
      <ul className="mt-2 space-y-1">{recipients.map(row => <li key={row.driverId} className={row.acknowledgedAt ? 'text-green-400' : 'text-amber-300'}>
        {row.name} — {row.acknowledgedAt ? `Acknowledged ${formatChatTime(row.acknowledgedAt)}` : 'Pending acknowledgement'}
      </li>)}</ul>
    </details>}
  </article>;
}
