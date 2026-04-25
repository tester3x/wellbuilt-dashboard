/**
 * Phase 27 — Operator Weekly Summary.
 *
 * Pure, read-only builder. Given 7 per-day truth projections plus the raw
 * invoice inputs for each day and the canonical operator view, produce a
 * single consumer-friendly weekly summary.
 *
 * Consumer contract: every field is a primitive, plain object, or array of
 * those — no Firestore Timestamps, no normalized refs, no internal helpers.
 * A JSON.stringify of the output round-trips cleanly.
 */
import type { TruthProjection } from './types';
import type {
  CanonicalProjection,
  OperatorCanonicalView,
} from './types.canonical';
import type { ValidationWarning } from './validateProjection';
import type { InvoiceInput, InvoiceTicket } from './extractOperationalEvents';
import { buildDriverDaySummaryFromTruth } from './buildDriverDaySummaryFromTruth';
import {
  getIdentityConfidence,
  getSourceIdentities,
} from './canonicalIdentity';

// ── Public types ────────────────────────────────────────────────────────

export interface WeekDayInput {
  /** YYYY-MM-DD local-day key used for this slot (what the loader was asked
   *  for). All slots must use the same timezone convention; the builder does
   *  not re-window. */
  date: string;
  projection: TruthProjection;
  /** Optional — the per-day canonical projection. Required only if the
   *  builder is used standalone without a pre-resolved operator view. */
  canonical?: CanonicalProjection;
  /** Raw per-day invoice inputs (as loaded). Ticket-level data is pulled
   *  from these when present. */
  invoices?: InvoiceInput[];
  /** Optional — filtered validation warnings for this day. Bubbled up. */
  warnings?: ValidationWarning[];
}

export interface BuildDriverWeekSummaryInput {
  /** Linked raw operator keys (canonical view's `linkedKeys`). Events tagged
   *  with ANY of these keys attribute to this operator. */
  operatorLinkedKeys: readonly string[];
  /** Canonical operator view — used for identity fields on the output. */
  canonicalView?: OperatorCanonicalView;
  week: {
    /** YYYY-MM-DD of the first day in the window. */
    startDate: string;
    /** YYYY-MM-DD of the last day in the window (inclusive). */
    endDate: string;
    /** IANA timezone the week was anchored to. */
    timezone: string;
    /** All 7 YYYY-MM-DD keys the caller asked for, in order. */
    dayKeys: readonly string[];
  };
  days: readonly WeekDayInput[];
  /** Upper bound for topLocations / topActivities. Default 10. */
  topK?: number;
  /** Upper bound for returned tickets. Default 200. */
  ticketLimit?: number;
}

export interface WeekSummaryOperator {
  canonicalOperatorKey: string;
  displayName?: string;
  legalName?: string;
  linkedKeys: string[];
  identityConfidence: 'strong' | 'medium' | 'weak';
  hasHash: boolean;
}

export interface WeekSummaryTotals {
  daysWithActivity: number;
  totalSessions: number;
  totalActiveMinutes: number;
  totalDispatchEvents: number;
  totalInvoiceEvents: number;
  totalJsaCompleted: number;
  totalLocationsVisited: number;
  totalTickets: number;
}

export interface WeekSummaryPerDay {
  date: string;
  sessions: number;
  activeMinutes: number;
  locationsVisited: number;
  locationNames: string[];
  eventCountsByType: Record<string, number>;
  jsaCompleted: boolean;
  ticketCount: number;
}

export interface WeekSummaryLocation {
  preferredName: string;
  eventCount: number;
  kind?: string;
  daysVisited: number;
}

export interface WeekSummaryActivity {
  canonicalLabel: string;
  rawCount: number;
}

export interface WeekSummaryTicket {
  ticketNumber?: string;
  invoiceId?: string;
  wellName?: string;
  hauledTo?: string;
  bbl?: number;
  commodityType?: string;
  createdAt?: string;
  /** YYYY-MM-DD slot the ticket was sourced from (the day key this invoice
   *  loaded under). Useful for per-day grouping on the consumer. */
  day: string;
}

export interface WeekSummaryWarning {
  kind: string;
  message?: string;
  day?: string;
}

export interface DriverWeekSummary {
  operator: WeekSummaryOperator;
  week: {
    startDate: string;
    endDate: string;
    timezone: string;
    dayKeys: string[];
  };
  summary: WeekSummaryTotals;
  perDay: WeekSummaryPerDay[];
  topLocations: WeekSummaryLocation[];
  topActivities: WeekSummaryActivity[];
  tickets: WeekSummaryTicket[];
  warnings: WeekSummaryWarning[];
  generatedAt: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const INVOICE_EVENT_TYPES = new Set([
  'arrival',
  'departure',
  'pickup',
  'dropoff',
]);

function isInvoiceAttributedToOperator(
  inv: InvoiceInput,
  linkedKeys: ReadonlySet<string>
): boolean {
  // Mirror the extractor's attribution logic: prefer hash/driverId, fall
  // back to the driver string (which normalizes to `op-name:…`). We accept
  // ANY linkedKeys match so the Phase 26 bridge is honored end-to-end.
  const hashRef = inv.driverHash ?? inv.driverId;
  if (hashRef && linkedKeys.has(`op:${hashRef}`)) return true;
  if (typeof inv.driver === 'string' && inv.driver.trim().length > 0) {
    const nameKey = `op-name:${inv.driver
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')}`;
    if (linkedKeys.has(nameKey)) return true;
  }
  return false;
}

function stringifyTicketNumber(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function extractTicketsFromInvoice(
  inv: InvoiceInput,
  day: string
): WeekSummaryTicket[] {
  const out: WeekSummaryTicket[] = [];
  const invoiceId = typeof inv.id === 'string' ? inv.id : undefined;
  const inferredCreatedAt =
    typeof inv.createdAt === 'string' ? inv.createdAt : undefined;
  const arr = Array.isArray(inv.tickets) ? inv.tickets : [];
  if (arr.length === 0) {
    // Ticket_only mode: the invoice itself carries a ticketNumber.
    const num = stringifyTicketNumber(inv.ticketNumber ?? inv.invoiceNumber);
    if (num || typeof inv.totalBBL === 'number') {
      const row: WeekSummaryTicket = { day };
      if (num) row.ticketNumber = num;
      if (invoiceId) row.invoiceId = invoiceId;
      if (typeof inv.wellName === 'string') row.wellName = inv.wellName;
      if (typeof inv.hauledTo === 'string') row.hauledTo = inv.hauledTo;
      if (typeof inv.totalBBL === 'number') row.bbl = inv.totalBBL;
      if (typeof inv.commodityType === 'string')
        row.commodityType = inv.commodityType;
      if (inferredCreatedAt) row.createdAt = inferredCreatedAt;
      out.push(row);
    }
    return out;
  }
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    const tk = t as InvoiceTicket;
    const num = stringifyTicketNumber(tk.ticketNumber);
    const row: WeekSummaryTicket = { day };
    if (num) row.ticketNumber = num;
    if (invoiceId) row.invoiceId = invoiceId;
    const wellName =
      typeof tk.wellName === 'string' ? tk.wellName : inv.wellName;
    const hauledTo =
      typeof tk.hauledTo === 'string' ? tk.hauledTo : inv.hauledTo;
    if (typeof wellName === 'string') row.wellName = wellName;
    if (typeof hauledTo === 'string') row.hauledTo = hauledTo;
    const bbl =
      typeof tk.bbl === 'number'
        ? tk.bbl
        : typeof tk.totalBBL === 'number'
        ? tk.totalBBL
        : undefined;
    if (bbl !== undefined) row.bbl = bbl;
    const commodity =
      typeof tk.commodityType === 'string'
        ? tk.commodityType
        : inv.commodityType;
    if (typeof commodity === 'string') row.commodityType = commodity;
    const created =
      typeof tk.createdAt === 'string' ? tk.createdAt : inferredCreatedAt;
    if (created) row.createdAt = created;
    out.push(row);
  }
  return out;
}

// ── Main builder ───────────────────────────────────────────────────────

export function buildDriverWeekSummary(
  input: BuildDriverWeekSummaryInput
): DriverWeekSummary {
  const topK = Math.max(1, input.topK ?? 10);
  const ticketLimit = Math.max(1, input.ticketLimit ?? 200);
  const linkedKeys = Array.from(new Set(input.operatorLinkedKeys));
  const linkedSet = new Set(linkedKeys);

  // Per-day rows.
  const perDay: WeekSummaryPerDay[] = [];
  const locationAgg = new Map<
    string,
    { preferredName: string; kind?: string; eventCount: number; days: Set<string> }
  >();
  const activityAgg = new Map<
    string,
    { canonicalLabel: string; rawCount: number }
  >();
  const tickets: WeekSummaryTicket[] = [];
  const warnings: WeekSummaryWarning[] = [];

  let totalSessions = 0;
  let totalActiveMs = 0;
  let totalDispatchEvents = 0;
  let totalInvoiceEvents = 0;
  let totalJsaCompleted = 0;
  let daysWithActivity = 0;

  const byDate = new Map<string, WeekDayInput>();
  for (const d of input.days) byDate.set(d.date, d);

  for (const dayKey of input.week.dayKeys) {
    const dayInput = byDate.get(dayKey);
    const row: WeekSummaryPerDay = {
      date: dayKey,
      sessions: 0,
      activeMinutes: 0,
      locationsVisited: 0,
      locationNames: [],
      eventCountsByType: {},
      jsaCompleted: false,
      ticketCount: 0,
    };
    if (!dayInput) {
      perDay.push(row);
      continue;
    }

    const day = buildDriverDaySummaryFromTruth(dayInput.projection, linkedKeys);
    row.sessions = day.sessions.length;
    row.activeMinutes = Math.round(day.totalActiveMs / 60000);
    row.locationsVisited = day.locationsVisited.length;
    row.locationNames = day.locationsVisited.map((l) => l.preferredName);
    row.eventCountsByType = { ...day.eventCountsByType };
    row.jsaCompleted = day.jsa.completed;

    totalSessions += row.sessions;
    totalActiveMs += day.totalActiveMs;
    if (row.jsaCompleted) totalJsaCompleted += 1;
    totalDispatchEvents += day.eventCountsByType['dispatch_status'] ?? 0;
    let invCount = 0;
    for (const t of INVOICE_EVENT_TYPES) {
      invCount += day.eventCountsByType[t] ?? 0;
    }
    totalInvoiceEvents += invCount;

    const hasAny =
      row.sessions > 0 ||
      row.locationsVisited > 0 ||
      row.jsaCompleted ||
      Object.keys(row.eventCountsByType).length > 0;
    if (hasAny) daysWithActivity += 1;

    for (const l of day.locationsVisited) {
      const prev = locationAgg.get(l.locationKey);
      if (prev) {
        prev.eventCount += l.eventCount;
        prev.days.add(dayKey);
      } else {
        const entry: {
          preferredName: string;
          kind?: string;
          eventCount: number;
          days: Set<string>;
        } = {
          preferredName: l.preferredName,
          eventCount: l.eventCount,
          days: new Set([dayKey]),
        };
        if (l.kind !== undefined) entry.kind = l.kind;
        locationAgg.set(l.locationKey, entry);
      }
    }
    for (const a of day.activitiesPerformed) {
      const prev = activityAgg.get(a.activityKey);
      if (prev) prev.rawCount += a.rawCount;
      else
        activityAgg.set(a.activityKey, {
          canonicalLabel: a.canonicalLabel,
          rawCount: a.rawCount,
        });
    }

    // Tickets — only from invoices attributed to this operator.
    const dayTickets: WeekSummaryTicket[] = [];
    for (const inv of dayInput.invoices ?? []) {
      if (!isInvoiceAttributedToOperator(inv, linkedSet)) continue;
      for (const tk of extractTicketsFromInvoice(inv, dayKey)) {
        dayTickets.push(tk);
      }
    }
    row.ticketCount = dayTickets.length;
    for (const tk of dayTickets) {
      if (tickets.length < ticketLimit) tickets.push(tk);
    }

    for (const w of dayInput.warnings ?? []) {
      const entry: WeekSummaryWarning = { kind: w.kind, day: dayKey };
      if (typeof w.message === 'string') entry.message = w.message;
      warnings.push(entry);
    }

    perDay.push(row);
  }

  const topLocations: WeekSummaryLocation[] = Array.from(locationAgg.values())
    .map((v) => {
      const out: WeekSummaryLocation = {
        preferredName: v.preferredName,
        eventCount: v.eventCount,
        daysVisited: v.days.size,
      };
      if (v.kind !== undefined) out.kind = v.kind;
      return out;
    })
    .sort((a, b) => {
      if (b.eventCount !== a.eventCount) return b.eventCount - a.eventCount;
      return a.preferredName.localeCompare(b.preferredName);
    })
    .slice(0, topK);

  const topActivities: WeekSummaryActivity[] = Array.from(activityAgg.values())
    .sort((a, b) => {
      if (b.rawCount !== a.rawCount) return b.rawCount - a.rawCount;
      return a.canonicalLabel.localeCompare(b.canonicalLabel);
    })
    .slice(0, topK);

  // Operator identity block — derived from the canonical view when present,
  // otherwise from the linked keys themselves.
  const canonicalView = input.canonicalView;
  let canonicalOperatorKey = '';
  let displayName: string | undefined;
  let legalName: string | undefined;
  let identityConfidence: 'strong' | 'medium' | 'weak' = 'weak';
  let hasHash = false;
  if (canonicalView) {
    canonicalOperatorKey = canonicalView.canonicalOperatorKey;
    displayName = canonicalView.displayName;
    legalName = canonicalView.legalName;
    identityConfidence = getIdentityConfidence(canonicalView);
    hasHash = !!getSourceIdentities(canonicalView).hasHash;
  } else {
    // Best effort: first key wins; assume strong if it's an op:hash
    canonicalOperatorKey = linkedKeys[0] ?? '';
    if (canonicalOperatorKey.startsWith('op:')) {
      identityConfidence = 'strong';
      hasHash = true;
    } else if (canonicalOperatorKey.startsWith('op-uid:')) {
      identityConfidence = 'medium';
    }
  }
  const operator: WeekSummaryOperator = {
    canonicalOperatorKey,
    linkedKeys,
    identityConfidence,
    hasHash,
  };
  if (displayName !== undefined) operator.displayName = displayName;
  if (legalName !== undefined) operator.legalName = legalName;

  const summary: WeekSummaryTotals = {
    daysWithActivity,
    totalSessions,
    totalActiveMinutes: Math.round(totalActiveMs / 60000),
    totalDispatchEvents,
    totalInvoiceEvents,
    totalJsaCompleted,
    totalLocationsVisited: locationAgg.size,
    totalTickets: tickets.length,
  };

  return {
    operator,
    week: {
      startDate: input.week.startDate,
      endDate: input.week.endDate,
      timezone: input.week.timezone,
      dayKeys: [...input.week.dayKeys],
    },
    summary,
    perDay,
    topLocations,
    topActivities,
    tickets,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}
