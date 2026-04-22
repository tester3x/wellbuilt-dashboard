import type { ReportingWindow, SourceRef } from './types';

export interface BuildReportingWindowsInput {
  referenceDates: string[];
  timezone?: string;
  payrollWeek?: {
    anchorDate: string;
    weeks?: number;
  };
}

const DEFAULT_TZ = 'America/Chicago';

interface LocalParts {
  year: string;
  month: string;
  day: string;
  hour: number;
  date: string;
}

function getLocalParts(d: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hourStr = get('hour');
  const hour = hourStr === '24' ? 0 : Number(hourStr);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function production6amDate(d: Date, tz: string): string {
  const p = getLocalParts(d, tz);
  if (p.hour >= 6) return p.date;
  return addDays(p.date, -1);
}

export function buildReportingWindows(
  input: BuildReportingWindowsInput
): ReportingWindow[] {
  const tz = input.timezone ?? DEFAULT_TZ;
  const windows: ReportingWindow[] = [];
  const seen = new Set<string>();

  const push = (w: ReportingWindow) => {
    if (seen.has(w.windowKey)) return;
    seen.add(w.windowKey);
    windows.push(w);
  };

  const derivedSourceRef: SourceRef = {
    system: 'unknown',
    note: 'derived from reference date',
  };

  for (const ts of input.referenceDates ?? []) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) continue;

    const localDate = getLocalParts(d, tz).date;
    const utcDate = d.toISOString().slice(0, 10);
    const prodDate = production6amDate(d, tz);

    push({
      windowKey: `win:local_day:${localDate}:${tz}`,
      kind: 'local_day',
      startsAt: `${localDate}T00:00:00`,
      endsAt: `${addDays(localDate, 1)}T00:00:00`,
      timezone: tz,
      boundaryRule: 'midnight local',
      sourceRefs: [derivedSourceRef],
    });

    push({
      windowKey: `win:utc_day:${utcDate}`,
      kind: 'utc_day',
      startsAt: `${utcDate}T00:00:00.000Z`,
      endsAt: `${addDays(utcDate, 1)}T00:00:00.000Z`,
      timezone: 'UTC',
      boundaryRule: 'midnight UTC',
      sourceRefs: [derivedSourceRef],
    });

    push({
      windowKey: `win:production_day_6am:${prodDate}:${tz}`,
      kind: 'production_day_6am',
      startsAt: `${prodDate}T06:00:00`,
      endsAt: `${addDays(prodDate, 1)}T06:00:00`,
      timezone: tz,
      boundaryRule: '6am local (production day)',
      sourceRefs: [derivedSourceRef],
    });
  }

  if (input.payrollWeek) {
    const anchor = input.payrollWeek.anchorDate;
    const weeks = Math.max(1, input.payrollWeek.weeks ?? 1);
    for (let i = 0; i < weeks; i++) {
      const start = addDays(anchor, i * 7);
      const end = addDays(start, 7);
      push({
        windowKey: `win:payroll_week:${start}`,
        kind: 'payroll_week',
        startsAt: `${start}T00:00:00`,
        endsAt: `${end}T00:00:00`,
        timezone: tz,
        boundaryRule: '7-day window from anchor',
        sourceRefs: [derivedSourceRef],
      });
    }
  }

  return windows.sort((a, b) => a.windowKey.localeCompare(b.windowKey));
}
