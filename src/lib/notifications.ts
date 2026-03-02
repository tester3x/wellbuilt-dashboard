// Notification system types and helpers
import { UserRole } from './auth';

export type NotificationCategory =
  | 'driver_registration'
  | 'dispatch_update'
  | 'pull_submitted'
  | 'well_alert'
  | 'payroll_dispute'
  | 'ticket_submitted';

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  driver_registration: 'Driver Registration',
  dispatch_update: 'Dispatch',
  pull_submitted: 'New Pull',
  well_alert: 'Well Alert',
  payroll_dispute: 'Payroll',
  ticket_submitted: 'Tickets',
};

export const CATEGORY_COLORS: Record<NotificationCategory, string> = {
  driver_registration: '#3B82F6', // blue
  dispatch_update: '#F59E0B',     // amber
  pull_submitted: '#10B981',      // green
  well_alert: '#EF4444',          // red
  payroll_dispute: '#A855F7',     // purple
  ticket_submitted: '#6366F1',    // indigo
};

// Default notification preferences per role
// Users can override these in their settings
export const DEFAULT_PREFS: Record<UserRole, NotificationCategory[]> = {
  it: ['driver_registration', 'dispatch_update', 'pull_submitted', 'well_alert', 'payroll_dispute', 'ticket_submitted'],
  manager: ['driver_registration', 'dispatch_update', 'pull_submitted', 'well_alert', 'payroll_dispute', 'ticket_submitted'],
  admin: ['driver_registration', 'dispatch_update', 'well_alert'],
  viewer: ['well_alert'],
  driver: [],
};

export interface NotificationItem {
  id: string;
  category: NotificationCategory;
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  actionLabel?: string;
  actionHref?: string;
  // Extra data for inline actions (e.g., driver key for approve/reject)
  data?: Record<string, any>;
}

const PREFS_STORAGE_KEY = 'wb_notification_prefs';
const DISMISSED_STORAGE_KEY = 'wb_dismissed_notifications';
const READ_STORAGE_KEY = 'wb_read_notifications';

// Load user's notification preferences from localStorage
export function loadNotificationPrefs(role: UserRole): NotificationCategory[] {
  try {
    const stored = localStorage.getItem(PREFS_STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return DEFAULT_PREFS[role] || [];
}

// Save notification preferences to localStorage
export function saveNotificationPrefs(prefs: NotificationCategory[]): void {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch { /* ignore */ }
}

// Load dismissed notification IDs
export function loadDismissedIds(): Set<string> {
  try {
    const stored = localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch { /* ignore */ }
  return new Set();
}

// Save dismissed notification IDs
export function saveDismissedIds(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch { /* ignore */ }
}

// Load read notification IDs (persists across page navigation)
export function loadReadIds(): Set<string> {
  try {
    const stored = localStorage.getItem(READ_STORAGE_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch { /* ignore */ }
  return new Set();
}

// Save read notification IDs
export function saveReadIds(ids: Set<string>): void {
  try {
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...ids]));
  } catch { /* ignore */ }
}

// Play a notification bing sound using Web Audio API
export function playNotificationSound(): void {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch { /* audio not available */ }
}

// Format relative time (e.g., "2m ago", "1h ago", "Just now")
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
