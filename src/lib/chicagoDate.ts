/**
 * Date parsing, formatting, and America/Chicago calendar-day boundary resolution.
 * Prevents UTC day-shifting across daylight saving (CDT) and standard time (CST).
 */

export interface ParsedCalendarDate {
  year: number;
  month: number;
  day: number;
}

/**
 * Validates and parses either MM/DD/YYYY or YYYY-MM-DD into year, month, day.
 * Ensures the date is a real calendar date (e.g. rejects Feb 29 on non-leap years, Feb 30, April 31).
 */
export function parseDateInput(input: string): ParsedCalendarDate | null {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;

  let year = 0;
  let month = 0;
  let day = 0;

  // Pattern: MM/DD/YYYY or M/D/YYYY
  const mdy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    month = parseInt(mdy[1], 10);
    day = parseInt(mdy[2], 10);
    year = parseInt(mdy[3], 10);
  } else {
    // Pattern: YYYY-MM-DD
    const ymd = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (ymd) {
      year = parseInt(ymd[1], 10);
      month = parseInt(ymd[2], 10);
      day = parseInt(ymd[3], 10);
    } else {
      return null;
    }
  }

  if (year < 1970 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  // Calendar validation using Date constructor (year, monthIndex, day)
  const probe = new Date(year, month - 1, day);
  if (
    probe.getFullYear() !== year ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

/**
 * Formats parsed date components to MM/DD/YYYY.
 */
export function formatMdy(d: ParsedCalendarDate): string {
  const m = String(d.month).padStart(2, '0');
  const day = String(d.day).padStart(2, '0');
  return `${m}/${day}/${d.year}`;
}

/**
 * Formats parsed date components to YYYY-MM-DD for native <input type="date">.
 */
export function formatIso(d: ParsedCalendarDate): string {
  const m = String(d.month).padStart(2, '0');
  const day = String(d.day).padStart(2, '0');
  return `${d.year}-${m}-${day}`;
}

/**
 * Converts user-typed input (MM/DD/YYYY or YYYY-MM-DD) to ISO format (YYYY-MM-DD) if valid.
 */
export function toIsoDate(input: string): string {
  const parsed = parseDateInput(input);
  return parsed ? formatIso(parsed) : '';
}

/**
 * Converts ISO format (YYYY-MM-DD) from a native picker to MM/DD/YYYY.
 */
export function toMdyDate(iso: string): string {
  const parsed = parseDateInput(iso);
  return parsed ? formatMdy(parsed) : '';
}

/**
 * Computes exact epoch milliseconds for 00:00:00.000 (start of day) and
 * 23:59:59.999 (end of day) in America/Chicago timezone for a given calendar date.
 * Does not suffer from UTC date-shifting.
 */
export function getChicagoDayBoundaries(
  year: number,
  month: number,
  day: number,
): { startMs: number; endMs: number } {
  // Construct UTC guess at noon
  const utcGuess = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = fmt.formatToParts(utcGuess);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  const chYear = parseInt(partMap.year, 10);
  const chMonth = parseInt(partMap.month, 10);
  const chDay = parseInt(partMap.day, 10);
  const chHour = parseInt(partMap.hour === '24' ? '0' : partMap.hour, 10);
  const chMin = parseInt(partMap.minute, 10);
  const chSec = parseInt(partMap.second, 10);

  const asUtc = Date.UTC(chYear, chMonth - 1, chDay, chHour, chMin, chSec);
  const offsetMs = utcGuess.getTime() - asUtc;

  // Exact America/Chicago calendar boundaries
  const startMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) + offsetMs;
  const endMs = Date.UTC(year, month - 1, day, 23, 59, 59, 999) + offsetMs;

  return { startMs, endMs };
}

export interface DateRangeValidationResult {
  valid: boolean;
  error?: string;
  dateFromMs?: number;
  dateToMs?: number;
}

/**
 * Validates a pair of user-entered date inputs (Start Date & End Date).
 * Enforces real dates and Start Date <= End Date.
 */
export function validateDateRange(fromInput: string, toInput: string): DateRangeValidationResult {
  let startMs: number | undefined;
  let endMs: number | undefined;

  const trimmedFrom = fromInput.trim();
  const trimmedTo = toInput.trim();

  if (trimmedFrom) {
    const parsedFrom = parseDateInput(trimmedFrom);
    if (!parsedFrom) {
      return {
        valid: false,
        error: 'Please enter a valid Start Date in MM/DD/YYYY format.',
      };
    }
    const boundaries = getChicagoDayBoundaries(parsedFrom.year, parsedFrom.month, parsedFrom.day);
    startMs = boundaries.startMs;
  }

  if (trimmedTo) {
    const parsedTo = parseDateInput(trimmedTo);
    if (!parsedTo) {
      return {
        valid: false,
        error: 'Please enter a valid End Date in MM/DD/YYYY format.',
      };
    }
    const boundaries = getChicagoDayBoundaries(parsedTo.year, parsedTo.month, parsedTo.day);
    endMs = boundaries.endMs;
  }

  if (startMs !== undefined && endMs !== undefined) {
    if (startMs > endMs) {
      return {
        valid: false,
        error: 'Start Date must be on or before End Date.',
      };
    }
  }

  return {
    valid: true,
    dateFromMs: startMs,
    dateToMs: endMs,
  };
}
