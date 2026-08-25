/** Host-timezone-independent display formatting. */

export const DEFAULT_PAPER_TIMEZONE = 'America/Chicago';

export function asTrimmedString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string') return v.trim();
  return '';
}

export function asBblString(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Number.isInteger(v) ? String(v) : String(v);
  }
  return asTrimmedString(v);
}

export function timestampMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (raw && typeof raw === 'object' && typeof (raw as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (raw as { toMillis: () => number }).toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  if (raw && typeof raw === 'object' && typeof (raw as { seconds?: unknown }).seconds === 'number') {
    const seconds = (raw as { seconds: number; nanoseconds?: number }).seconds;
    const nanos = typeof (raw as { nanoseconds?: number }).nanoseconds === 'number'
      ? (raw as { nanoseconds: number }).nanoseconds : 0;
    return seconds * 1000 + Math.floor(nanos / 1e6);
  }
  const s = asTrimmedString(raw);
  if (!s) return null;
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

/** MM/DD/YYYY. Business dates stay as written; instants use the governed IANA zone. */
export function formatDateDisplay(raw: unknown, timeZone: string = DEFAULT_PAPER_TIMEZONE): string {
  const s = asTrimmedString(raw);
  if (!s) return '';
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    return `${mdy[1].padStart(2, '0')}/${mdy[2].padStart(2, '0')}/${mdy[3]}`;
  }
  const instant = timestampMs(s);
  if (instant != null && /T|\d{2}:\d{2}/.test(s)) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    }).formatToParts(new Date(instant));
    const month = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    const year = parts.find((p) => p.type === 'year')?.value;
    if (month && day && year) return `${month}/${day}/${year}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  return s;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatHourMinute(hours: number, minutes: number): string {
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hr12 = hours % 12 || 12;
  return `${hr12}:${pad2(minutes)} ${ampm}`;
}

/**
 * Paper clock time.
 * Policy: explicit numeric offset → that offset's wall clock.
 * `Z` or missing offset → governed IANA timezone (default America/Chicago).
 * Never uses the process/host local timezone.
 */
export function formatTimeDisplay(raw: unknown, timeZone: string = DEFAULT_PAPER_TIMEZONE): string {
  const s = asTrimmedString(raw);
  if (!s) return '';
  const already = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (already) {
    const hr = String(parseInt(already[1], 10));
    return `${hr}:${already[2]} ${already[3].toUpperCase()}`;
  }
  const offset = s.match(/([+-])(\d{2}):?(\d{2})$/);
  if (offset && !s.endsWith('Z') && !/^\d{1,2}:\d{2}/.test(s)) {
    const wall = s.match(/T(\d{2}):(\d{2})/);
    if (wall) {
      return formatHourMinute(parseInt(wall[1], 10), parseInt(wall[2], 10));
    }
  }
  const instant = timestampMs(s);
  if (instant == null) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(instant));
  const hour = parts.find((p) => p.type === 'hour')?.value;
  const minute = parts.find((p) => p.type === 'minute')?.value;
  const dayPeriod = parts.find((p) => p.type === 'dayPeriod')?.value;
  if (!hour || !minute || !dayPeriod) return '';
  return `${hour}:${minute} ${dayPeriod.toUpperCase()}`;
}

export function formatDateTimeDisplay(raw: unknown, timeZone: string = DEFAULT_PAPER_TIMEZONE): string {
  const s = asTrimmedString(raw);
  if (!s) return '';
  const date = formatDateDisplay(s, timeZone);
  const time = formatTimeDisplay(s, timeZone);
  if (date && time && date !== s) return `${date}  ${time}`;
  if (date) return date;
  return s;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
