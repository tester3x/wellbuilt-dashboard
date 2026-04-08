'use client';

// Full-screen Chat page — lives on monitor 2 for dispatch.
// Thread list left, multi-pane messages right. Always open, always live.
// Opened via window.open('/chat') from the Dashboard sidebar pop-out button.

import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { getFirestoreDb } from '@/lib/firebase';
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  addDoc,
  updateDoc,
  getDocs,
  doc,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { getFirebaseDatabase } from '@/lib/firebase';
import { ref, get } from 'firebase/database';
import {
  type ChatThread,
  type ChatMessage,
  type ThreadType,
  userParticipantId,
  isThreadUnread,
  threadTypeLabel,
  threadTypeIcon,
  formatChatTime,
} from '@/components/chat/ChatTypes';

type FilterKey = 'all' | ThreadType;

const FILTERS: { label: string; value: FilterKey }[] = [
  { label: 'All', value: 'all' },
  { label: 'Shifts', value: 'shift' },
  { label: 'Wells', value: 'well' },
  { label: 'Projects', value: 'project' },
  { label: 'Crew', value: 'service_group' },
  { label: 'Direct', value: 'direct' },
];

export default function ChatPage() {
  const { user } = useAuth();
  const myParticipantId = user?.uid ? userParticipantId(user.uid) : 'user:dev';
  const companyId = user?.companyId || '';

  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [openPanes, setOpenPanes] = useState<string[]>([]); // Up to 3 thread IDs
  const [paneMessages, setPaneMessages] = useState<Record<string, ChatMessage[]>>({});
  const [paneInputs, setPaneInputs] = useState<Record<string, string>>({});
  const [showDriverPicker, setShowDriverPicker] = useState(false);
  const [drivers, setDrivers] = useState<{ hash: string; name: string }[]>([]);
  const [driverSearch, setDriverSearch] = useState('');
  const paneEndRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Subscribe to thread list
  useEffect(() => {
    const db = getFirestoreDb();
    if (!db) return;

    const q = query(
      collection(db, 'chat_threads'),
      where('participants', 'array-contains', myParticipantId),
      where('status', '==', 'active'),
      orderBy('updatedAt', 'desc'),
    );

    const unsub = onSnapshot(q, (snap) => {
      const list: ChatThread[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() } as ChatThread));
      setThreads(list);
    });

    return () => unsub();
  }, [myParticipantId]);

  // Subscribe to messages for each open pane
  useEffect(() => {
    const db = getFirestoreDb();
    if (!db) return;

    const unsubs: (() => void)[] = [];
    for (const threadId of openPanes) {
      const q = query(
        collection(db, 'chat_threads', threadId, 'messages'),
        orderBy('timestamp', 'asc'),
        limit(100),
      );
      const unsub = onSnapshot(q, (snap) => {
        const msgs: ChatMessage[] = [];
        snap.forEach((d) => msgs.push({ id: d.id, ...d.data() } as ChatMessage));
        setPaneMessages((prev) => ({ ...prev, [threadId]: msgs }));
        // Auto-scroll
        setTimeout(() => paneEndRefs.current[threadId]?.scrollIntoView({ behavior: 'smooth' }), 50);
      });
      unsubs.push(unsub);

      // Mark as read
      updateDoc(doc(db, 'chat_threads', threadId), {
        [`lastRead.${myParticipantId}`]: serverTimestamp(),
      }).catch(() => {});
    }

    return () => unsubs.forEach((u) => u());
  }, [openPanes, myParticipantId]);

  // Open a thread pane (max 3)
  const openThread = useCallback((threadId: string) => {
    setOpenPanes((prev) => {
      if (prev.includes(threadId)) return prev;
      const next = [...prev, threadId];
      if (next.length > 3) next.shift(); // Drop oldest
      return next;
    });
    // Mark as read
    const db = getFirestoreDb();
    if (db) {
      updateDoc(doc(db, 'chat_threads', threadId), {
        [`lastRead.${myParticipantId}`]: serverTimestamp(),
      }).catch(() => {});
    }
  }, [myParticipantId]);

  // Close a pane
  const closePane = useCallback((threadId: string) => {
    setOpenPanes((prev) => prev.filter((id) => id !== threadId));
  }, []);

  // Send message in a pane
  const sendInPane = useCallback(async (threadId: string) => {
    const text = (paneInputs[threadId] || '').trim();
    if (!text) return;
    setPaneInputs((prev) => ({ ...prev, [threadId]: '' }));

    const db = getFirestoreDb();
    if (!db) return;

    const senderName = user?.displayName || 'Dispatch';
    const batch = writeBatch(db);
    const msgRef = doc(collection(db, 'chat_threads', threadId, 'messages'));
    batch.set(msgRef, {
      text,
      senderId: myParticipantId,
      senderName,
      timestamp: serverTimestamp(),
      type: 'text',
    });
    const threadRef = doc(db, 'chat_threads', threadId);
    batch.update(threadRef, {
      lastMessage: { text: text.substring(0, 100), senderId: myParticipantId, senderName, timestamp: serverTimestamp(), type: 'text' },
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  }, [paneInputs, myParticipantId, user]);

  // Load drivers for new message picker
  const loadDrivers = useCallback(async () => {
    try {
      const rtdb = getFirebaseDatabase();
      const snap = await get(ref(rtdb, 'drivers/approved'));
      if (!snap.exists()) return;
      const all = snap.val();
      const list: { hash: string; name: string }[] = [];
      for (const [hash, data] of Object.entries(all) as [string, any][]) {
        if (!data.active && data.active !== undefined) continue;
        const name = data.legalName || data.displayName || 'Driver';
        if (companyId && data.companyId && data.companyId !== companyId) continue;
        list.push({ hash, name });
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      setDrivers(list);
    } catch {}
  }, [companyId]);

  // Create direct thread with a driver
  const startDirectWithDriver = useCallback(async (driverHash: string, driverName: string) => {
    const db = getFirestoreDb();
    if (!db) return;
    const driverPid = `driver:${driverHash}`;
    const pair = [myParticipantId, driverPid].sort().join('_');

    // Check existing
    const existing = await getDocs(query(
      collection(db, 'chat_threads'),
      where('type', '==', 'direct'),
      where('directPair', '==', pair),
    ));
    if (!existing.empty) {
      openThread(existing.docs[0].id);
      setShowDriverPicker(false);
      return;
    }

    // Create new
    const senderName = user?.displayName || 'Dispatch';
    const now = serverTimestamp();
    const threadRef = await addDoc(collection(db, 'chat_threads'), {
      type: 'direct',
      companyId: companyId || '',
      directPair: pair,
      title: driverName,
      participants: [myParticipantId, driverPid],
      participantNames: { [myParticipantId]: senderName, [driverPid]: driverName },
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastRead: {},
    });
    openThread(threadRef.id);
    setShowDriverPicker(false);
  }, [myParticipantId, companyId, user, openThread]);

  // Filter threads
  const filteredThreads = filter === 'all' ? threads : threads.filter((t) => t.type === filter);
  const filteredDrivers = driverSearch
    ? drivers.filter(d => d.name.toLowerCase().includes(driverSearch.toLowerCase()))
    : drivers;

  // Get display title for thread
  const getTitle = (thread: ChatThread) => {
    if (thread.type === 'direct') {
      const otherId = thread.participants.find((p) => p !== myParticipantId);
      if (otherId && thread.participantNames?.[otherId]) return thread.participantNames[otherId];
    }
    return thread.title;
  };

  return (
    <div className="h-screen bg-[#0a0a0a] text-white flex">
      {/* Left: Thread List */}
      <div className="w-80 border-r border-gray-800 flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-800">
          <h1 className="text-xl font-bold text-[#FFD700] tracking-wide">WB Chat</h1>
          <p className="text-xs text-gray-500 mt-1">Dispatch Communications</p>
        </div>

        {/* Filter chips */}
        <div className="flex flex-wrap gap-1.5 px-3 py-2 border-b border-gray-800">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${
                filter === f.value
                  ? 'bg-[#FFD700]/20 border-[#FFD700] text-[#FFD700]'
                  : 'bg-[#111] border-gray-700 text-gray-400 hover:border-gray-500'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* New Message button */}
        <div className="px-3 py-2 border-b border-gray-800">
          <button
            onClick={() => { setShowDriverPicker(!showDriverPicker); if (!showDriverPicker) loadDrivers(); }}
            className="w-full py-2 rounded-lg bg-[#FFD700]/10 border border-[#FFD700]/30 text-[#FFD700] text-sm font-semibold hover:bg-[#FFD700]/20 transition-colors"
          >
            ✏️ New Message
          </button>
        </div>

        {/* Driver picker OR Thread list — not both competing for flex space */}
        {showDriverPicker ? (
          <div className="flex-1 overflow-y-auto bg-[#0d0d0d]">
            <input
              type="text"
              value={driverSearch}
              onChange={(e) => setDriverSearch(e.target.value)}
              placeholder="Search drivers..."
              className="w-full px-3 py-2 bg-transparent text-white text-sm placeholder-gray-500 border-b border-gray-800 focus:outline-none sticky top-0 bg-[#0d0d0d] z-10"
              autoFocus
            />
            {filteredDrivers.map((d) => (
              <div
                key={d.hash}
                onClick={() => { console.log('Clicked:', d.name); startDirectWithDriver(d.hash, d.name); }}
                className="w-full text-left px-3 py-3 text-sm text-gray-300 hover:bg-[#FFD700]/10 hover:text-white cursor-pointer transition-colors border-b border-gray-800/30"
                role="button"
              >
                {d.name}
              </div>
            ))}
            {filteredDrivers.length === 0 && (
              <p className="px-3 py-4 text-xs text-gray-600 text-center">No drivers found</p>
            )}
          </div>
        ) : (
        <div className="flex-1 overflow-y-auto">
          {filteredThreads.length === 0 && !showDriverPicker && (
            <div className="text-center py-12 text-gray-600">
              <p className="text-sm">No active conversations</p>
            </div>
          )}
          {filteredThreads.map((thread) => {
            const unread = isThreadUnread(thread, myParticipantId);
            const isOpen = openPanes.includes(thread.id);
            return (
              <button
                key={thread.id}
                onClick={() => openThread(thread.id)}
                className={`w-full text-left px-3 py-3 border-b border-gray-800/50 hover:bg-[#111] transition-colors ${
                  isOpen ? 'bg-[#111] border-l-2 border-l-[#FFD700]' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">{threadTypeIcon(thread.type)}</span>
                  <span className={`flex-1 text-sm truncate ${unread ? 'text-white font-bold' : 'text-gray-300'}`}>
                    {getTitle(thread)}
                  </span>
                  <span className={`text-[10px] ${unread ? 'text-[#FFD700]' : 'text-gray-600'}`}>
                    {formatChatTime(thread.lastMessage?.timestamp || thread.updatedAt)}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 ml-6">
                  <span className="text-xs text-gray-500 truncate flex-1">
                    {thread.lastMessage?.text || 'No messages'}
                  </span>
                  {unread && <span className="w-2 h-2 rounded-full bg-[#FFD700] flex-shrink-0" />}
                </div>
                <span className="text-[9px] text-gray-600 ml-6 uppercase tracking-wider">
                  {threadTypeLabel(thread.type)}
                </span>
              </button>
            );
          })}
        </div>
        )}
      </div>

      {/* Right: Message Panes (up to 3 side by side) */}
      <div className="flex-1 flex">
        {openPanes.length === 0 && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-4xl mb-4">💬</p>
              <p className="text-gray-500 text-lg">Select a conversation</p>
              <p className="text-gray-600 text-sm mt-2">Click a thread on the left to open it here</p>
              <p className="text-gray-700 text-xs mt-1">Up to 3 conversations side by side</p>
            </div>
          </div>
        )}

        {openPanes.map((threadId) => {
          const thread = threads.find((t) => t.id === threadId);
          const msgs = paneMessages[threadId] || [];
          const inputText = paneInputs[threadId] || '';

          return (
            <div key={threadId} className="flex-1 flex flex-col border-l border-gray-800 min-w-0">
              {/* Pane header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-[#0d0d0d]">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-white truncate">
                    {thread ? getTitle(thread) : 'Chat'}
                  </p>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">
                    {thread ? threadTypeLabel(thread.type) : ''}
                    {thread?.participantNames && ` · ${Object.keys(thread.participantNames).length} members`}
                  </p>
                </div>
                <button
                  onClick={() => closePane(threadId)}
                  className="text-gray-500 hover:text-white p-1 transition-colors"
                >
                  ✕
                </button>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {msgs.map((msg) => {
                  const isMine = msg.senderId === myParticipantId;
                  const isSystem = msg.type === 'system';
                  const isPhoto = msg.type === 'photo' && (msg as any).photoUrl;

                  if (isSystem) {
                    return (
                      <div key={msg.id} className="flex justify-center my-1">
                        <div className="bg-[#1a1a1a] border border-gray-700 rounded-lg px-3 py-1 max-w-[85%]">
                          <p className="text-gray-400 text-xs text-center">{msg.text}</p>
                          <p className="text-gray-600 text-[10px] text-center">{formatChatTime(msg.timestamp)}</p>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={msg.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 ${
                        isMine ? 'bg-[#FFD700] text-black rounded-br-sm' : 'bg-[#1a1a1a] text-gray-200 rounded-bl-sm'
                      }`}>
                        {!isMine && (
                          <p className={`text-[10px] font-semibold mb-0.5 ${isMine ? 'text-black/60' : 'text-[#FFD700]'}`}>
                            {msg.senderName}
                          </p>
                        )}
                        {isPhoto ? (
                          <a href={(msg as any).photoUrl} target="_blank" rel="noopener noreferrer">
                            <img src={(msg as any).photoUrl} alt="Photo" className="rounded-lg max-w-full max-h-48 cursor-pointer hover:opacity-80" />
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
                <div ref={(el) => { paneEndRefs.current[threadId] = el; }} />
              </div>

              {/* Input */}
              <div className="flex items-end gap-2 px-3 py-2 border-t border-gray-800 bg-[#0d0d0d]">
                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setPaneInputs((prev) => ({ ...prev, [threadId]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendInPane(threadId); } }}
                  placeholder="Message..."
                  className="flex-1 bg-[#1a1a1a] border border-gray-700 rounded-full px-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#FFD700]/50"
                />
                <button
                  onClick={() => sendInPane(threadId)}
                  disabled={!inputText.trim()}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                    inputText.trim() ? 'bg-[#FFD700] text-black' : 'bg-gray-700 text-gray-500'
                  }`}
                >
                  ➤
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
