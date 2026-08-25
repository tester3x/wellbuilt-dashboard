/** Host-timezone-independent display formatting. */

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

/** MM/DD/YYYY from a date-only string, ISO, or already-formatted value. */
export function formatDateDisplay(raw: unknown): string {
  const s = asTrimmedString(raw);
  if (!s) return '';
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    return `${mdy[1].padStart(2, '0')}/${mdy[2].padStart(2, '0')}/${mdy[3]}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  return s;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 12-hour clock from an ISO timestamp using the timestamp's own offset, else UTC. */
export function formatTimeDisplay(raw: unknown): string {
  const s = asTrimmedString(raw);
  if (!s) return '';
  const already = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (already) {
    const hr = String(parseInt(already[1], 10));
    return `${hr}:${already[2]} ${already[3].toUpperCase()}`;
  }
  const offsetMatch = s.match(/(Z|[+-]\d{2}:?\d{2})$/);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  let hours: number;
  let minutes: number;
  if (!offsetMatch || offsetMatch[1] === 'Z') {
    hours = d.getUTCHours();
    minutes = d.getUTCMinutes();
  } else {
    hours = d.getUTCHours();
    minutes = d.getUTCMinutes();
  }
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hr12 = hours % 12 || 12;
  return `${hr12}:${pad2(minutes)} ${ampm}`;
}

export function formatDateTimeDisplay(raw: unknown): string {
  const s = asTrimmedString(raw);
  if (!s) return '';
  const date = formatDateDisplay(s);
  const time = formatTimeDisplay(s);
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
