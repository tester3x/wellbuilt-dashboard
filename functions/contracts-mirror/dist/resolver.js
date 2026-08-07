/**
 * Canonical work-period resolver (vc51.9A) — pure, deterministic, shared.
 *
 * Every consumer calls THIS function so WB-S, WB-T and WB-JSA can never
 * disagree about which period a driver is in (the 8/6 field failure was
 * exactly that disagreement: WB-JSA held a closed shift while WB-T fell
 * back to a UTC date).
 *
 * Hard rules encoded here:
 *   - local cache and deep links are HINTS; only fetched authoritative
 *     day documents establish an explicit shift;
 *   - a closed or superseded explicit shift never becomes current again;
 *   - "last known shift" is never returned after resolution fails —
 *     failure surfaces as UNVERIFIED_OFFLINE;
 *   - derived periods come from the company's IANA timezone and schedule,
 *     never from a UTC-date fallback;
 *   - missing/invalid configuration fails honestly.
 *
 * Timezone math uses ECMA-402 Intl with a real IANA zone. DST is handled
 * by resolving the local wall time twice against the zone's offset; the
 * documented edge behavior is: a spring-forward nonexistent local time
 * resolves forward past the gap, and a fall-back ambiguous local time
 * resolves to its FIRST (pre-transition) occurrence.
 */
import { CONTRACT_VERSION, } from './types.js';
import { requiresWorkPeriod } from './types.js';
const pad = (n) => String(n).padStart(2, '0');
/** Zone offset in minutes at a given UTC instant (positive = east of UTC). */
export function zoneOffsetMinutes(timezone, utcMs) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = {};
    for (const p of dtf.formatToParts(new Date(utcMs))) {
        if (p.type !== 'literal')
            parts[p.type] = p.value;
    }
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return Math.round((asUtc - utcMs) / 60000);
}
export function isValidTimezone(timezone) {
    if (!timezone || typeof timezone !== 'string')
        return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return true;
    }
    catch {
        return false;
    }
}
/** Local calendar date 'YYYY-MM-DD' in `timezone` at `utcMs`. */
export function localDateInZone(timezone, utcMs) {
    const off = zoneOffsetMinutes(timezone, utcMs);
    const d = new Date(utcMs + off * 60000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** UTC instant for a local wall time in `timezone` (two-pass, DST-aware). */
export function zonedWallTimeToUtcMs(timezone, localDate, localTime) {
    const naive = Date.parse(`${localDate}T${localTime}:00Z`);
    const off1 = zoneOffsetMinutes(timezone, naive);
    const pass1 = naive - off1 * 60000;
    const off2 = zoneOffsetMinutes(timezone, pass1);
    return naive - off2 * 60000;
}
function invalid(input, reason) {
    return {
        outcome: 'INVALID_CONFIGURATION',
        contractVersion: CONTRACT_VERSION,
        companyId: input.companyId,
        driverId: input.driverId,
        reason,
    };
}
/** Lifecycle verdict for a cached shift id from its own origin-day doc. */
function verifyAgainstOriginDay(cachedShiftId, doc) {
    if (!doc || !doc.readable)
        return 'unverified';
    if (!doc.present)
        return 'closed'; // definitively absent → never opened
    if (typeof doc.currentShiftId !== 'string')
        return 'unverified';
    return doc.currentShiftId === cachedShiftId ? 'open' : 'closed';
}
export function resolveWorkPeriod(input) {
    const base = {
        contractVersion: CONTRACT_VERSION,
        companyId: input.companyId,
        driverId: input.driverId,
    };
    if (input.contractVersion !== CONTRACT_VERSION) {
        return invalid(input, `unsupported_contract_version:${input.contractVersion}`);
    }
    if (!input.companyId || !input.driverId)
        return invalid(input, 'missing_identity');
    const cfg = input.config;
    const mode = cfg?.mode ?? input.capabilities?.workPeriodMode;
    if (mode !== 'explicit_shift' && mode !== 'company_defined_period') {
        return invalid(input, 'missing_or_unknown_work_period_mode');
    }
    if (cfg && cfg.mode !== input.capabilities.workPeriodMode) {
        return invalid(input, 'configuration_conflicts_with_entitlement');
    }
    // Suite login alone never requires a period: an action that is not
    // period-bound (ordinary WB-M use) resolves without any evidence, so
    // consumers must not call this at login expecting a shift.
    const action = input.action;
    if (action && !requiresWorkPeriod(input.capabilities, action)) {
        return {
            outcome: 'NO_PERIOD_REQUIRED', ...base,
            action,
            reason: action === 'app_use' ? 'ordinary_app_use' : 'company_does_not_require_period_for_action',
        };
    }
    const verifiedAtIso = new Date(input.nowMs).toISOString();
    // ── explicit_shift ───────────────────────────────────────────────────────
    if (mode === 'explicit_shift') {
        const ev = input.evidence;
        if (!ev || !ev.today) {
            return { outcome: 'UNVERIFIED_OFFLINE', ...base, mode, reason: 'no_authoritative_evidence_supplied' };
        }
        const today = ev.today;
        // 1. Today's authoritative document names an open shift.
        if (today.readable && today.present && typeof today.currentShiftId === 'string' && today.currentShiftId.length > 0) {
            return {
                outcome: 'ACTIVE_EXPLICIT_SHIFT', ...base, mode,
                periodId: today.currentShiftId,
                startIso: null, endIso: null,
                timezone: cfg?.timezone ?? null,
                source: 'authoritative_today',
                verifiedAtIso,
            };
        }
        // 2. Otherwise the only way a shift can still be open is an OVERNIGHT
        //    shift whose origin day still names it. The cache alone proves
        //    nothing — its origin day must confirm.
        const cached = ev.cachedShiftId || null;
        if (cached) {
            const verdict = verifyAgainstOriginDay(cached, ev.cachedOriginDay);
            if (verdict === 'open') {
                return {
                    outcome: 'ACTIVE_EXPLICIT_SHIFT', ...base, mode,
                    periodId: cached,
                    startIso: null, endIso: null,
                    timezone: cfg?.timezone ?? null,
                    source: 'authoritative_origin_day',
                    verifiedAtIso,
                };
            }
            if (verdict === 'closed') {
                return {
                    outcome: 'CLOSED_OR_SUPERSEDED', ...base, mode,
                    closedPeriodId: cached,
                    reason: today.readable && today.present && today.currentShiftId === ''
                        ? 'ended_today_and_origin_day_not_open'
                        : 'origin_day_ended_or_superseded',
                };
            }
            // Cache exists but could not be verified — never assume it is open.
            return { outcome: 'UNVERIFIED_OFFLINE', ...base, mode, reason: 'cached_shift_unverified' };
        }
        // 3. No cache. Today's doc decides.
        if (!today.readable) {
            return { outcome: 'UNVERIFIED_OFFLINE', ...base, mode, reason: 'today_document_unreadable' };
        }
        if (today.present && today.currentShiftId === '') {
            return { outcome: 'CLOSED_OR_SUPERSEDED', ...base, mode, closedPeriodId: null, reason: 'shift_explicitly_ended' };
        }
        return { outcome: 'NO_ACTIVE_SHIFT', ...base, mode, reason: 'no_shift_started' };
    }
    // ── company_defined_period ───────────────────────────────────────────────
    if (!isValidTimezone(cfg?.timezone))
        return invalid(input, 'invalid_or_missing_timezone');
    if (!cfg?.startLocalTime || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(cfg.startLocalTime)) {
        return invalid(input, 'invalid_or_missing_start_local_time');
    }
    const duration = cfg.durationMinutes;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 24 * 60) {
        return invalid(input, 'invalid_or_missing_duration_minutes');
    }
    const tz = cfg.timezone;
    const todayLocal = localDateInZone(tz, input.nowMs);
    let startMs = zonedWallTimeToUtcMs(tz, todayLocal, cfg.startLocalTime);
    if (input.nowMs < startMs) {
        // Before today's boundary → the CURRENT period began on the previous
        // local day (this is what makes overnight schedules work).
        const prev = new Date(Date.parse(`${todayLocal}T00:00:00Z`) - 86400000);
        const prevLocal = `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(prev.getUTCDate())}`;
        startMs = zonedWallTimeToUtcMs(tz, prevLocal, cfg.startLocalTime);
    }
    const endMs = startMs + duration * 60000;
    if (input.nowMs >= endMs) {
        // Between periods (schedule shorter than a day) — no current period.
        return { outcome: 'NO_ACTIVE_SHIFT', ...base, mode, reason: 'outside_configured_period' };
    }
    const startLocalDate = localDateInZone(tz, startMs);
    return {
        outcome: 'CURRENT_DERIVED_PERIOD', ...base, mode,
        periodId: `${startLocalDate}_${cfg.startLocalTime.replace(':', '')}`,
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(endMs).toISOString(),
        timezone: tz,
        source: 'derived_from_configuration',
        verifiedAtIso,
    };
}
//# sourceMappingURL=resolver.js.map