// ChatTypes.ts — Shared types for WB Chat on the Dashboard.
// Mirrors WB T's chatTypes.ts for web use.

import { Timestamp } from 'firebase/firestore';

// ── Thread Types ────────────────────────────────────────────────────────────

export type ThreadType = 'shift' | 'service_group' | 'project' | 'well' | 'direct';

export interface LastMessagePreview {
  text: string;
  senderId: string;
  senderName: string;
  timestamp: Timestamp | string;
  type: 'text' | 'system';
}

export interface ChatThread {
  id: string; // Firestore doc ID
  type: ThreadType;
  companyId: string;

  // Context links (set depending on type)
  shiftId?: string;          // type=shift — driver_shifts doc ID
  serviceGroupId?: string;   // type=service_group
  projectId?: string;        // type=project
  wellName?: string;         // type=well (shared across drivers at same well)
  directPair?: string;       // type=direct — sorted "id1_id2"

  title: string;             // Display title: driver name, well name, project name
  subtitle?: string;         // Secondary info: operator, job type

  // Participants — flat array for Firestore array-contains queries
  // Format: "driver:{driverHash}" or "user:{firebaseUid}"
  participants: string[];
  participantNames: Record<string, string>; // { participantId: displayName }

  status: 'active' | 'archived';
  createdAt: Timestamp | string;
  updatedAt: Timestamp | string;

  // Denormalized last message for thread list rendering (no subcollection reads)
  lastMessage?: LastMessagePreview;

  // Per-participant last-read timestamp for unread tracking
  lastRead: Record<string, Timestamp | string>;
}

// ── Message Types ───────────────────────────────────────────────────────────

export type MessageType = 'text' | 'system';

export type SystemMessageType =
  | 'level_report'
  | 'status_change'
  | 'job_assigned'
  | 'job_completed'
  | 'driver_joined'
  | 'driver_left'
  | 'shift_started'
  | 'shift_ended';

export interface SystemMessageData {
  wellName?: string;
  topLevel?: string;
  bottomLevel?: string;
  bbls?: number;
  time?: string;
  status?: string;
  driverName?: string;
  disposal?: string;
  jobType?: string;
}

export interface ChatMessage {
  id: string; // Firestore doc ID
  text: string;
  senderId: string;         // "driver:{hash}" or "user:{uid}"
  senderName: string;
  timestamp: Timestamp | string;
  type: MessageType;

  // System message fields (type=system only)
  systemType?: SystemMessageType;
  systemData?: SystemMessageData;

  // Offline dedup
  clientId?: string;
  pending?: boolean;
}

// ── Participant ID Helpers ──────────────────────────────────────────────────

export function driverParticipantId(hash: string): string {
  return `driver:${hash}`;
}

export function userParticipantId(uid: string): string {
  return `user:${uid}`;
}

export function parseParticipantId(id: string): { type: 'driver' | 'user'; key: string } {
  if (id.startsWith('driver:')) return { type: 'driver', key: id.slice(7) };
  if (id.startsWith('user:')) return { type: 'user', key: id.slice(5) };
  return { type: 'driver', key: id }; // fallback
}

export function makeDirectPair(id1: string, id2: string): string {
  return [id1, id2].sort().join('_');
}

// ── Thread Display Helpers ──────────────────────────────────────────────────

const THREAD_TYPE_LABELS: Record<ThreadType, string> = {
  shift: 'Shift',
  service_group: 'Crew',
  project: 'Project',
  well: 'Well',
  direct: 'Direct',
};

export function threadTypeLabel(type: ThreadType): string {
  return THREAD_TYPE_LABELS[type] || type;
}

// SVG-friendly icon names for web (not Ionicons)
const THREAD_TYPE_ICONS: Record<ThreadType, string> = {
  shift: 'briefcase',
  service_group: 'users',
  project: 'wrench',
  well: 'droplet',
  direct: 'chat',
};

export function threadTypeIcon(type: ThreadType): string {
  return THREAD_TYPE_ICONS[type] || 'chat';
}

// ── Unread Helper ───────────────────────────────────────────────────────────

export function isThreadUnread(thread: ChatThread, myParticipantId: string): boolean {
  if (!thread.lastMessage?.timestamp) return false;
  const lastReadTs = thread.lastRead?.[myParticipantId];
  if (!lastReadTs) return true; // Never read = unread

  const msgTime = typeof thread.lastMessage.timestamp === 'string'
    ? new Date(thread.lastMessage.timestamp).getTime()
    : thread.lastMessage.timestamp.toMillis();
  const readTime = typeof lastReadTs === 'string'
    ? new Date(lastReadTs).getTime()
    : lastReadTs.toMillis();

  return msgTime > readTime;
}

// ── Time Formatting ─────────────────────────────────────────────────────────

export function formatChatTime(ts: Timestamp | string | undefined): string {
  if (!ts) return '';
  const date = typeof ts === 'string' ? new Date(ts) : ts.toDate();
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);

  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr < 24) return `${diffHr}h`;

  // Same year: "Mar 5"
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  // Different year: "3/5/25"
  return date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
}
