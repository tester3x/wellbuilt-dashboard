'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { ref, onValue } from 'firebase/database';
import { collection, query, where, onSnapshot, Timestamp } from 'firebase/firestore';
import { getFirebaseDatabase, getFirestoreDb } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import {
  NotificationItem,
  NotificationCategory,
  CATEGORY_LABELS,
  CATEGORY_COLORS,
  loadNotificationPrefs,
  saveNotificationPrefs,
  loadDismissedIds,
  saveDismissedIds,
  loadReadIds,
  saveReadIds,
  playNotificationSound,
  formatRelativeTime,
  DEFAULT_PREFS,
} from '@/lib/notifications';

export function NotificationBell() {
  const { user } = useAuth();
  const pathname = usePathname();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [prefs, setPrefs] = useState<NotificationCategory[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [readVersion, setReadVersion] = useState(0); // bumped to trigger re-render on read changes
  const dismissedRef = useRef<Set<string>>(new Set());
  const readIdsRef = useRef<Set<string>>(new Set());
  const knownIdsRef = useRef<Set<string>>(new Set());
  const pendingInitialLoadDone = useRef(false);
  const dispatchInitialLoadDone = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Load preferences on mount
  useEffect(() => {
    if (!user) return;
    setPrefs(loadNotificationPrefs(user.role));
    dismissedRef.current = loadDismissedIds();
    readIdsRef.current = loadReadIds();
    const stored = localStorage.getItem('wb_notification_sound');
    if (stored !== null) setSoundEnabled(stored === 'true');
  }, [user]);

  // Prune stale read/dismissed IDs that no longer match any active notification
  useEffect(() => {
    if (notifications.length === 0) return;
    const currentIds = new Set(notifications.map(n => n.id));
    let pruned = false;
    for (const id of readIdsRef.current) {
      if (!currentIds.has(id)) {
        readIdsRef.current.delete(id);
        pruned = true;
      }
    }
    if (pruned) saveReadIds(readIdsRef.current);
  }, [notifications]);

  // Auto-mark notifications as read when user navigates to the relevant page (ISBP)
  // e.g., landing on /admin auto-reads driver_registration notifications
  useEffect(() => {
    if (!pathname || notifications.length === 0) return;

    let changed = false;
    notifications.forEach(n => {
      if (readIdsRef.current.has(n.id)) return; // already read
      if (!n.actionHref) return; // no destination to match

      // If user is on the page this notification links to, mark as read
      if (pathname.startsWith(n.actionHref)) {
        readIdsRef.current.add(n.id);
        changed = true;
      }
    });

    if (changed) {
      saveReadIds(readIdsRef.current);
      setReadVersion(v => v + 1);
    }
  }, [pathname, notifications]);

  // Close panel on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setShowSettings(false);
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  // ── Pending driver registration listener (RTDB) ──
  useEffect(() => {
    if (!user || !prefs.includes('driver_registration')) return;

    const db = getFirebaseDatabase();
    const pendingRef = ref(db, 'drivers/pending');

    const unsubscribe = onValue(pendingRef, (snapshot) => {
      const items: NotificationItem[] = [];
      if (snapshot.exists()) {
        const data = snapshot.val();
        Object.entries(data).forEach(([key, val]: [string, any]) => {
          // Skip already-processed
          if (val.status === 'approved' || val.status === 'rejected') return;
          // Skip dismissed
          if (dismissedRef.current.has(`pending_${key}`)) return;

          const ts = val.timestamp || (val.requestedAt ? new Date(val.requestedAt).getTime() : Date.now());
          items.push({
            id: `pending_${key}`,
            category: 'driver_registration',
            title: 'New Driver Registration',
            message: `${val.displayName || 'Unknown'}${val.companyName ? ` (${val.companyName})` : ''} is waiting for approval`,
            timestamp: ts,
            read: false, // read state computed at render time from readIdsRef
            actionLabel: 'Review',
            actionHref: '/admin',
          });
        });
      }

      // Detect truly new notifications (not from initial load)
      if (pendingInitialLoadDone.current) {
        const newItems = items.filter(n => !knownIdsRef.current.has(n.id));
        if (newItems.length > 0 && soundEnabled) {
          playNotificationSound();
        }
      }

      // Update known IDs
      items.forEach(n => knownIdsRef.current.add(n.id));
      pendingInitialLoadDone.current = true;

      setNotifications(prev => {
        const nonPending = prev.filter(n => n.category !== 'driver_registration');
        const merged = [...nonPending, ...items];
        // Deduplicate by ID
        const seen = new Set<string>();
        return merged.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true; })
          .sort((a, b) => b.timestamp - a.timestamp);
      });
    });

    return () => unsubscribe();
  }, [user, prefs, soundEnabled]);

  // ── Dispatch completion listener (Firestore) ──
  useEffect(() => {
    if (!user || !prefs.includes('dispatch_update')) return;

    const firestore = getFirestoreDb();
    // Listen for dispatches completed in the last 24 hours
    const cutoff = Timestamp.fromDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const q = query(
      collection(firestore, 'dispatches'),
      where('status', '==', 'completed'),
      where('completedAt', '>=', cutoff)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items: NotificationItem[] = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        const id = `dispatch_${doc.id}`;
        if (dismissedRef.current.has(id)) return;

        const ts = data.completedAt?.toMillis?.() || Date.now();
        items.push({
          id,
          category: 'dispatch_update',
          title: 'Dispatch Completed',
          message: `${data.driverName || 'Driver'} completed ${data.wellName || 'job'}`,
          timestamp: ts,
          read: false, // read state computed at render time from readIdsRef
          actionLabel: 'View',
          actionHref: '/dispatch',
        });
      });

      if (dispatchInitialLoadDone.current) {
        const newItems = items.filter(n => !knownIdsRef.current.has(n.id));
        if (newItems.length > 0 && soundEnabled) {
          playNotificationSound();
        }
      }

      items.forEach(n => knownIdsRef.current.add(n.id));
      dispatchInitialLoadDone.current = true;

      setNotifications(prev => {
        const nonDispatch = prev.filter(n => n.category !== 'dispatch_update');
        const merged = [...nonDispatch, ...items];
        // Deduplicate by ID
        const seen = new Set<string>();
        return merged.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true; })
          .sort((a, b) => b.timestamp - a.timestamp);
      });
    }, (err) => {
      // Silently handle missing index or permission errors
      console.warn('[Notifications] Dispatch listener error:', err.message);
    });

    return () => unsubscribe();
  }, [user, prefs, soundEnabled]);

  // ── Transfer approval request listener (Firestore) ──
  useEffect(() => {
    if (!user || !prefs.includes('dispatch_update')) return;

    const firestore = getFirestoreDb();
    const q = query(
      collection(firestore, 'dispatches'),
      where('status', '==', 'pending_approval'),
      where('type', '==', 'transfer')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items: NotificationItem[] = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        const id = `transfer_${doc.id}`;
        if (dismissedRef.current.has(id)) return;

        const ts = data.transferredAt?.toMillis?.() || data.assignedAt?.toMillis?.() || Date.now();
        items.push({
          id,
          category: 'dispatch_update',
          title: 'Transfer Requested',
          message: `${data.transferFromDriver || 'Driver'} requests transfer at ${data.wellName || 'well'}`,
          timestamp: ts,
          read: false,
          actionLabel: 'View',
          actionHref: '/dispatch',
        });
      });

      // Play sound for new transfer requests
      const newItems = items.filter(n => !knownIdsRef.current.has(n.id));
      if (newItems.length > 0 && soundEnabled) {
        playNotificationSound();
      }
      items.forEach(n => knownIdsRef.current.add(n.id));

      setNotifications(prev => {
        // Remove old transfer notifications, keep everything else
        const nonTransfer = prev.filter(n => !n.id.startsWith('transfer_'));
        const merged = [...nonTransfer, ...items];
        const seen = new Set<string>();
        return merged.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true; })
          .sort((a, b) => b.timestamp - a.timestamp);
      });
    }, (err) => {
      console.warn('[Notifications] Transfer listener error:', err.message);
    });

    return () => unsubscribe();
  }, [user, prefs, soundEnabled]);

  // ── Actions ──
  const markAsRead = useCallback((id: string) => {
    readIdsRef.current.add(id);
    saveReadIds(readIdsRef.current);
    setReadVersion(v => v + 1); // force re-render so badge updates
  }, []);

  const dismissNotification = useCallback((id: string) => {
    dismissedRef.current.add(id);
    saveDismissedIds(dismissedRef.current);
    readIdsRef.current.add(id);
    saveReadIds(readIdsRef.current);
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const dismissAll = useCallback(() => {
    notifications.forEach(n => {
      dismissedRef.current.add(n.id);
      readIdsRef.current.add(n.id);
    });
    saveDismissedIds(dismissedRef.current);
    saveReadIds(readIdsRef.current);
    setNotifications([]);
  }, [notifications]);

  const togglePref = useCallback((cat: NotificationCategory) => {
    setPrefs(prev => {
      const next = prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat];
      saveNotificationPrefs(next);
      return next;
    });
  }, []);

  const toggleSound = useCallback(() => {
    setSoundEnabled(prev => {
      const next = !prev;
      localStorage.setItem('wb_notification_sound', String(next));
      return next;
    });
  }, []);

  // Compute read state at RENDER time from readIdsRef (prevents stale n.read from listeners)
  // readVersion dependency ensures re-computation when markAsRead is called
  const visibleNotifications = notifications
    .filter(n => prefs.includes(n.category))
    .map(n => ({ ...n, read: readIdsRef.current.has(n.id) }));
  const unreadCount = visibleNotifications.filter(n => !n.read).length;

  if (!user) return null;

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        onClick={() => {
          setIsOpen(!isOpen);
          setShowSettings(false);
        }}
        className="relative p-2 text-gray-400 hover:text-white transition-colors"
        title="Notifications"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
      </button>
      {/* Badge — OUTSIDE button so it's a sibling of the panel in the same stacking context */}
      {unreadCount > 0 && (
        <span className="absolute -top-1 -right-1 z-[60] bg-red-500 text-white text-xs font-bold rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1 pointer-events-none">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}

      {/* Dropdown panel */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-96 bg-gray-800 border border-gray-600 rounded-lg shadow-2xl z-50 overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-700 flex justify-between items-center">
            <h3 className="text-white font-semibold text-sm">Notifications</h3>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="text-gray-400 hover:text-white text-xs transition-colors"
                title="Notification settings"
              >
                ⚙️
              </button>
              {visibleNotifications.length > 0 && (
                <button
                  onClick={dismissAll}
                  className="text-gray-400 hover:text-white text-xs transition-colors"
                >
                  Clear all
                </button>
              )}
            </div>
          </div>

          {/* Settings panel */}
          {showSettings && (
            <div className="px-4 py-3 border-b border-gray-700 bg-gray-750">
              <p className="text-gray-400 text-xs mb-2 font-medium">Notify me about:</p>
              <div className="grid grid-cols-2 gap-1.5">
                {(Object.keys(CATEGORY_LABELS) as NotificationCategory[]).map(cat => (
                  <label key={cat} className="flex items-center gap-2 text-xs cursor-pointer py-0.5">
                    <input
                      type="checkbox"
                      checked={prefs.includes(cat)}
                      onChange={() => togglePref(cat)}
                      className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                    />
                    <span className="text-gray-300">{CATEGORY_LABELS[cat]}</span>
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer mt-2 pt-2 border-t border-gray-600">
                <input
                  type="checkbox"
                  checked={soundEnabled}
                  onChange={toggleSound}
                  className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                />
                <span className="text-gray-300">🔔 Sound alerts</span>
              </label>
            </div>
          )}

          {/* Notification list */}
          <div className="max-h-96 overflow-y-auto">
            {visibleNotifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 text-sm">
                No notifications
              </div>
            ) : (
              visibleNotifications.map(n => (
                <div
                  key={n.id}
                  className={`px-4 py-3 border-b border-gray-700/50 hover:bg-gray-700/30 transition-colors ${
                    !n.read ? 'bg-gray-700/20' : ''
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Category dot */}
                    <div
                      className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
                      style={{ backgroundColor: CATEGORY_COLORS[n.category] }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start">
                        <p className="text-white text-sm font-medium">{n.title}</p>
                        <span className="text-gray-500 text-xs flex-shrink-0 ml-2">
                          {formatRelativeTime(n.timestamp)}
                        </span>
                      </div>
                      <p className="text-gray-400 text-xs mt-0.5">{n.message}</p>

                      {/* Action buttons — View + Dismiss (no inline approve/reject) */}
                      <div className="flex items-center gap-2 mt-2">
                        {n.actionHref && (
                          <a
                            href={n.actionHref}
                            onClick={() => { markAsRead(n.id); setIsOpen(false); }}
                            className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded transition-colors"
                          >
                            {n.actionLabel || 'View'}
                          </a>
                        )}
                        <button
                          onClick={() => dismissNotification(n.id)}
                          className="text-gray-400 hover:text-red-400 text-xs transition-colors ml-auto underline"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
