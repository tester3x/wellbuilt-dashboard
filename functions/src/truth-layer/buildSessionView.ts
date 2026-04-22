import type { Session, SourceRef } from './types';

export interface ShiftEventInput {
  type?: string;
  timestamp?: string;
  lat?: number;
  lng?: number;
  source?: string;
  synthetic?: boolean;
}

export interface ShiftDocInput {
  driverId?: string;
  driverHash?: string;
  displayName?: string;
  date?: string;
  companyId?: string;
  events?: ShiftEventInput[];
  tzMode?: 'local' | 'utc' | 'mixed' | 'unknown';
}

export interface BuildSessionInput {
  shifts?: ShiftDocInput[];
  timezoneMode?: 'local' | 'utc' | 'mixed' | 'unknown';
}

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function operatorKeyFromShift(s: ShiftDocInput): string | undefined {
  const id = s.driverId ?? s.driverHash;
  return id ? `op:${id}` : undefined;
}

export function buildSessionView(input: BuildSessionInput): Session[] {
  const sessions: Session[] = [];

  for (const shift of input.shifts ?? []) {
    const id = shift.driverId ?? shift.driverHash;
    if (!id) continue;
    const operatorKey = operatorKeyFromShift(shift);

    const events = Array.isArray(shift.events) ? shift.events : [];
    const sorted = [...events]
      .filter((e) => typeof e.timestamp === 'string')
      .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));

    const tzMode: Session['timezoneMode'] =
      shift.tzMode ??
      input.timezoneMode ??
      (shift.date && LOCAL_DATE_RE.test(shift.date) ? 'local' : 'unknown');

    const shiftSourceRef: SourceRef = {
      system: 'firestore',
      path: 'driver_shifts',
      field: 'events',
    };
    if (id && shift.date) {
      shiftSourceRef.recordId = `${id}_${shift.date}`;
    }

    let openLogin: ShiftEventInput | null = null;

    const emit = (start: ShiftEventInput, end?: ShiftEventInput) => {
      const hasStart = typeof start.timestamp === 'string' && start.timestamp.length > 0;
      const hasEnd = typeof end?.timestamp === 'string' && (end!.timestamp!).length > 0;
      const session: Session = {
        sessionKey: `sess:${id}:${start.timestamp}`,
        timezoneMode: tzMode,
        evidence: ['shift_doc'],
        sourceRefs: [shiftSourceRef],
        isOpen: !hasEnd,
        durationConfidence: hasStart && hasEnd ? 'exact' : (hasStart || hasEnd ? 'partial' : 'unknown'),
      };
      if (operatorKey) session.operatorKey = operatorKey;
      if (hasStart) session.startedAt = start.timestamp;
      if (hasEnd) session.endedAt = end!.timestamp;
      sessions.push(session);
    };

    for (const e of sorted) {
      if (e.type === 'login') {
        if (openLogin) emit(openLogin);
        openLogin = e;
      } else if (e.type === 'logout') {
        if (openLogin) {
          emit(openLogin, e);
          openLogin = null;
        }
      }
    }
    if (openLogin) emit(openLogin);
  }

  return sessions.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}
