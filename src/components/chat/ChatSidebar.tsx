'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  addDoc,
  updateDoc,
  doc,
  Timestamp,
  limit,
} from 'firebase/firestore';
import { getFirestoreDb } from '@/lib/firebase';
import {
  ChatThread,
  ChatMessage,
  ThreadType,
  userParticipantId,
  isThreadUnread,
  threadTypeLabel,
  threadTypeIcon,
  formatChatTime,
} from './ChatTypes';

// ── Filter chips ────────────────────────────────────────────────────────────

type FilterKey = 'all' | ThreadType;

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'shift', label: 'Shift' },
  { key: 'well', label: 'Wells' },
  { key: 'project', label: 'Projects' },
  { key: 'service_group', label: 'Crew' },
  { key: 'direct', label: 'Direct' },
];

// ── Thread type icons (inline SVG) ──────────────────────────────────────────

function ThreadIcon({ type }: { type: ThreadType }) {
  const iconName = threadTypeIcon(type);
  const cls = 'w-5 h-5 text-[#FFD700] flex-shrink-0';

  switch (iconName) {
    case 'briefcase':
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2" />
        </svg>
      );
    case 'users':
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      );
    case 'wrench':
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      );
    case 'droplet':
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 21c-4.418 0-8-3.358-8-7.5 0-4.142 8-11.5 8-11.5s8 7.358 8 11.5c0 4.142-3.582 7.5-8 7.5z" />
        </svg>
      );
    default: // chat
      return (
        <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      );
  }
}

// ── Props ───────────────────────────────────────────────────────────────────

interface ChatSidebarProps {
  visible: boolean;
  onClose: () => void;
  userId: string;   // Firebase Auth uid
  companyId: string; // hauler companyId, or '' for WB admin
  onUnreadChange?: (count: number) => void;
}

// ── Component ───────────────────────────────────────────────────────────────

export function ChatSidebar({ visible, onClose, userId, companyId, onUnreadChange }: ChatSidebarProps) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const myParticipantId = userParticipantId(userId);

  // ── Thread subscription ─────────────────────────────────────────────────
  useEffect(() => {
    // userId must be a real Firebase Auth uid. Empty string (pre-auth) or
    // any 'dev' fallback would trigger a stale cached snapshot followed by
    // re-subscription once auth resolves, flashing the thread list.
    if (!visible || !userId || userId === 'dev') return;

    const firestore = getFirestoreDb();
    const constraints = [
      where('participants', 'array-contains', myParticipantId),
      where('status', '==', 'active'),
      orderBy('updatedAt', 'desc'),
      limit(100),
    ];

    // Company scoping: if companyId set, filter by it
    if (companyId) {
      constraints.splice(0, 0, where('companyId', '==', companyId));
    }

    const q = query(collection(firestore, 'chat_threads'), ...constraints);

    const unsub = onSnapshot(q, (snap) => {
      const list: ChatThread[] = [];
      snap.forEach((d) => {
        list.push({ id: d.id, ...d.data() } as ChatThread);
      });
      setThreads(list);
      // Report unread count to parent
      if (onUnreadChange) {
        const unread = list.filter(t => isThreadUnread(t, myParticipantId)).length;
        onUnreadChange(unread);
      }
    }, (err) => {
      console.warn('[Chat] Thread listener error:', err.message);
    });

    return () => unsub();
  }, [visible, userId, companyId, myParticipantId]);

  // ── Message subscription for selected thread ────────────────────────────
  useEffect(() => {
    if (!selectedThreadId) {
      setMessages([]);
      return;
    }

    const firestore = getFirestoreDb();
    const q = query(
      collection(firestore, 'chat_threads', selectedThreadId, 'messages'),
      orderBy('timestamp', 'asc'),
      limit(200),
    );

    const unsub = onSnapshot(q, (snap) => {
      const list: ChatMessage[] = [];
      snap.forEach((d) => {
        list.push({ id: d.id, ...d.data() } as ChatMessage);
      });
      setMessages(list);
    }, (err) => {
      console.warn('[Chat] Message listener error:', err.message);
    });

    return () => unsub();
  }, [selectedThreadId]);

  // ── Mark thread as read when selected ───────────────────────────────────
  useEffect(() => {
    if (!selectedThreadId) return;
    const firestore = getFirestoreDb();
    const threadRef = doc(firestore, 'chat_threads', selectedThreadId);
    updateDoc(threadRef, {
      [`lastRead.${myParticipantId}`]: Timestamp.now(),
    }).catch(() => { /* ignore permission errors */ });
  }, [selectedThreadId, messages.length, myParticipantId]);

  // ── Auto-scroll to bottom on new messages ───────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // ── Focus input when thread is selected ─────────────────────────────────
  useEffect(() => {
    if (selectedThreadId) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [selectedThreadId]);

  // ── Close on outside click ──────────────────────────────────────────────
  useEffect(() => {
    if (!visible) return;
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [visible, onClose]);

  // ── Close on Escape ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedThreadId) {
          setSelectedThreadId(null);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [visible, selectedThreadId, onClose]);

  // ── Send message ────────────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !selectedThreadId) return;

    setInputText('');
    const firestore = getFirestoreDb();
    const now = Timestamp.now();

    // Write message to subcollection
    await addDoc(collection(firestore, 'chat_threads', selectedThreadId, 'messages'), {
      text,
      senderId: myParticipantId,
      senderName: 'Admin', // Dashboard users are admin
      timestamp: now,
      type: 'text',
    });

    // Update thread's lastMessage + updatedAt
    const threadRef = doc(firestore, 'chat_threads', selectedThreadId);
    await updateDoc(threadRef, {
      lastMessage: {
        text,
        senderId: myParticipantId,
        senderName: 'Admin',
        timestamp: now,
        type: 'text',
      },
      updatedAt: now,
      [`lastRead.${myParticipantId}`]: now,
    });
  }, [inputText, selectedThreadId, myParticipantId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── Filtered threads ────────────────────────────────────────────────────
  const filteredThreads = filter === 'all'
    ? threads
    : threads.filter((t) => t.type === filter);

  const selectedThread = threads.find((t) => t.id === selectedThreadId) || null;

  if (!visible) return null;

  return (
    <div
      ref={panelRef}
      className="fixed top-0 right-0 h-full w-[420px] bg-[#0a0a0a] border-l border-gray-700 shadow-2xl z-50 flex flex-col"
      style={{ animation: 'slideInRight 0.2s ease-out' }}
    >
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 bg-[#111]">
        {selectedThread ? (
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setSelectedThreadId(null)}
              className="text-gray-400 hover:text-white transition-colors flex-shrink-0"
              title="Back to threads"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <ThreadIcon type={selectedThread.type} />
            <div className="min-w-0">
              <h3 className="text-white text-sm font-semibold truncate">{selectedThread.title}</h3>
              {selectedThread.subtitle && (
                <p className="text-gray-500 text-xs truncate">{selectedThread.subtitle}</p>
              )}
            </div>
          </div>
        ) : (
          <h3 className="text-white text-sm font-semibold">Messages</h3>
        )}
        <button
          onClick={() => window.open('/chat/', '_blank')}
          className="text-gray-400 hover:text-[#FFD700] transition-colors flex-shrink-0 ml-2"
          title="Open chat in new tab"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </button>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white transition-colors flex-shrink-0 ml-2"
          title="Close"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* ── Thread List View ──────────────────────────────────────────── */}
      {!selectedThread && (
        <>
          {/* Filter chips */}
          <div className="flex gap-1.5 px-3 py-2 border-b border-gray-800 overflow-x-auto flex-shrink-0">
            {FILTERS.map((f) => {
              const isActive = filter === f.key;
              return (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? 'bg-[#FFD700] text-black'
                      : 'bg-[#1a1a1a] text-gray-400 hover:text-white hover:bg-[#252525]'
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          {/* Thread list */}
          <div className="flex-1 overflow-y-auto">
            {filteredThreads.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-500">
                <svg className="w-10 h-10 mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <p className="text-sm">No conversations</p>
              </div>
            ) : (
              filteredThreads.map((thread) => {
                const unread = isThreadUnread(thread, myParticipantId);
                return (
                  <button
                    key={thread.id}
                    onClick={() => setSelectedThreadId(thread.id)}
                    className={`w-full text-left px-4 py-3 border-b border-gray-800/50 hover:bg-[#1a1a1a] transition-colors flex items-start gap-3 ${
                      unread ? 'bg-[#111]' : ''
                    }`}
                  >
                    {/* Icon */}
                    <div className="mt-0.5">
                      <ThreadIcon type={thread.type} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-sm truncate ${unread ? 'text-white font-semibold' : 'text-gray-300 font-medium'}`}>
                          {thread.title}
                        </span>
                        <span className="text-gray-500 text-xs flex-shrink-0">
                          {formatChatTime(thread.lastMessage?.timestamp)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-0.5">
                        <p className={`text-xs truncate ${unread ? 'text-gray-300' : 'text-gray-500'}`}>
                          {thread.lastMessage
                            ? thread.lastMessage.type === 'system'
                              ? thread.lastMessage.text
                              : `${thread.lastMessage.senderName}: ${thread.lastMessage.text}`
                            : 'No messages yet'}
                        </p>
                        {unread && (
                          <span className="w-2.5 h-2.5 rounded-full bg-[#FFD700] flex-shrink-0" />
                        )}
                      </div>
                      {thread.subtitle && (
                        <p className="text-gray-600 text-[10px] mt-0.5 truncate">{thread.subtitle}</p>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </>
      )}

      {/* ── Message View ──────────────────────────────────────────────── */}
      {selectedThread && (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
            {messages.length === 0 && (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                No messages yet
              </div>
            )}
            {messages.map((msg) => {
              const isMine = msg.senderId === myParticipantId;
              const isSystem = msg.type === 'system';

              if (isSystem) {
                return (
                  <div key={msg.id} className="flex justify-center my-2">
                    <div className="bg-[#1a1a1a] border border-gray-700 rounded-lg px-3 py-1.5 max-w-[85%]">
                      <p className="text-gray-400 text-xs text-center">{msg.text}</p>
                      <p className="text-gray-600 text-[10px] text-center mt-0.5">
                        {formatChatTime(msg.timestamp)}
                      </p>
                    </div>
                  </div>
                );
              }

              return (
                <div key={msg.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[75%] rounded-2xl px-3.5 py-2 ${
                      isMine
                        ? 'bg-[#FFD700] text-black rounded-br-sm'
                        : 'bg-[#1a1a1a] text-gray-200 rounded-bl-sm'
                    }`}
                  >
                    {!isMine && (
                      <p className={`text-[10px] font-semibold mb-0.5 ${isMine ? 'text-black/60' : 'text-[#FFD700]'}`}>
                        {msg.senderName}
                      </p>
                    )}
                    {(msg as any).photoUrl ? (
                      <a href={(msg as any).photoUrl} target="_blank" rel="noopener noreferrer">
                        <img
                          src={(msg as any).photoUrl}
                          alt="Photo"
                          className="rounded-lg max-w-full max-h-48 cursor-pointer hover:opacity-80 transition-opacity"
                        />
                      </a>
                    ) : (
                      <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
                    )}
                    <p className={`text-[10px] mt-1 text-right ${isMine ? 'text-black/50' : 'text-gray-500'}`}>
                      {formatChatTime(msg.timestamp)}
                    </p>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-gray-700 px-3 py-2 bg-[#111] flex items-center gap-2 flex-shrink-0">
            <input
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              className="flex-1 bg-[#1a1a1a] border border-gray-700 rounded-full px-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#FFD700] transition-colors"
            />
            <button
              onClick={sendMessage}
              disabled={!inputText.trim()}
              className="w-9 h-9 rounded-full bg-[#FFD700] hover:bg-[#ffe44d] disabled:bg-gray-700 disabled:text-gray-500 text-black flex items-center justify-center transition-colors flex-shrink-0"
              title="Send"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </>
      )}

      {/* ── Slide-in animation ────────────────────────────────────────── */}
      <style jsx>{`
        @keyframes slideInRight {
          from {
            transform: translateX(100%);
          }
          to {
            transform: translateX(0);
          }
        }
      `}</style>
    </div>
  );
}
