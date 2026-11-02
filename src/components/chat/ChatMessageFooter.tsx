"use client";
import { useState } from 'react';
import { formatChatTime, type ChatMessage } from './ChatTypes';

/** Copy only this card's complete body; native text selection remains available. */
export function ChatMessageFooter({message, mine=false}: {message: ChatMessage; mine?: boolean}) {
  const [status,setStatus]=useState('');
  return <div className={`flex items-center justify-end gap-2 mt-1 text-[10px] ${mine ? 'text-black/60' : 'text-gray-400'}`}>
    <span>{formatChatTime(message.timestamp)}{message.pending ? ' · Sending…' : ''}</span>
    {!!message.text && <button type="button" title="Copy whole message" aria-label="Copy whole message"
      className="p-1 rounded hover:bg-white/10 focus-visible:outline focus-visible:outline-1"
      onClick={async()=>{try{await navigator.clipboard.writeText(message.text);setStatus('Copied');}catch{setStatus('Copy failed');}}}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>
    </button>}
    <span role="status" className="text-[10px]">{status}</span>
  </div>;
}
