/**
 * Conformance fixtures (vc51.9A) — every consumer runs these and must
 * produce byte-identical outcomes. Drift between WB-S, WB-T and WB-JSA is
 * what produced the 8/6 stale-shift failure; these pin it shut.
 *
 * Field-derived constants are real observed values from that incident.
 */
import { type CompanyWorkPeriodConfiguration, type EffectiveCompanyCapabilities, type ResolveInput } from './types.js';
export declare const LIQUID_GOLD_TIMEZONE = "America/Chicago";
/** Liquid Gold's confirmed mode (vc51.9A decision 2). */
export declare const LIQUID_GOLD_CONFIG: CompanyWorkPeriodConfiguration;
export declare const LIQUID_GOLD_CAPS: EffectiveCompanyCapabilities;
export interface ConformanceCase {
    name: string;
    input: ResolveInput;
    expect: {
        outcome: string;
        periodId?: string | null;
        source?: string;
    };
}
export declare const CONFORMANCE_CASES: ConformanceCase[];
/**
 * Mixed-workflow cases (vc51.9A3). WB-M testers and Mike are the SAME
 * Liquid Gold company: ordinary authenticated app use requires no period,
 * while shift-scoped operational actions require the verified explicit
 * shift. Suite login alone NEVER implies Start Shift.
 */
export declare const MIXED_WORKFLOW_CASES: ConformanceCase[];
//# sourceMappingURL=conformance.d.ts.map