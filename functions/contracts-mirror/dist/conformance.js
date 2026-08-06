/**
 * Conformance fixtures (vc51.9A) — every consumer runs these and must
 * produce byte-identical outcomes. Drift between WB-S, WB-T and WB-JSA is
 * what produced the 8/6 stale-shift failure; these pin it shut.
 *
 * Field-derived constants are real observed values from that incident.
 */
import { CONTRACT_VERSION } from './types.js';
export const LIQUID_GOLD_TIMEZONE = 'America/Chicago';
/** Liquid Gold's confirmed mode (vc51.9A decision 2). */
export const LIQUID_GOLD_CONFIG = {
    contractVersion: CONTRACT_VERSION,
    configurationVersion: 1,
    mode: 'explicit_shift',
    timezone: LIQUID_GOLD_TIMEZONE,
};
export const LIQUID_GOLD_CAPS = {
    contractVersion: CONTRACT_VERSION,
    companyId: 'liquid-gold',
    suiteLoginRequired: true,
    workPeriodMode: 'explicit_shift',
    explicitShiftRequiredBeforeJobs: true,
    jsaEnabled: true,
    dvirEnabled: true,
    customerEditableFields: ['timezone'],
};
const DERIVED_CAPS = {
    ...LIQUID_GOLD_CAPS,
    companyId: 'derived-co',
    workPeriodMode: 'company_defined_period',
    explicitShiftRequiredBeforeJobs: false,
};
const derivedConfig = (startLocalTime, durationMinutes) => ({
    contractVersion: CONTRACT_VERSION,
    configurationVersion: 1,
    mode: 'company_defined_period',
    timezone: LIQUID_GOLD_TIMEZONE,
    startLocalTime,
    durationMinutes,
});
const explicit = (name, evidence, nowIso, expect) => ({
    name,
    input: {
        contractVersion: CONTRACT_VERSION,
        companyId: 'liquid-gold',
        driverId: 'driver-1',
        capabilities: LIQUID_GOLD_CAPS,
        config: LIQUID_GOLD_CONFIG,
        evidence,
        nowMs: Date.parse(nowIso),
    },
    expect,
});
const OPEN = '2026-08-06_060000';
const STALE = '2026-08-05_091221';
export const CONFORMANCE_CASES = [
    // ── explicit_shift ──────────────────────────────────────────────────────
    explicit('liquid gold: shift open today', { today: { readable: true, present: true, currentShiftId: OPEN } }, '2026-08-06T14:00:00Z', { outcome: 'ACTIVE_EXPLICIT_SHIFT', periodId: OPEN, source: 'authoritative_today' }),
    explicit('liquid gold: no shift started after logout (THE 8/6 FIELD CASE)', {
        today: { readable: true, present: false },
        cachedShiftId: STALE,
        cachedOriginDay: { readable: true, present: true, currentShiftId: '' },
    }, '2026-08-06T07:55:00Z', { outcome: 'CLOSED_OR_SUPERSEDED', periodId: undefined }),
    explicit('same-day close with missed logout signal', {
        today: { readable: true, present: true, currentShiftId: '' },
        cachedShiftId: OPEN,
        cachedOriginDay: { readable: true, present: true, currentShiftId: '' },
    }, '2026-08-06T23:00:00Z', { outcome: 'CLOSED_OR_SUPERSEDED' }),
    explicit('prior-day close, no cache at all', { today: { readable: true, present: false } }, '2026-08-06T07:55:00Z', { outcome: 'NO_ACTIVE_SHIFT' }),
    explicit('overnight shift still open on its origin day', {
        today: { readable: true, present: false },
        cachedShiftId: '2026-08-05_210000',
        cachedOriginDay: { readable: true, present: true, currentShiftId: '2026-08-05_210000' },
    }, '2026-08-06T04:00:00Z', { outcome: 'ACTIVE_EXPLICIT_SHIFT', periodId: '2026-08-05_210000', source: 'authoritative_origin_day' }),
    explicit('superseded by a newer shift', {
        today: { readable: true, present: true, currentShiftId: '2026-08-06_140000' },
        cachedShiftId: OPEN,
        cachedOriginDay: { readable: true, present: true, currentShiftId: '2026-08-06_140000' },
    }, '2026-08-06T15:00:00Z', { outcome: 'ACTIVE_EXPLICIT_SHIFT', periodId: '2026-08-06_140000' }),
    explicit('offline: today unreadable, cache unverifiable', {
        today: { readable: false, present: false },
        cachedShiftId: STALE,
        cachedOriginDay: { readable: false, present: false },
    }, '2026-08-06T07:55:00Z', { outcome: 'UNVERIFIED_OFFLINE' }),
    explicit('offline with no cache', { today: { readable: false, present: false } }, '2026-08-06T07:55:00Z', { outcome: 'UNVERIFIED_OFFLINE' }),
    explicit('deep-link hint cannot establish a shift', { today: { readable: true, present: false }, deepLinkShiftId: OPEN }, '2026-08-06T07:55:00Z', { outcome: 'NO_ACTIVE_SHIFT' }),
    explicit('stale cache alone never authorizes work', { today: { readable: true, present: false }, cachedShiftId: STALE, cachedOriginDay: null }, '2026-08-06T07:55:00Z', { outcome: 'UNVERIFIED_OFFLINE' }),
    // ── company_defined_period ──────────────────────────────────────────────
    {
        name: 'derived 06:00–18:00: inside period',
        input: {
            contractVersion: CONTRACT_VERSION, companyId: 'derived-co', driverId: 'driver-1',
            capabilities: DERIVED_CAPS, config: derivedConfig('06:00', 12 * 60),
            nowMs: Date.parse('2026-08-06T15:00:00Z'), // 10:00 CDT
        },
        expect: { outcome: 'CURRENT_DERIVED_PERIOD', periodId: '2026-08-06_0600', source: 'derived_from_configuration' },
    },
    {
        name: 'derived 06:00–18:00: before boundary is outside the period',
        input: {
            contractVersion: CONTRACT_VERSION, companyId: 'derived-co', driverId: 'driver-1',
            capabilities: DERIVED_CAPS, config: derivedConfig('06:00', 12 * 60),
            nowMs: Date.parse('2026-08-06T08:00:00Z'), // 03:00 CDT
        },
        expect: { outcome: 'NO_ACTIVE_SHIFT' },
    },
    {
        name: 'derived overnight 18:00–06:00: after midnight belongs to the prior local day',
        input: {
            contractVersion: CONTRACT_VERSION, companyId: 'derived-co', driverId: 'driver-1',
            capabilities: DERIVED_CAPS, config: derivedConfig('18:00', 12 * 60),
            nowMs: Date.parse('2026-08-06T07:00:00Z'), // 02:00 CDT Aug 6
        },
        expect: { outcome: 'CURRENT_DERIVED_PERIOD', periodId: '2026-08-05_1800' },
    },
    {
        name: 'DST spring forward (2026-03-08 America/Chicago): period id stays anchored to its local day',
        input: {
            contractVersion: CONTRACT_VERSION, companyId: 'derived-co', driverId: 'driver-1',
            capabilities: DERIVED_CAPS, config: derivedConfig('06:00', 12 * 60),
            nowMs: Date.parse('2026-03-08T16:00:00Z'), // 11:00 CDT after the jump
        },
        expect: { outcome: 'CURRENT_DERIVED_PERIOD', periodId: '2026-03-08_0600' },
    },
    {
        name: 'DST fall back (2026-11-01 America/Chicago)',
        input: {
            contractVersion: CONTRACT_VERSION, companyId: 'derived-co', driverId: 'driver-1',
            capabilities: DERIVED_CAPS, config: derivedConfig('06:00', 12 * 60),
            nowMs: Date.parse('2026-11-01T16:00:00Z'), // 10:00 CST after the fall back
        },
        expect: { outcome: 'CURRENT_DERIVED_PERIOD', periodId: '2026-11-01_0600' },
    },
    {
        name: 'invalid timezone fails honestly',
        input: {
            contractVersion: CONTRACT_VERSION, companyId: 'derived-co', driverId: 'driver-1',
            capabilities: DERIVED_CAPS,
            config: { ...derivedConfig('06:00', 720), timezone: 'Mars/Olympus' },
            nowMs: Date.parse('2026-08-06T15:00:00Z'),
        },
        expect: { outcome: 'INVALID_CONFIGURATION' },
    },
    {
        name: 'missing schedule fails honestly (never a UTC-date fallback)',
        input: {
            contractVersion: CONTRACT_VERSION, companyId: 'derived-co', driverId: 'driver-1',
            capabilities: DERIVED_CAPS,
            config: { contractVersion: CONTRACT_VERSION, configurationVersion: 1, mode: 'company_defined_period', timezone: LIQUID_GOLD_TIMEZONE },
            nowMs: Date.parse('2026-08-06T15:00:00Z'),
        },
        expect: { outcome: 'INVALID_CONFIGURATION' },
    },
    {
        name: 'configuration conflicting with entitlement fails honestly',
        input: {
            contractVersion: CONTRACT_VERSION, companyId: 'liquid-gold', driverId: 'driver-1',
            capabilities: LIQUID_GOLD_CAPS, config: derivedConfig('06:00', 720),
            nowMs: Date.parse('2026-08-06T15:00:00Z'),
        },
        expect: { outcome: 'INVALID_CONFIGURATION' },
    },
    {
        name: 'unknown future contract version is refused',
        input: {
            contractVersion: 999, companyId: 'liquid-gold', driverId: 'driver-1',
            capabilities: LIQUID_GOLD_CAPS, config: LIQUID_GOLD_CONFIG,
            evidence: { today: { readable: true, present: true, currentShiftId: OPEN } },
            nowMs: Date.parse('2026-08-06T14:00:00Z'),
        },
        expect: { outcome: 'INVALID_CONFIGURATION' },
    },
];
/**
 * Mixed-workflow cases (vc51.9A3). WB-M testers and Mike are the SAME
 * Liquid Gold company: ordinary authenticated app use requires no period,
 * while shift-scoped operational actions require the verified explicit
 * shift. Suite login alone NEVER implies Start Shift.
 */
export const MIXED_WORKFLOW_CASES = [
    {
        name: 'liquid gold WB-M tester: ordinary app use needs no period (no evidence at all)',
        input: {
            contractVersion: CONTRACT_VERSION, companyId: 'liquid-gold', driverId: 'wbm-tester',
            capabilities: LIQUID_GOLD_CAPS, config: LIQUID_GOLD_CONFIG,
            action: 'app_use', nowMs: Date.parse('2026-08-06T07:55:00Z'),
        },
        expect: { outcome: 'NO_PERIOD_REQUIRED' },
    },
    {
        name: 'liquid gold WB-T job start: verified explicit shift required',
        input: {
            contractVersion: CONTRACT_VERSION, companyId: 'liquid-gold', driverId: 'mike',
            capabilities: LIQUID_GOLD_CAPS, config: LIQUID_GOLD_CONFIG, action: 'wbt_job_start',
            evidence: { today: { readable: true, present: true, currentShiftId: '2026-08-06_060000' } },
            nowMs: Date.parse('2026-08-06T14:00:00Z'),
        },
        expect: { outcome: 'ACTIVE_EXPLICIT_SHIFT', periodId: '2026-08-06_060000' },
    },
    {
        name: 'liquid gold WB-T job start with no shift: blocked, never derived',
        input: {
            contractVersion: CONTRACT_VERSION, companyId: 'liquid-gold', driverId: 'mike',
            capabilities: LIQUID_GOLD_CAPS, config: LIQUID_GOLD_CONFIG, action: 'wbt_job_start',
            evidence: { today: { readable: true, present: false } },
            nowMs: Date.parse('2026-08-06T07:55:00Z'),
        },
        expect: { outcome: 'NO_ACTIVE_SHIFT' },
    },
    {
        name: 'liquid gold WB-JSA request: needs the invoking period',
        input: {
            contractVersion: CONTRACT_VERSION, companyId: 'liquid-gold', driverId: 'mike',
            capabilities: LIQUID_GOLD_CAPS, config: LIQUID_GOLD_CONFIG, action: 'jsa_request',
            evidence: { today: { readable: true, present: false }, cachedShiftId: '2026-08-05_091221',
                cachedOriginDay: { readable: true, present: true, currentShiftId: '' } },
            nowMs: Date.parse('2026-08-06T07:55:00Z'),
        },
        expect: { outcome: 'CLOSED_OR_SUPERSEDED' },
    },
    {
        name: 'liquid gold eQuipment DVIR: needs the invoking shift',
        input: {
            contractVersion: CONTRACT_VERSION, companyId: 'liquid-gold', driverId: 'mike',
            capabilities: LIQUID_GOLD_CAPS, config: LIQUID_GOLD_CONFIG, action: 'equipment_dvir',
            evidence: { today: { readable: true, present: true, currentShiftId: '2026-08-06_060000' } },
            nowMs: Date.parse('2026-08-06T14:00:00Z'),
        },
        expect: { outcome: 'ACTIVE_EXPLICIT_SHIFT', periodId: '2026-08-06_060000' },
    },
];
//# sourceMappingURL=conformance.js.map