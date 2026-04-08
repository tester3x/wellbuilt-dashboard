'use client';

// Full-screen Chat page — lives on monitor 2+ for dispatch.
// Monitor Profiles: each monitor gets a saved config with locked driver positions.
// Opened via window.open('/chat?profile=north-crew') from Dashboard.

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
  getDoc,
  setDoc,
  deleteDoc,
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

// --- Types ---

type FilterKey = 'all' | 'archived' | ThreadType;

interface SlotAssignment {
  driverHash?: string;
  driverName?: string;
  threadId?: string;   // for group chats — slot holds a specific thread
  threadTitle?: string;
}

interface MonitorProfile {
  id: string;
  name: string;
  companyId: string;
  gridLayout: string; // "3x2"
  threadType?: FilterKey; // 'direct' | 'shift' | 'well' | 'project' | 'service_group' | 'all'
  slots: (SlotAssignment | null)[]; // positional
  createdBy: string;
}

// --- Constants ---

const FILTERS: { label: string; value: FilterKey }[] = [
  { label: 'All', value: 'all' },
  { label: 'Shifts', value: 'shift' },
  { label: 'Wells', value: 'well' },
  { label: 'Projects', value: 'project' },
  { label: 'Crew', value: 'service_group' },
  { label: 'Direct', value: 'direct' },
  { label: 'Archived', value: 'archived' },
];

const GRID_LAYOUTS = [
  { label: '1x1', cols: 1, rows: 1 },
  { label: '2x1', cols: 2, rows: 1 },
  { label: '3x1', cols: 3, rows: 1 },
  { label: '2x2', cols: 2, rows: 2 },
  { label: '3x2', cols: 3, rows: 2 },
  { label: '4x2', cols: 4, rows: 2 },
  { label: '3x3', cols: 3, rows: 3 },
  { label: '4x3', cols: 4, rows: 3 },
  { label: '5x3', cols: 5, rows: 3 },
  { label: '6x3', cols: 6, rows: 3 },
];

export default function ChatPage() {
  const { user } = useAuth();
  const myParticipantId = user?.uid ? userParticipantId(user.uid) : 'user:dev';
  const companyId = user?.companyId || '';

  // --- State ---
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [paneMessages, setPaneMessages] = useState<Record<string, ChatMessage[]>>({});
  const [paneInputs, setPaneInputs] = useState<Record<string, string>>({});
  const [showDriverPicker, setShowDriverPicker] = useState(false);
  const [showGroupCreator, setShowGroupCreator] = useState(false);
  const [drivers, setDrivers] = useState<{ hash: string; name: string; companyId?: string }[]>([]);
  const [driverSearch, setDriverSearch] = useState('');
  const [groupName, setGroupName] = useState('');
  const [groupType, setGroupType] = useState<ThreadType>('service_group');
  const [groupMembers, setGroupMembers] = useState<{ hash: string; name: string }[]>([]);
  const [groupBroadcast, setGroupBroadcast] = useState(false);
  const [managingThreadId, setManagingThreadId] = useState<string | null>(null);
  const paneEndRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Profile state
  const [profiles, setProfiles] = useState<MonitorProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<MonitorProfile | null>(null);
  const [setupMode, setSetupMode] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false); // unused, kept for compat
  const [newProfileName, setNewProfileName] = useState('');
  const [slotPickerIndex, setSlotPickerIndex] = useState<number | null>(null);

  // Grid from profile or default
  const gridLayout = activeProfile
    ? GRID_LAYOUTS.find((l) => l.label === activeProfile.gridLayout) || GRID_LAYOUTS[3]
    : GRID_LAYOUTS[3];
  const gridCols = gridLayout.cols;
  const gridRows = gridLayout.rows;
  const maxPanes = gridCols * gridRows;
  const maxPanesRef = useRef(maxPanes);
  maxPanesRef.current = maxPanes;

  // Slots from profile (or empty)
  const slots: (SlotAssignment | null)[] = activeProfile?.slots || Array(maxPanes).fill(null);

  // Map driver hashes to thread IDs — computed inline so it's always fresh
  const driverThreadMap: Record<string, string> = {};
  for (const t of threads) {
    if (t.type !== 'direct' || t.status === 'archived') continue;
    const driverPid = t.participants.find((p) => p.startsWith('driver:'));
    if (driverPid) driverThreadMap[driverPid.replace('driver:', '')] = t.id;
  }

  // Build openPanes from profile slots — supports both driver slots and thread slots
  const openPanes = slots.slice(0, maxPanes).map((slot) => {
    if (!slot) return null;
    if (slot.threadId) return slot.threadId; // Group chat slot
    if (slot.driverHash) return driverThreadMap[slot.driverHash] || null;
    return null;
  });

  // --- Load profiles from Firestore ---
  useEffect(() => {
    const db = getFirestoreDb();
    if (!db) return;
    const q = query(collection(db, 'chat_monitors'), orderBy('name'));
    const unsub = onSnapshot(q, (snap) => {
      const list: MonitorProfile[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() } as MonitorProfile));
      setProfiles(list);
    });
    return () => unsub();
  }, []);

  // Keep activeProfile in sync with live Firestore data
  useEffect(() => {
    if (profiles.length === 0) return;
    const profileId = activeProfile?.id || new URLSearchParams(window.location.search).get('profile') || localStorage.getItem('wb-chat-profile');
    if (profileId) {
      const found = profiles.find((p) => p.id === profileId || p.name.toLowerCase().replace(/\s+/g, '-') === profileId);
      if (found) {
        setActiveProfile(found);
        localStorage.setItem('wb-chat-profile', found.id);
      }
    }
  }, [profiles]);

  // --- Subscribe to thread list ---
  useEffect(() => {
    const db = getFirestoreDb();
    if (!db) return;
    const q = query(
      collection(db, 'chat_threads'),
      where('participants', 'array-contains', myParticipantId),
      orderBy('updatedAt', 'desc'),
    );
    const unsub = onSnapshot(q, (snap) => {
      const list: ChatThread[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() } as ChatThread));
      setThreads(list);
    });
    return () => unsub();
  }, [myParticipantId]);

  // --- Subscribe to messages for open panes ---
  const activeThreadIds = openPanes.filter(Boolean) as string[];
  useEffect(() => {
    const db = getFirestoreDb();
    if (!db) return;
    const unsubs: (() => void)[] = [];
    for (const threadId of activeThreadIds) {
      const q = query(
        collection(db, 'chat_threads', threadId, 'messages'),
        orderBy('timestamp', 'asc'),
        limit(100),
      );
      const unsub = onSnapshot(q, (snap) => {
        const msgs: ChatMessage[] = [];
        snap.forEach((d) => msgs.push({ id: d.id, ...d.data() } as ChatMessage));
        setPaneMessages((prev) => ({ ...prev, [threadId]: msgs }));
        setTimeout(() => paneEndRefs.current[threadId]?.scrollIntoView({ behavior: 'smooth' }), 50);
      });
      unsubs.push(unsub);
      updateDoc(doc(db, 'chat_threads', threadId), {
        [`lastRead.${myParticipantId}`]: serverTimestamp(),
      }).catch(() => {});
    }
    return () => unsubs.forEach((u) => u());
  }, [activeThreadIds.join(','), myParticipantId]);

  // --- Profile CRUD ---
  const createProfile = useCallback(async (name: string, layout: string) => {
    const db = getFirestoreDb();
    if (!db || !name.trim()) return;
    const layoutObj = GRID_LAYOUTS.find((l) => l.label === layout) || GRID_LAYOUTS[3];
    const slotCount = layoutObj.cols * layoutObj.rows;
    const ref = await addDoc(collection(db, 'chat_monitors'), {
      name: name.trim(),
      companyId: companyId || '',
      gridLayout: layout,
      threadType: 'direct',
      slots: Array(slotCount).fill(null),
      createdBy: myParticipantId,
    });
    setActiveProfile({ id: ref.id, name: name.trim(), companyId: companyId || '', gridLayout: layout, threadType: 'direct', slots: Array(slotCount).fill(null), createdBy: myParticipantId });
    localStorage.setItem('wb-chat-profile', ref.id);
    setNewProfileName('');
    // Stay open so user can pick grid size + assign drivers
    setSetupMode(true);
  }, [companyId, myParticipantId]);

  const saveProfileType = useCallback(async (type: FilterKey) => {
    if (!activeProfile) return;
    const db = getFirestoreDb();
    if (!db) return;
    await updateDoc(doc(db, 'chat_monitors', activeProfile.id), { threadType: type });
    setActiveProfile({ ...activeProfile, threadType: type });
  }, [activeProfile]);

  const saveProfileSlots = useCallback(async (newSlots: (SlotAssignment | null)[]) => {
    if (!activeProfile) return;
    const db = getFirestoreDb();
    if (!db) return;
    await updateDoc(doc(db, 'chat_monitors', activeProfile.id), { slots: newSlots });
    setActiveProfile({ ...activeProfile, slots: newSlots });
  }, [activeProfile]);

  const saveProfileLayout = useCallback(async (layout: string) => {
    if (!activeProfile) return;
    const db = getFirestoreDb();
    if (!db) return;
    const layoutObj = GRID_LAYOUTS.find((l) => l.label === layout) || GRID_LAYOUTS[3];
    const slotCount = layoutObj.cols * layoutObj.rows;
    // Resize slots array — keep existing assignments, pad or trim
    const newSlots = Array(slotCount).fill(null).map((_, i) => activeProfile.slots[i] || null);
    await updateDoc(doc(db, 'chat_monitors', activeProfile.id), { gridLayout: layout, slots: newSlots });
    setActiveProfile({ ...activeProfile, gridLayout: layout, slots: newSlots });
  }, [activeProfile]);

  const deleteProfile = useCallback(async (profileId: string) => {
    const db = getFirestoreDb();
    if (!db) return;
    await deleteDoc(doc(db, 'chat_monitors', profileId));
    if (activeProfile?.id === profileId) {
      setActiveProfile(null);
      localStorage.removeItem('wb-chat-profile');
    }
  }, [activeProfile]);

  // --- Assign driver or thread to slot ---
  const assignSlot = useCallback((index: number, assignment: SlotAssignment | null) => {
    const newSlots = [...slots];
    while (newSlots.length <= index) newSlots.push(null);
    newSlots[index] = assignment;
    saveProfileSlots(newSlots);
    setSlotPickerIndex(null);
  }, [slots, saveProfileSlots]);

  // --- Archive thread ---
  const archiveThread = useCallback(async (threadId: string) => {
    const db = getFirestoreDb();
    if (!db) return;
    await updateDoc(doc(db, 'chat_threads', threadId), { status: 'archived' });
  }, []);

  // --- Send message ---
  const sendInPane = useCallback(async (threadId: string) => {
    const text = (paneInputs[threadId] || '').trim();
    if (!text) return;
    setPaneInputs((prev) => ({ ...prev, [threadId]: '' }));
    const db = getFirestoreDb();
    if (!db) return;
    const senderName = user?.displayName || 'Dispatch';
    const batch = writeBatch(db);
    const msgRef = doc(collection(db, 'chat_threads', threadId, 'messages'));
    batch.set(msgRef, { text, senderId: myParticipantId, senderName, timestamp: serverTimestamp(), type: 'text' });
    const threadRef = doc(db, 'chat_threads', threadId);
    batch.update(threadRef, {
      lastMessage: { text: text.substring(0, 100), senderId: myParticipantId, senderName, timestamp: serverTimestamp(), type: 'text' },
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  }, [paneInputs, myParticipantId, user]);

  // --- Start chat with driver (creates thread if needed, returns thread ID) ---
  const ensureDriverThread = useCallback(async (driverHash: string, driverName: string, driverCompanyId?: string): Promise<string | null> => {
    const db = getFirestoreDb();
    if (!db) return null;
    const driverPid = `driver:${driverHash}`;
    const pair = [myParticipantId, driverPid].sort().join('_');
    const existing = await getDocs(query(
      collection(db, 'chat_threads'),
      where('type', '==', 'direct'),
      where('directPair', '==', pair),
    ));
    if (!existing.empty) {
      const existingDoc = existing.docs[0];
      // Reactivate if archived
      if (existingDoc.data().status === 'archived') {
        await updateDoc(doc(db, 'chat_threads', existingDoc.id), { status: 'active', updatedAt: serverTimestamp() });
      }
      return existingDoc.id;
    }
    const senderName = user?.displayName || 'Dispatch';
    const now = serverTimestamp();
    const threadRef = await addDoc(collection(db, 'chat_threads'), {
      type: 'direct',
      companyId: companyId || driverCompanyId || '',
      directPair: pair,
      title: driverName,
      participants: [myParticipantId, driverPid],
      participantNames: { [myParticipantId]: senderName, [driverPid]: driverName },
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastRead: {},
    });
    return threadRef.id;
  }, [myParticipantId, companyId, user]);

  // --- Create group thread ---
  const createGroupThread = useCallback(async () => {
    const db = getFirestoreDb();
    if (!db || !groupName.trim() || groupMembers.length === 0) return;
    const senderName = user?.displayName || 'Dispatch';
    const participants = [myParticipantId, ...groupMembers.map((m) => `driver:${m.hash}`)];
    const participantNames: Record<string, string> = { [myParticipantId]: senderName };
    groupMembers.forEach((m) => { participantNames[`driver:${m.hash}`] = m.name; });
    const now = serverTimestamp();
    const systemText = `${senderName} created "${groupName.trim()}" with ${groupMembers.map((m) => m.name.split(' ')[0]).join(', ')}`;
    const threadRef = await addDoc(collection(db, 'chat_threads'), {
      type: groupType,
      companyId: companyId || '',
      title: groupName.trim(),
      participants,
      participantNames,
      broadcast: groupBroadcast,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastRead: {},
      lastMessage: { text: systemText, senderId: 'system', senderName: 'System', timestamp: now, type: 'system' },
    });
    // Send system message
    await addDoc(collection(db, 'chat_threads', threadRef.id, 'messages'), {
      text: systemText,
      senderId: 'system',
      senderName: 'System',
      timestamp: now,
      type: 'system',
    });
    setShowGroupCreator(false);
    setGroupName('');
    setGroupMembers([]);
    setGroupType('service_group');
    setGroupBroadcast(false);
  }, [groupName, groupType, groupMembers, myParticipantId, companyId, user]);

  // --- Load drivers ---
  const loadDrivers = useCallback(async () => {
    try {
      const rtdb = getFirebaseDatabase();
      const snap = await get(ref(rtdb, 'drivers/approved'));
      if (!snap.exists()) return;
      const all = snap.val();
      const list: { hash: string; name: string; companyId?: string }[] = [];
      for (const [hash, data] of Object.entries(all) as [string, any][]) {
        if (!data.active && data.active !== undefined) continue;
        const name = data.legalName || data.displayName || 'Driver';
        if (companyId && data.companyId && data.companyId !== companyId) continue;
        list.push({ hash, name, companyId: data.companyId });
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      setDrivers(list);
    } catch {}
  }, [companyId]);

  // --- Sidebar filtering ---
  const nonEmptyThreads = threads.filter((t) => t.lastMessage?.text);
  const filteredThreads = filter === 'archived'
    ? nonEmptyThreads.filter((t) => t.status === 'archived')
    : filter === 'all'
      ? nonEmptyThreads.filter((t) => t.status !== 'archived')
      : nonEmptyThreads.filter((t) => t.type === filter && t.status !== 'archived');

  // Unread counts by thread type — for chip glow indicators
  const unreadByType = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of nonEmptyThreads) {
      if (t.status === 'archived') continue;
      if (isThreadUnread(t, myParticipantId)) {
        counts[t.type] = (counts[t.type] || 0) + 1;
        counts['all'] = (counts['all'] || 0) + 1;
      }
    }
    return counts;
  }, [nonEmptyThreads, myParticipantId]);

  // Show all drivers in the picker — clicking one with an existing thread opens it,
  // clicking one without creates a new thread. No more hiding drivers after first message.
  const driversWithThreads = new Map<string, string>(
    threads.filter((t) => t.type === 'direct').flatMap((t) =>
      t.participants.filter((p) => p.startsWith('driver:')).map((p) => [p.replace('driver:', ''), t.id] as [string, string])
    )
  );
  const filteredDrivers = driverSearch
    ? drivers.filter(d => d.name.toLowerCase().includes(driverSearch.toLowerCase()))
    : drivers;

  const getTitle = (thread: ChatThread) => {
    if (thread.type === 'direct') {
      const otherId = thread.participants.find((p) => p !== myParticipantId);
      if (otherId && thread.participantNames?.[otherId]) return thread.participantNames[otherId];
    }
    return thread.title;
  };

  // Drivers already assigned to a slot in this profile
  const assignedHashes = new Set(slots.filter(Boolean).map((s) => s!.driverHash));

  // --- Render ---
  return (
    <div className="h-dvh bg-[#0a0a0a] text-white flex">
      {/* Left: Sidebar */}
      <div className="w-80 border-r border-gray-800 flex flex-col">
        {/* Header — gear opens everything, profile name is just a label */}
        <div className="p-4 border-b border-gray-800">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold text-[#FFD700] tracking-wide">WB Chat</h1>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setSetupMode(!setupMode); if (!setupMode) loadDrivers(); }}
                className={`text-xs px-2 py-1 rounded border transition-colors ${
                  setupMode
                    ? 'bg-[#FFD700]/20 border-[#FFD700] text-[#FFD700]'
                    : 'border-gray-700 text-gray-400 hover:text-white hover:border-gray-500'
                }`}
                title={setupMode ? 'Exit setup' : 'Setup grid'}
              >
                {setupMode ? 'Done' : '⚙'}
              </button>
              {profiles.length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setShowProfileMenu(!showProfileMenu)}
                    className="text-xs text-gray-400 hover:text-white transition-colors"
                  >
                    {activeProfile?.name || 'Select Profile'} ▾
                  </button>
                  {showProfileMenu && (
                    <div className="absolute right-0 top-full mt-1 bg-[#111] border border-gray-700 rounded-lg overflow-hidden z-20 min-w-[150px] shadow-lg">
                      {profiles.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => { setActiveProfile(p); localStorage.setItem('wb-chat-profile', p.id); setShowProfileMenu(false); }}
                          className={`w-full text-left px-3 py-2 text-sm hover:bg-[#1a1a1a] transition-colors ${
                            activeProfile?.id === p.id ? 'text-[#FFD700] font-bold' : 'text-gray-300'
                          }`}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Setup panel — profiles + grid size + instructions */}
          {setupMode && (
            <div className="mt-3 space-y-2">
              {/* Profile list */}
              <div className="bg-[#111] border border-gray-700 rounded-lg overflow-hidden">
                <div className="px-2 py-1.5 border-b border-gray-800">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">Profiles</p>
                </div>
                {profiles.map((p) => (
                  <div key={p.id} className={`flex items-center justify-between px-3 py-2 hover:bg-[#1a1a1a] cursor-pointer ${
                    activeProfile?.id === p.id ? 'bg-[#FFD700]/10' : ''
                  }`}>
                    <span
                      className={`text-sm flex-1 ${activeProfile?.id === p.id ? 'text-[#FFD700] font-bold' : 'text-gray-300'}`}
                      onClick={() => { setActiveProfile(p); localStorage.setItem('wb-chat-profile', p.id); }}
                    >
                      {p.name} <span className="text-[10px] text-gray-600">{p.gridLayout}</span>
                    </span>
                    <button onClick={() => deleteProfile(p.id)} className="text-gray-600 hover:text-red-400 text-xs px-1" title="Delete profile">✕</button>
                  </div>
                ))}
                <div className="p-2 border-t border-gray-800">
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={newProfileName}
                      onChange={(e) => setNewProfileName(e.target.value)}
                      placeholder="New profile name..."
                      className="flex-1 bg-[#0a0a0a] border border-gray-700 rounded px-2 py-1 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-[#FFD700]/50"
                      onKeyDown={(e) => { if (e.key === 'Enter' && newProfileName.trim()) createProfile(newProfileName, gridLayout.label); }}
                    />
                    <button
                      onClick={() => newProfileName.trim() && createProfile(newProfileName, gridLayout.label)}
                      className="px-2 py-1 rounded bg-[#FFD700]/20 text-[#FFD700] text-xs font-semibold hover:bg-[#FFD700]/30"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              {activeProfile && (
                <>
                  {/* Profile type */}
                  <div className="bg-[#111] border border-gray-700 rounded-lg p-2">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Profile Type</p>
                    <div className="flex flex-wrap gap-1">
                      {(['direct', 'shift', 'well', 'project', 'service_group'] as FilterKey[]).map((t) => (
                        <button
                          key={t}
                          onClick={() => saveProfileType(t)}
                          className={`px-2 py-1 rounded text-xs font-semibold border transition-colors ${
                            (activeProfile.threadType || 'direct') === t
                              ? 'bg-[#FFD700]/20 border-[#FFD700] text-[#FFD700]'
                              : 'bg-[#0a0a0a] border-gray-700 text-gray-400 hover:border-gray-500'
                          }`}
                        >
                          {t === 'service_group' ? 'Crew' : t === 'direct' ? 'Direct' : t.charAt(0).toUpperCase() + t.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Grid size */}
                  <div className="bg-[#111] border border-gray-700 rounded-lg p-2">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Grid Size</p>
                    <div className="grid grid-cols-5 gap-1">
                      {GRID_LAYOUTS.map((layout) => (
                        <button
                          key={layout.label}
                          onClick={() => saveProfileLayout(layout.label)}
                          className={`px-1.5 py-1 rounded text-xs font-mono transition-colors ${
                            gridLayout.label === layout.label
                              ? 'bg-[#FFD700]/20 border border-[#FFD700] text-[#FFD700]'
                              : 'bg-[#0a0a0a] border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
                          }`}
                        >
                          {layout.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-gray-500 mt-2">
                      {(activeProfile.threadType || 'direct') === 'direct'
                        ? 'Click grid slots to assign drivers'
                        : 'Click grid slots to assign group chats'}
                    </p>
                  </div>
                </>
              )}
            </div>
          )}

          {!setupMode && <p className="text-xs text-gray-500 mt-1">Dispatch Communications</p>}
        </div>

        {/* Filter chips */}
        <div className="flex flex-wrap gap-1.5 px-3 py-2 border-b border-gray-800">
          {FILTERS.map((f) => {
            const hasUnread = (unreadByType[f.value] || 0) > 0;
            const isActive = filter === f.value;
            return (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors relative ${
                isActive
                  ? 'bg-[#FFD700]/20 border-[#FFD700] text-[#FFD700]'
                  : hasUnread
                    ? 'bg-[#FFD700]/10 border-[#FFD700]/50 text-[#FFD700]/80 animate-pulse'
                    : 'bg-[#111] border-gray-700 text-gray-400 hover:border-gray-500'
              }`}
            >
              {f.label}
              {hasUnread && !isActive && (
                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-[#FFD700]" />
              )}
            </button>
            );
          })}
        </div>

        {/* New Direct Message button */}
        <div className="px-3 py-2 border-b border-gray-800">
          <button
            onClick={() => { setShowDriverPicker(!showDriverPicker); if (!showDriverPicker) loadDrivers(); }}
            className={`w-full py-2 rounded-lg border text-sm font-semibold transition-colors ${
              showDriverPicker ? 'bg-[#FFD700]/20 border-[#FFD700] text-[#FFD700]' : 'bg-[#FFD700]/10 border-[#FFD700]/30 text-[#FFD700] hover:bg-[#FFD700]/20'
            }`}
          >
            New Direct Message
          </button>
        </div>

        {/* Direct driver picker */}
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
            {filteredDrivers.map((d) => {
              const hasThread = driversWithThreads.has(d.hash);
              return (
              <div
                key={d.hash}
                onClick={() => { ensureDriverThread(d.hash, d.name, d.companyId); setShowDriverPicker(false); }}
                className={`w-full text-left px-3 py-3 text-sm hover:bg-[#FFD700]/10 hover:text-white cursor-pointer transition-colors border-b border-gray-800/30 flex items-center justify-between ${hasThread ? 'text-gray-500' : 'text-gray-300'}`}
                role="button"
              >
                <span>{d.name}</span>
                {hasThread && <span className="text-[10px] text-gray-600">open</span>}
              </div>
              );
            }
            ))}
            {filteredDrivers.length === 0 && (
              <p className="px-3 py-4 text-xs text-gray-600 text-center">No drivers found</p>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {filteredThreads.length === 0 && (
              <div className="text-center py-12 text-gray-600">
                <p className="text-sm">No active conversations</p>
              </div>
            )}
            {filteredThreads.map((thread) => {
              const unread = isThreadUnread(thread, myParticipantId);
              const isOpen = activeThreadIds.includes(thread.id);
              return (
                <button
                  key={thread.id}
                  onClick={() => {
                    // If in setup mode, don't open — setup handles slot assignment
                    if (setupMode) return;
                    // Open thread in the first empty grid slot (or replace last if full)
                    if (activeProfile && slots.length > 0) {
                      const emptyIdx = openPanes.findIndex((p) => !p);
                      const targetIdx = emptyIdx >= 0 ? emptyIdx : slots.length - 1;
                      const newSlots = [...slots];
                      // Assign as thread slot (works for any thread type)
                      newSlots[targetIdx] = { threadId: thread.id, threadTitle: getTitle(thread) };
                      saveProfileSlots(newSlots);
                    }
                  }}
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
                  <div className="flex items-center gap-2 ml-6 mt-0.5">
                    <span className="text-[9px] text-gray-600 uppercase tracking-wider">
                      {threadTypeLabel(thread.type)}
                    </span>
                    {thread.type !== 'direct' && (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          const db = getFirestoreDb();
                          if (!db) return;
                          await updateDoc(doc(db, 'chat_threads', thread.id), { broadcast: !(thread as any).broadcast });
                        }}
                        className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
                          (thread as any).broadcast
                            ? 'bg-[#FFD700]/15 text-[#FFD700]'
                            : 'text-gray-700 hover:text-gray-400'
                        }`}
                        title={(thread as any).broadcast ? 'Broadcast ON' : 'Click to enable broadcast'}
                      >
                        {(thread as any).broadcast ? '📢 BROADCAST' : '📢'}
                      </button>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Right: Chat Grid */}
      <div className="flex-1 overflow-hidden" style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
        gridTemplateRows: `repeat(${gridRows}, 1fr)`,
        gap: '1px',
        background: '#1a1a1a',
      }}>
        {!activeProfile && (
          <div className="flex items-center justify-center bg-[#0a0a0a]" style={{ gridColumn: `1 / -1`, gridRow: `1 / -1` }}>
            <div className="text-center">
              <p className="text-4xl mb-4">💬</p>
              <p className="text-gray-500 text-lg">Create a monitor profile to get started</p>
              <p className="text-gray-600 text-sm mt-2">Click the profile button in the sidebar</p>
            </div>
          </div>
        )}

        {activeProfile && slots.slice(0, maxPanes).map((slot, index) => {
          const threadId = openPanes[index];
          const thread = threadId ? threads.find((t) => t.id === threadId) : null;
          const msgs = threadId ? (paneMessages[threadId] || []) : [];
          const inputText = threadId ? (paneInputs[threadId] || '') : '';
          const lastMsg = msgs[msgs.length - 1];
          const hasUnread = lastMsg && lastMsg.senderId !== myParticipantId;

          // Setup mode — show slot assignment UI
          if (setupMode) {
            const profileType = activeProfile?.threadType || 'direct';
            const isDirectProfile = profileType === 'direct';
            const slotLabel = slot?.driverName || slot?.threadTitle || null;
            // Group threads matching this profile type
            const matchingThreads = threads.filter((t) => t.type === profileType && t.status !== 'archived');
            const assignedThreadIds = new Set(slots.filter(Boolean).map((s) => s!.threadId).filter(Boolean));

            return (
              <div key={index} className="flex flex-col items-center justify-center bg-[#0a0a0a] border border-dashed border-gray-700 relative">
                <p className="text-[10px] text-gray-600 absolute top-2 left-3">Slot {index + 1}</p>
                {slotLabel ? (
                  <div className="text-center">
                    <p className="text-sm font-bold text-[#FFD700]">{slotLabel}</p>
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => { setSlotPickerIndex(index); if (isDirectProfile) loadDrivers(); }}
                        className="text-xs px-2 py-1 rounded bg-[#1a1a1a] border border-gray-700 text-gray-400 hover:text-white"
                      >
                        Change
                      </button>
                      <button
                        onClick={() => assignSlot(index, null)}
                        className="text-xs px-2 py-1 rounded bg-[#1a1a1a] border border-gray-700 text-gray-400 hover:text-red-400"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => { setSlotPickerIndex(index); if (isDirectProfile) loadDrivers(); }}
                    className="text-sm text-gray-500 hover:text-[#FFD700] transition-colors"
                  >
                    + {isDirectProfile ? 'Assign Driver' : 'Assign Chat'}
                  </button>
                )}

                {/* Inline picker for this slot */}
                {slotPickerIndex === index && (
                  <div className="absolute inset-0 bg-[#0a0a0a]/95 z-10 flex flex-col overflow-hidden rounded">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
                      <p className="text-xs text-gray-400">Assign to Slot {index + 1}</p>
                      <button onClick={() => setSlotPickerIndex(null)} className="text-gray-500 hover:text-white text-xs">✕</button>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                      {isDirectProfile ? (
                        // Driver picker for direct profiles
                        drivers.filter((d) => !assignedHashes.has(d.hash) || d.hash === slot?.driverHash).map((d) => (
                          <div
                            key={d.hash}
                            onClick={() => assignSlot(index, { driverHash: d.hash, driverName: d.name })}
                            className="px-3 py-2 text-sm text-gray-300 hover:bg-[#FFD700]/10 hover:text-white cursor-pointer border-b border-gray-800/30"
                          >
                            {d.name}
                          </div>
                        ))
                      ) : (
                        // Thread picker + inline create for group profiles
                        <>
                          {matchingThreads.filter((t) => !assignedThreadIds.has(t.id) || t.id === slot?.threadId).map((t) => (
                            <div
                              key={t.id}
                              onClick={() => assignSlot(index, { threadId: t.id, threadTitle: t.title })}
                              className="px-3 py-2 text-sm text-gray-300 hover:bg-[#FFD700]/10 hover:text-white cursor-pointer border-b border-gray-800/30"
                            >
                              {t.title} <span className="text-[10px] text-gray-600">({t.participants?.length || 0})</span>
                            </div>
                          ))}
                          {/* Inline group creation */}
                          <div className="p-2 border-t border-gray-700">
                            <input
                              type="text"
                              value={groupName}
                              onChange={(e) => setGroupName(e.target.value)}
                              placeholder="New group name..."
                              className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-[#FFD700]/50 mb-1"
                            />
                            {/* Member chips */}
                            {groupMembers.length > 0 && (
                              <div className="flex flex-wrap gap-1 mb-1">
                                {groupMembers.map((m) => (
                                  <span key={m.hash} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[#FFD700]/15 text-[#FFD700] text-[10px]">
                                    {m.name.split(' ')[0]}
                                    <button onClick={() => setGroupMembers((prev) => prev.filter((p) => p.hash !== m.hash))} className="hover:text-red-400">✕</button>
                                  </span>
                                ))}
                              </div>
                            )}
                            {/* Broadcast toggle */}
                            <button
                              onClick={() => setGroupBroadcast(!groupBroadcast)}
                              className={`w-full flex items-center justify-between py-1 px-1 rounded text-[10px] mb-1 ${groupBroadcast ? 'text-[#FFD700]' : 'text-gray-600'}`}
                            >
                              <span>Broadcast (no replies)</span>
                              <span>{groupBroadcast ? '📢' : '💬'}</span>
                            </button>
                            {/* Driver list */}
                            <div className="max-h-24 overflow-y-auto border border-gray-800 rounded mb-1">
                              {drivers.filter((d) => !groupMembers.some((m) => m.hash === d.hash)).map((d) => (
                                <div
                                  key={d.hash}
                                  onClick={() => setGroupMembers((prev) => [...prev, { hash: d.hash, name: d.name }])}
                                  className="px-2 py-1 text-[11px] text-gray-400 hover:bg-[#FFD700]/10 hover:text-white cursor-pointer border-b border-gray-800/30"
                                >
                                  + {d.name}
                                </div>
                              ))}
                            </div>
                            <button
                              onClick={async () => {
                                if (!groupName.trim() || groupMembers.length === 0) return;
                                setGroupType(profileType as ThreadType);
                                // Need to wait for state to update, so set it directly on the function
                                const db = getFirestoreDb();
                                if (!db) return;
                                const senderName = user?.displayName || 'Dispatch';
                                const participants = [myParticipantId, ...groupMembers.map((m) => `driver:${m.hash}`)];
                                const participantNames: Record<string, string> = { [myParticipantId]: senderName };
                                groupMembers.forEach((m) => { participantNames[`driver:${m.hash}`] = m.name; });
                                const now = serverTimestamp();
                                const systemText = `${senderName} created "${groupName.trim()}" with ${groupMembers.map((m) => m.name.split(' ')[0]).join(', ')}`;
                                const threadRef = await addDoc(collection(db, 'chat_threads'), {
                                  type: profileType,
                                  companyId: companyId || '',
                                  title: groupName.trim(),
                                  participants,
                                  participantNames,
                                  broadcast: groupBroadcast,
                                  status: 'active',
                                  createdAt: now,
                                  updatedAt: now,
                                  lastRead: {},
                                  lastMessage: { text: systemText, senderId: 'system', senderName: 'System', timestamp: now, type: 'system' },
                                });
                                await addDoc(collection(db, 'chat_threads', threadRef.id, 'messages'), {
                                  text: systemText, senderId: 'system', senderName: 'System', timestamp: now, type: 'system',
                                });
                                // Assign to slot immediately
                                assignSlot(index, { threadId: threadRef.id, threadTitle: groupName.trim() });
                              }}
                              disabled={!groupName.trim() || groupMembers.length === 0}
                              className={`w-full py-1 rounded text-xs font-semibold ${
                                groupName.trim() && groupMembers.length > 0 ? 'bg-[#FFD700] text-black' : 'bg-gray-800 text-gray-600'
                              }`}
                            >
                              Create + Assign ({groupMembers.length})
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          }

          // Empty slot — no driver assigned
          if (!slot) {
            return (
              <div key={index} className="bg-[#0a0a0a] flex items-center justify-center">
                <p className="text-gray-800 text-xs">Open</p>
              </div>
            );
          }

          // Assigned slot but no thread yet
          if (!threadId) {
            const slotLabel = slot.driverName || slot.threadTitle || 'Unlinked';
            return (
              <div key={index} className="flex flex-col min-w-0 min-h-0 bg-[#0a0a0a]">
                <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 bg-[#0d0d0d] flex-shrink-0">
                  <p className="text-sm font-bold text-gray-500 truncate">{slotLabel}</p>
                </div>
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <p className="text-gray-700 text-xs">No messages yet</p>
                    {slot.driverHash && (
                      <button
                        onClick={async () => {
                          await ensureDriverThread(slot.driverHash!, slot.driverName!);
                        }}
                        className="mt-2 text-xs text-[#FFD700]/60 hover:text-[#FFD700] transition-colors"
                      >
                        Start conversation
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          }

          // Active chat pane
          return (
            <div key={index} className="flex flex-col min-w-0 min-h-0 bg-[#0a0a0a]">
              {/* Header */}
              <div className={`flex items-center justify-between px-3 py-2 border-b flex-shrink-0 transition-colors ${
                hasUnread ? 'bg-[#FFD700]/10 border-[#FFD700]/40' : 'bg-[#0d0d0d] border-gray-800'
              }`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{thread ? threadTypeIcon(thread.type) : ''}</span>
                    <p className={`text-sm font-bold truncate ${hasUnread ? 'text-[#FFD700]' : 'text-white'}`}>
                      {thread ? getTitle(thread) : slot.driverName}
                    </p>
                    {hasUnread && <span className="w-2 h-2 rounded-full bg-[#FFD700] animate-pulse flex-shrink-0" />}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {thread && thread.type !== 'direct' && (
                    <button
                      onClick={() => { setManagingThreadId(managingThreadId === threadId ? null : threadId); loadDrivers(); }}
                      className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                        managingThreadId === threadId ? 'text-[#FFD700] bg-[#FFD700]/10' : 'text-gray-600 hover:text-white'
                      }`}
                      title="Manage members"
                    >
                      {thread.participants?.length || 0}
                    </button>
                  )}
                  {thread && thread.type !== 'direct' && (
                    <button
                      onClick={async () => {
                        const db = getFirestoreDb();
                        if (!db) return;
                        await updateDoc(doc(db, 'chat_threads', threadId), { broadcast: !(thread as any).broadcast });
                      }}
                      className={`text-xs px-1 py-0.5 rounded transition-colors ${
                        (thread as any).broadcast ? 'text-[#FFD700] bg-[#FFD700]/10' : 'text-gray-600 hover:text-gray-400'
                      }`}
                      title={(thread as any).broadcast ? 'Broadcast ON — drivers can\'t reply' : 'Broadcast OFF — drivers can reply'}
                    >
                      {(thread as any).broadcast ? '📢' : '💬'}
                    </button>
                  )}
                  <button
                    onClick={() => archiveThread(threadId)}
                    className="text-gray-600 hover:text-[#FFD700] p-1 transition-colors"
                    title="Archive chat"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Member management panel */}
              {managingThreadId === threadId && thread && thread.type !== 'direct' && (
                <div className="border-b border-gray-800 bg-[#0d0d0d] px-3 py-2 flex-shrink-0 max-h-32 overflow-y-auto">
                  <div className="flex flex-wrap gap-1 mb-1">
                    {(thread.participants || []).filter((p: string) => p.startsWith('driver:')).map((pid: string) => {
                      const name = thread.participantNames?.[pid] || pid;
                      return (
                        <span key={pid} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#1a1a1a] text-[10px] text-gray-300">
                          {name.split(' ')[0]}
                          <button
                            onClick={async () => {
                              const db = getFirestoreDb();
                              if (!db) return;
                              const newParticipants = thread.participants.filter((p: string) => p !== pid);
                              const newNames = { ...thread.participantNames };
                              delete newNames[pid];
                              await updateDoc(doc(db, 'chat_threads', threadId), { participants: newParticipants, participantNames: newNames });
                            }}
                            className="text-gray-600 hover:text-red-400"
                          >✕</button>
                        </span>
                      );
                    })}
                  </div>
                  <select
                    className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-400"
                    value=""
                    onChange={async (e) => {
                      const d = drivers.find((dr) => dr.hash === e.target.value);
                      if (!d) return;
                      const db = getFirestoreDb();
                      if (!db) return;
                      const pid = `driver:${d.hash}`;
                      if (thread.participants.includes(pid)) return;
                      await updateDoc(doc(db, 'chat_threads', threadId), {
                        participants: [...thread.participants, pid],
                        [`participantNames.${pid}`]: d.name,
                      });
                    }}
                  >
                    <option value="">+ Add driver...</option>
                    {drivers.filter((d) => !thread.participants.includes(`driver:${d.hash}`)).map((d) => (
                      <option key={d.hash} value={d.hash}>{d.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-3 space-y-1.5 min-h-0">
                {msgs.map((msg) => {
                  const isMine = msg.senderId === myParticipantId;
                  const isSystem = msg.type === 'system';
                  const isPhoto = msg.type === 'photo' && (msg as any).photoUrl;
                  if (isSystem) {
                    return (
                      <div key={msg.id} className="flex justify-center my-1">
                        <div className="bg-[#1a1a1a] border border-gray-700 rounded-lg px-2 py-0.5">
                          <p className="text-gray-400 text-xs text-center">{msg.text}</p>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={msg.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] rounded-xl px-3 py-1.5 ${
                        isMine ? 'bg-[#FFD700] text-black rounded-br-sm' : 'bg-[#1a1a1a] text-gray-200 rounded-bl-sm'
                      }`}>
                        {!isMine && msg.senderName && <p className="text-[10px] font-semibold mb-0.5 text-[#FFD700]">{msg.senderName}</p>}
                        {isPhoto ? (
                          <a href={(msg as any).photoUrl} target="_blank" rel="noopener noreferrer">
                            <img src={(msg as any).photoUrl} alt="Photo" className="rounded-lg max-w-full max-h-32 cursor-pointer hover:opacity-80" />
                          </a>
                        ) : (
                          <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
                        )}
                        <p className={`text-[10px] mt-0.5 text-right ${isMine ? 'text-black/50' : 'text-gray-500'}`}>
                          {formatChatTime(msg.timestamp)}
                        </p>
                      </div>
                    </div>
                  );
                })}
                <div ref={(el) => { paneEndRefs.current[threadId] = el; }} />
              </div>

              {/* Input */}
              <div className="flex items-center gap-2 px-2 py-1.5 border-t border-gray-800 bg-[#0d0d0d] flex-shrink-0">
                <div className="flex-1 flex items-end gap-1">
                  <textarea
                    value={inputText}
                    onChange={(e) => setPaneInputs((prev) => ({ ...prev, [threadId]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendInPane(threadId); } }}
                    placeholder="Shift+Enter for new line"
                    rows={1}
                    className="flex-1 bg-[#1a1a1a] border border-gray-700 rounded-2xl px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#FFD700]/50 resize-none overflow-y-auto"
                    style={{ minHeight: '32px', maxHeight: '110px', fieldSizing: 'content' } as React.CSSProperties}
                  />
                  {inputText && (
                    <button
                      onClick={() => setPaneInputs((prev) => ({ ...prev, [threadId]: '' }))}
                      className="text-gray-500 hover:text-white text-xs pb-1.5 flex-shrink-0"
                      title="Clear"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <button
                  onClick={() => sendInPane(threadId)}
                  disabled={!inputText.trim()}
                  className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors flex-shrink-0 ${
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
