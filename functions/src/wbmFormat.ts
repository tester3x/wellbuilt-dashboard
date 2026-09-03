// wbmFormat.ts — pure display/format helpers used across the pull pipeline,
// extracted VERBATIM from index.ts so the outgoing/well-status builders can be
// pure. index.ts imports these (single source); rounding/format is unchanged.

export function formatLocalDateTime(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  let hours = d.getHours();
  const mins = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${month}/${day}/${year} ${hours}:${mins} ${ampm}`;
}

/**
 * Derive the canonical LOCAL display string ("M/D/YYYY h:mm AM/PM", UNPADDED)
 * from an absolute ISO instant, rendered in the given IANA timezone. This is the
 * faithful denormalized companion of `dateTimeUTC` — it matches the client's
 * `formatPacketDateTime` output — so an edited `dateTimeUTC` and its stored
 * `dateTime` can never diverge. (Unlike `formatLocalDateTime`, which pads and
 * uses the PROCESS-local zone — UTC on Cloud Functions — this renders the
 * driver's own wall clock.) Timezone defaults to America/Chicago (company TZ)
 * when absent/blank. Invalid instant or timezone → '' so the caller can preserve
 * the prior value rather than persist a garbage string.
 */
export function formatLocalDateTimeInZone(isoUTC: string, timezone?: string | null): string {
  if (!isoUTC) return '';
  const d = new Date(isoUTC);
  if (Number.isNaN(d.getTime())) return '';
  const tz = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : 'America/Chicago';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).formatToParts(d);
    const get = (t: string): string => parts.find(p => p.type === t)?.value ?? '';
    const mo = get('month'), day = get('day'), yr = get('year');
    const hr = get('hour'), min = get('minute');
    const ap = get('dayPeriod').toUpperCase();
    if (!mo || !day || !yr || !hr || !min || !(ap === 'AM' || ap === 'PM')) return '';
    // Intl may emit a narrow no-break space before AM/PM and "24" for midnight
    // hour in some engines; normalize to the canonical "h" (1–12) + ASCII space.
    const hr12 = String(((Number(hr) % 12) || 12));
    return `${mo}/${day}/${yr} ${hr12}:${min} ${ap}`;
  } catch {
    return '';
  }
}

export function outgoingCompanyId(config: { companyId?: unknown } | null | undefined): string {
  const cid = typeof config?.companyId === 'string' ? config.companyId.trim() : '';
  return cid || 'liquid-gold';
}

export function inchesToFeetInches(inches: number): string {
  const feet = Math.floor(inches / 12);
  const remainingInches = Math.floor(inches % 12);
  return `${feet}'${remainingInches}"`;
}

export function feetInchesToInches(str: string): number {
  if (!str) return 0;
  const match = str.match(/(\d+)'(\d+)"/);
  if (match) {
    return parseInt(match[1]) * 12 + parseInt(match[2]);
  }
  return 0;
}

export function daysToHMM(days: number): string {
  const totalMinutes = Math.floor(days * 24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}`;
}

export function daysToHMMSS(days: number): string {
  const totalSeconds = Math.floor(days * 24 * 60 * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}
