'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { httpsCallable } from 'firebase/functions';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { SubHeader } from '@/components/SubHeader';
import { getFirebaseFunctions } from '@/lib/firebase';

type LoadedCounts = {
  drivers: number;
  shifts: number;
  invoices: number;
  dispatches: number;
  jsas: number;
};

type Warning = {
  kind: string;
  message: string;
  subject?: Record<string, unknown>;
};

type TruthSummary = {
  operators: number;
  sessions: number;
  openSessions: number;
  locations: number;
  activities: number;
  jsaViews: number;
  events: number;
};

type CanonicalSummary = {
  operators: number;
  locations: number;
  activities: number;
};

type ComparisonPair = { rawCount: number; canonicalCount: number };

type ResultState = {
  date: string;
  companyId: string | null;
  generatedAt: string;
  loaded: LoadedCounts;
  sourceErrors: string[];
  truth: TruthSummary;
  canonical: CanonicalSummary;
  comparison: {
    operator: ComparisonPair;
    location: ComparisonPair;
    activity: ComparisonPair;
  };
  notableFindings: string[];
  warnings: Warning[];
  rag: {
    rawCount: number;
    canonicalCount: number;
    eventCount: number;
    jsaRecordCount: number;
    sessionRecordCount: number;
    summaryRecordCount: number;
  };
  identityHealth: IdentityHealthDashboardClientState | null;
  identityHealthError: string | null;
  locationHealth: LocationHealthDashboardClientState | null;
  locationHealthError: string | null;
};

// ── Phase 10 — Identity Health client-side shapes ─────────────────────────

type IdentitySeverity = 'low' | 'medium' | 'high';
type IdentityHeadlineStatus = 'healthy' | 'watch' | 'risky';

type IdentityHealthSummaryState = {
  totalCanonicalOperators: number;
  strongCount: number;
  weakCount: number;
  mergedCount: number;
  parallelIdentityCount: number;
  unresolvedCount: number;
  highSeverityCount: number;
  mediumSeverityCount: number;
  lowSeverityCount: number;
};

type IdentityIssueGroupState = {
  kind: 'weak_identity' | 'parallel_identity' | 'merged_identity' | 'unresolved_identity';
  count: number;
  operatorKeys: string[];
};

type TopRiskyOperatorState = {
  canonicalOperatorKey: string;
  displayName?: string;
  severity: IdentitySeverity;
  reasons: string[];
};

type OperatorIdentityDiagnosticState = TopRiskyOperatorState & {
  linkedKeys: string[];
  linkedKeyCount: number;
  identityConfidence: 'strong' | 'weak';
  sourceIdentities: {
    hasHash?: boolean;
    hasUid?: boolean;
    hasNameOnly?: boolean;
  };
  warningKinds: string[];
  rawOperatorKeys: string[];
  legacyIdentifiers?: string[];
  hasParallelIdentities: boolean;
  isMergedIdentity: boolean;
  isUnresolved: boolean;
};

type IdentityHealthDashboardClientState = {
  headlineStatus: IdentityHeadlineStatus;
  summary: IdentityHealthSummaryState;
  topIssueGroups: IdentityIssueGroupState[];
  topRiskyOperators: TopRiskyOperatorState[];
  diagnostics: OperatorIdentityDiagnosticState[];
  generatedAt: string;
};

// ── Phase 11 — Location Health client-side shapes ─────────────────────────

type LocationConfidence = 'strong' | 'medium' | 'weak';
type LocationKind = 'well' | 'disposal' | 'yard' | 'pad' | 'custom' | 'unknown';

type LocationHealthSummaryState = {
  totalCanonicalLocations: number;
  strongCount: number;
  mediumCount: number;
  weakCount: number;
  customOnlyCount: number;
  officialBackedCount: number;
  mergedAliasCount: number;
};

type TopAliasGroupState = {
  canonicalLocationKey: string;
  preferredName: string;
  aliasCount: number;
  aliases: string[];
  kind?: LocationKind;
  confidence: LocationConfidence;
};

type CustomOnlyLocationEntryState = {
  canonicalLocationKey: string;
  preferredName: string;
  kind?: LocationKind;
  reasons: string[];
};

// Phase 13/15/16 — additive shapes surfaced through the existing
// getLocationHealthView callable. All new fields are optional on the client
// so the UI stays backward-safe if the deployed Cloud Function predates the
// local truth-layer Phase 13-16 work.
type LocationConvergenceDispositionState = 'candidate' | 'hold' | 'exclude';
type LocationReviewDispositionState = 'unreviewed' | 'approved' | 'rejected';
type LocationEffectiveConvergenceState = {
  effectiveLocationKey: string;
  effectiveDisplayName: string;
  appliedByRule: 'approved_review';
  sourceCanonicalLocationKey: string;
};

type LocationIdentityDiagnosticState = {
  canonicalLocationKey: string;
  preferredName: string;
  aliases: string[];
  aliasCount: number;
  kind?: LocationKind;
  confidence: LocationConfidence;
  sourceKinds: {
    hasNdic?: boolean;
    hasSwd?: boolean;
    hasWellConfig?: boolean;
    hasFallbackOnly?: boolean;
  };
  reasons: string[];
  isCustomOnly: boolean;
  isOfficialBacked: boolean;
  isMergedAliasSet: boolean;
  // Optional Phase 13/15/16 additions — present when the deployed callable
  // is at least at Phase 13/15/16. UI guards on undefined.
  convergenceDisposition?: LocationConvergenceDispositionState;
  reviewDisposition?: LocationReviewDispositionState;
  effectiveConvergence?: LocationEffectiveConvergenceState;
};

type LocationReviewCountsState = {
  approved: number;
  rejected: number;
  unreviewed: number;
};

type LocationEffectiveConvergenceCountsState = {
  appliedCount: number;
  unappliedCount: number;
};

type LocationHealthDashboardClientState = {
  summary: LocationHealthSummaryState;
  topAliasGroups: TopAliasGroupState[];
  customOnlyLocations: CustomOnlyLocationEntryState[];
  diagnostics: LocationIdentityDiagnosticState[];
  // Optional aggregate blocks from Phase 15/16. Absent on older payloads.
  reviewCounts?: LocationReviewCountsState;
  effectiveConvergenceCounts?: LocationEffectiveConvergenceCountsState;
  generatedAt: string;
};

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function TruthDebugPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [date, setDate] = useState(todayIso());
  const [companyId, setCompanyId] = useState('');
  const [result, setResult] = useState<ResultState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && (!user || (user.role !== 'admin' && user.role !== 'it'))) {
      router.push('/');
    }
  }, [user, loading, router]);

  async function runShadow() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const functions = getFirebaseFunctions();
      const payload: { date: string; companyId?: string } = { date };
      const trimmed = companyId.trim();
      if (trimmed) payload.companyId = trimmed;

      const getModel = httpsCallable(functions, 'getDashboardReadModelForDay');
      const getShadow = httpsCallable(functions, 'getShadowComparisonForDay');
      const getRag = httpsCallable(functions, 'getRAGIngestBundleForDay');
      const getHealth = httpsCallable(functions, 'getIdentityHealthView');
      const getLocationHealth = httpsCallable(functions, 'getLocationHealthView');

      // Identity Health + Location Health are additive — if either fails, the
      // rest of the page still renders. We capture each error separately.
      const [mRes, sRes, rRes, hRes, lhRes] = await Promise.all([
        getModel(payload),
        getShadow(payload),
        getRag(payload),
        getHealth({ ...payload, includeDiagnostics: true }).catch((err) => ({
          __healthFailure: err instanceof Error ? err.message : String(err),
        })),
        getLocationHealth({ ...payload, includeDiagnostics: true }).catch(
          (err) => ({
            __locationHealthFailure:
              err instanceof Error ? err.message : String(err),
          })
        ),
      ]);
      const mData = mRes.data as {
        model: {
          dashboardView: {
            counts: TruthSummary;
          };
          canonicalDashboardView: {
            operators: unknown[];
            locations: unknown[];
            activities: unknown[];
          };
          comparison: {
            operatorCompression: ComparisonPair;
            locationCompression: ComparisonPair;
            activityCompression: ComparisonPair;
          };
          warnings: Warning[];
          generatedAt: string;
        };
        sourceErrors: string[];
        loaded: LoadedCounts;
      };
      const sData = sRes.data as {
        shadow: { notableFindings: string[] };
      };
      const rData = rRes.data as {
        rag: {
          stats: ResultState['rag'];
        };
      };

      let identityHealth: IdentityHealthDashboardClientState | null = null;
      let identityHealthError: string | null = null;
      if ('__healthFailure' in hRes) {
        identityHealthError = (hRes as { __healthFailure: string }).__healthFailure;
      } else {
        const hData = (hRes as { data: unknown }).data as {
          dashboard: Omit<IdentityHealthDashboardClientState, 'diagnostics'>;
          view?: { diagnostics: OperatorIdentityDiagnosticState[] };
        };
        identityHealth = {
          ...hData.dashboard,
          diagnostics: hData.view?.diagnostics ?? [],
        };
      }

      let locationHealth: LocationHealthDashboardClientState | null = null;
      let locationHealthError: string | null = null;
      if ('__locationHealthFailure' in lhRes) {
        locationHealthError = (lhRes as { __locationHealthFailure: string })
          .__locationHealthFailure;
      } else {
        const lhData = (lhRes as { data: unknown }).data as {
          dashboard: Omit<LocationHealthDashboardClientState, 'diagnostics'>;
          view?: { diagnostics: LocationIdentityDiagnosticState[] };
        };
        locationHealth = {
          ...lhData.dashboard,
          diagnostics: lhData.view?.diagnostics ?? [],
        };
      }

      setResult({
        date,
        companyId: trimmed || null,
        generatedAt: mData.model.generatedAt,
        loaded: mData.loaded,
        sourceErrors: mData.sourceErrors,
        truth: mData.model.dashboardView.counts,
        canonical: {
          operators: mData.model.canonicalDashboardView.operators.length,
          locations: mData.model.canonicalDashboardView.locations.length,
          activities: mData.model.canonicalDashboardView.activities.length,
        },
        comparison: {
          operator: mData.model.comparison.operatorCompression,
          location: mData.model.comparison.locationCompression,
          activity: mData.model.comparison.activityCompression,
        },
        notableFindings: sData.shadow.notableFindings,
        warnings: mData.model.warnings,
        rag: rData.rag.stats,
        identityHealth,
        identityHealthError,
        locationHealth,
        locationHealthError,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="p-6 text-gray-400">Loading…</div>;
  }
  if (!user) return null;

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <AppHeader />
      <SubHeader
        backHref="/admin"
        title="Truth Debug (Shadow)"
        subtitle="Read-only admin surface over the truth + canonical layers. No writes."
      />

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        <section className="bg-gray-800 rounded p-4 flex flex-wrap items-end gap-4">
          <label className="flex flex-col">
            <span className="text-sm text-gray-400">Date (YYYY-MM-DD)</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="bg-gray-700 px-2 py-1 rounded text-white"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-sm text-gray-400">Company ID (blank = all)</span>
            <input
              type="text"
              value={companyId}
              placeholder="e.g. mongoose"
              onChange={(e) => setCompanyId(e.target.value)}
              className="bg-gray-700 px-2 py-1 rounded text-white min-w-[16rem]"
            />
          </label>
          <button
            onClick={runShadow}
            disabled={busy || !date}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2 rounded font-medium"
          >
            {busy ? 'Running…' : 'Run shadow read'}
          </button>
          {result && (
            <div className="text-xs text-gray-400 ml-auto">
              generatedAt: {result.generatedAt}
            </div>
          )}
        </section>

        {error && (
          <section className="bg-red-900/40 border border-red-700 rounded p-4 text-red-200">
            <div className="font-semibold mb-1">Call failed</div>
            <pre className="text-xs whitespace-pre-wrap">{error}</pre>
            <div className="text-xs mt-2 text-red-300/80">
              Ensure you are signed in as admin/it (not DEV_MODE). The endpoint
              requires Firebase Auth + RTDB users/{'{uid}'}.role to be admin or it.
            </div>
          </section>
        )}

        {result && (
          <>
            <Section title="1. Integrated Truth Summary">
              <KV label="operators" value={result.truth.operators} />
              <KV label="sessions" value={result.truth.sessions} />
              <KV label="open sessions" value={result.truth.openSessions} />
              <KV label="locations" value={result.truth.locations} />
              <KV label="activities" value={result.truth.activities} />
              <KV label="jsaViews" value={result.truth.jsaViews} />
              <KV label="events" value={result.truth.events} />
              <div className="col-span-full border-t border-gray-700 pt-2 mt-2 text-xs text-gray-400">
                Loaded from Firestore/RTDB:{' '}
                drivers={result.loaded.drivers}, shifts={result.loaded.shifts},
                invoices={result.loaded.invoices},
                dispatches={result.loaded.dispatches}, jsas={result.loaded.jsas}
              </div>
              {result.sourceErrors.length > 0 && (
                <div className="col-span-full text-xs text-amber-400">
                  sourceErrors: {result.sourceErrors.join('; ')}
                </div>
              )}
            </Section>

            <Section title="2. Canonical Dashboard Summary">
              <KV label="canonical operators" value={result.canonical.operators} />
              <KV label="canonical locations" value={result.canonical.locations} />
              <KV label="canonical activities" value={result.canonical.activities} />
            </Section>

            <Section title="3. Raw vs Canonical Comparison">
              <CompRow label="operators" pair={result.comparison.operator} />
              <CompRow label="locations" pair={result.comparison.location} />
              <CompRow label="activities" pair={result.comparison.activity} />
              <div className="col-span-full border-t border-gray-700 pt-2 mt-2">
                <div className="text-sm text-gray-300 mb-1">Notable findings</div>
                <ul className="text-xs font-mono text-gray-200 space-y-1">
                  {result.notableFindings.map((f, i) => (
                    <li key={i}>- {f}</li>
                  ))}
                </ul>
              </div>
            </Section>

            <Section title="4. Validation Warnings">
              <div className="col-span-full text-sm text-gray-300 mb-2">
                Total: {result.warnings.length}
              </div>
              {result.warnings.length === 0 ? (
                <div className="col-span-full text-xs text-gray-500">
                  (none)
                </div>
              ) : (
                <ul className="col-span-full text-xs font-mono text-gray-200 space-y-1 max-h-72 overflow-auto">
                  {result.warnings.map((w, i) => (
                    <li key={i} className="border-b border-gray-700/40 py-1">
                      <span className="text-amber-400">[{w.kind}]</span>{' '}
                      {w.message}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="5. RAG Bundle Stats">
              <KV label="raw records" value={result.rag.rawCount} />
              <KV label="canonical records" value={result.rag.canonicalCount} />
              <KV label="events" value={result.rag.eventCount} />
              <KV label="JSA records" value={result.rag.jsaRecordCount} />
              <KV label="session records" value={result.rag.sessionRecordCount} />
              <KV label="summary records" value={result.rag.summaryRecordCount} />
              <div className="col-span-full text-xs text-gray-400">
                Derived output target (manual export): truth_rag_exports
              </div>
            </Section>

            <IdentityHealthSection
              health={result.identityHealth}
              error={result.identityHealthError}
            />

            <LocationHealthSection
              health={result.locationHealth}
              error={result.locationHealthError}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ── Phase 10 — Identity Health section ──────────────────────────────────────

function headlineBadge(status: IdentityHeadlineStatus): string {
  if (status === 'healthy') return 'bg-green-800/40 text-green-200';
  if (status === 'watch') return 'bg-amber-800/40 text-amber-200';
  return 'bg-red-800/40 text-red-200';
}

function severityBadge(sev: IdentitySeverity): string {
  if (sev === 'high') return 'bg-red-800/40 text-red-200';
  if (sev === 'medium') return 'bg-amber-800/40 text-amber-200';
  return 'bg-gray-700 text-gray-300';
}

function IdentityHealthSection({
  health,
  error,
}: {
  health: IdentityHealthDashboardClientState | null;
  error: string | null;
}) {
  return (
    <section className="bg-gray-800 rounded p-4">
      <h3 className="text-sm font-semibold text-white mb-3">
        6. Identity Health
      </h3>
      {error && (
        <div className="p-3 rounded bg-red-900/40 border border-red-700 text-red-200 text-xs mb-3">
          <div className="font-semibold mb-1">Identity Health callable failed</div>
          <pre className="whitespace-pre-wrap">{error}</pre>
        </div>
      )}
      {!health && !error && (
        <div className="text-xs text-gray-400">
          Run a shadow read to populate identity health.
        </div>
      )}
      {health && (
        <div className="space-y-4">
          {/* Headline + summary counts */}
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`text-xs uppercase font-semibold tracking-wide px-2 py-1 rounded ${headlineBadge(
                health.headlineStatus
              )}`}
            >
              {health.headlineStatus}
            </span>
            <span className="text-xs text-gray-400">
              generatedAt: {health.generatedAt}
            </span>
          </div>
          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-x-6 gap-y-2">
            <KV label="total" value={health.summary.totalCanonicalOperators} />
            <KV label="strong" value={health.summary.strongCount} />
            <KV label="weak" value={health.summary.weakCount} />
            <KV label="merged" value={health.summary.mergedCount} />
            <KV label="parallel" value={health.summary.parallelIdentityCount} />
            <KV label="unresolved" value={health.summary.unresolvedCount} />
            <KV label="high" value={health.summary.highSeverityCount} />
            <KV label="medium" value={health.summary.mediumSeverityCount} />
            <KV label="low" value={health.summary.lowSeverityCount} />
          </div>

          {/* Issue groups */}
          <div>
            <div className="text-xs text-gray-400 uppercase mb-1">
              Top Issue Groups
            </div>
            {health.topIssueGroups.length === 0 ? (
              <div className="text-xs text-gray-500">
                (no issue groups — identity layer looks stable)
              </div>
            ) : (
              <ul className="text-xs font-mono text-gray-200 space-y-1">
                {health.topIssueGroups.map((g) => (
                  <li key={g.kind}>
                    <span className="text-amber-300">[{g.kind}]</span>{' '}
                    {g.count} operator{g.count === 1 ? '' : 's'}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Top risky operators */}
          <div>
            <div className="text-xs text-gray-400 uppercase mb-1">
              Top Risky Operators
            </div>
            {health.topRiskyOperators.length === 0 ? (
              <div className="text-xs text-gray-500">(none)</div>
            ) : (
              <ul className="space-y-1">
                {health.topRiskyOperators.map((op) => (
                  <li
                    key={op.canonicalOperatorKey}
                    className="text-xs flex items-baseline gap-2 flex-wrap"
                  >
                    <span
                      className={`uppercase px-1.5 py-0.5 rounded ${severityBadge(
                        op.severity
                      )}`}
                    >
                      {op.severity}
                    </span>
                    <span className="text-white">{op.displayName ?? '—'}</span>
                    <span className="font-mono text-gray-400">
                      {op.canonicalOperatorKey}
                    </span>
                    <span className="text-gray-300">
                      {op.reasons.join('; ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Drilldown */}
          {health.diagnostics.length > 0 && (
            <details className="bg-gray-900/60 rounded border border-gray-800">
              <summary className="px-3 py-2 cursor-pointer text-xs text-gray-400 uppercase tracking-wide">
                Drilldown — all {health.diagnostics.length} operators
              </summary>
              <div className="px-3 pb-3 space-y-2 max-h-96 overflow-auto">
                {health.diagnostics.map((d) => (
                  <div
                    key={d.canonicalOperatorKey}
                    className="text-xs border-b border-gray-800/60 pb-2"
                  >
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span
                        className={`uppercase px-1.5 py-0.5 rounded ${severityBadge(
                          d.severity
                        )}`}
                      >
                        {d.severity}
                      </span>
                      <span className="text-white">{d.displayName ?? '—'}</span>
                      <span className="font-mono text-gray-400">
                        {d.canonicalOperatorKey}
                      </span>
                      <span className="text-gray-300 text-[11px]">
                        {d.identityConfidence} identity
                      </span>
                    </div>
                    <div className="text-gray-400 font-mono text-[11px] mt-0.5">
                      linkedKeys ({d.linkedKeyCount}):{' '}
                      {d.linkedKeys.join(', ')}
                    </div>
                    <div className="text-gray-400 font-mono text-[11px]">
                      sourceIdentities: {JSON.stringify(d.sourceIdentities)}
                    </div>
                    {d.warningKinds.length > 0 && (
                      <div className="text-amber-300 font-mono text-[11px]">
                        warnings: {d.warningKinds.join(', ')}
                      </div>
                    )}
                    {d.reasons.length > 0 && (
                      <div className="text-gray-300 text-[11px]">
                        reasons: {d.reasons.join('; ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-gray-800 rounded p-4">
      <h3 className="text-sm font-semibold text-white mb-3">{title}</h3>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-2">
        {children}
      </div>
    </section>
  );
}

function KV({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs text-gray-400">{label}</span>
      <span className="text-sm font-mono text-white">{value}</span>
    </div>
  );
}

function CompRow({ label, pair }: { label: string; pair: ComparisonPair }) {
  return (
    <div className="flex items-baseline justify-between gap-4 col-span-full md:col-span-1">
      <span className="text-xs text-gray-400">{label}</span>
      <span className="text-sm font-mono text-white">
        {pair.rawCount} → {pair.canonicalCount}
      </span>
    </div>
  );
}

// ── Phase 11 — Location Health section ──────────────────────────────────────

function locationConfidenceBadge(c: LocationConfidence): string {
  if (c === 'strong') return 'bg-green-800/40 text-green-200';
  if (c === 'medium') return 'bg-sky-800/40 text-sky-200';
  return 'bg-amber-800/40 text-amber-200';
}

// Phase 15 review disposition badge — matches the color language used for
// identity-health severity so admins read it at a glance.
function reviewBadge(d: LocationReviewDispositionState): string {
  if (d === 'approved') return 'bg-green-800/40 text-green-200';
  if (d === 'rejected') return 'bg-red-800/40 text-red-200';
  return 'bg-amber-800/40 text-amber-200';
}

// Phase 13 convergence disposition chip — informational, same palette as
// confidence badges but distinct from the review badge.
function convergenceChip(
  d: LocationConvergenceDispositionState
): string {
  if (d === 'candidate') return 'bg-green-900/40 text-green-300';
  if (d === 'hold') return 'bg-sky-900/40 text-sky-300';
  return 'bg-gray-800 text-gray-400';
}

function LocationHealthSection({
  health,
  error,
}: {
  health: LocationHealthDashboardClientState | null;
  error: string | null;
}) {
  return (
    <section className="bg-gray-800 rounded p-4">
      <h3 className="text-sm font-semibold text-white mb-3">
        7. Location Health
      </h3>
      {error && (
        <div className="p-3 rounded bg-red-900/40 border border-red-700 text-red-200 text-xs mb-3">
          <div className="font-semibold mb-1">Location Health callable failed</div>
          <pre className="whitespace-pre-wrap">{error}</pre>
        </div>
      )}
      {!health && !error && (
        <div className="text-xs text-gray-400">
          Run a shadow read to populate location health.
        </div>
      )}
      {health && (
        <div className="space-y-4">
          <div className="text-xs text-gray-400">
            generatedAt: {health.generatedAt}
          </div>

          {/* Summary counts */}
          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-x-6 gap-y-2">
            <KV label="total" value={health.summary.totalCanonicalLocations} />
            <KV label="strong" value={health.summary.strongCount} />
            <KV label="medium" value={health.summary.mediumCount} />
            <KV label="weak" value={health.summary.weakCount} />
            <KV label="customOnly" value={health.summary.customOnlyCount} />
            <KV label="officialBacked" value={health.summary.officialBackedCount} />
            <KV label="mergedAlias" value={health.summary.mergedAliasCount} />
          </div>

          {/* Phase 15/16 — review + effective-application counts (only when
              the deployed callable has carried them through; older payloads
              skip this row silently). */}
          {(health.reviewCounts || health.effectiveConvergenceCounts) && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2">
              {health.reviewCounts && (
                <>
                  <KV label="approved" value={health.reviewCounts.approved} />
                  <KV
                    label="unreviewed"
                    value={health.reviewCounts.unreviewed}
                  />
                  <KV label="rejected" value={health.reviewCounts.rejected} />
                </>
              )}
              {health.effectiveConvergenceCounts && (
                <KV
                  label="applied"
                  value={health.effectiveConvergenceCounts.appliedCount}
                />
              )}
            </div>
          )}

          {/* Top grouped alias sets */}
          <div>
            <div className="text-xs text-gray-400 uppercase mb-1">
              Top Grouped Alias Sets
            </div>
            {health.topAliasGroups.length === 0 ? (
              <div className="text-xs text-gray-500">(no merged alias sets)</div>
            ) : (
              <ul className="space-y-1">
                {health.topAliasGroups.map((g) => (
                  <li
                    key={g.canonicalLocationKey}
                    className="text-xs flex items-baseline gap-2 flex-wrap"
                  >
                    <span className="text-white">{g.preferredName}</span>
                    <span
                      className={`uppercase px-1.5 py-0.5 rounded text-[10px] ${locationConfidenceBadge(
                        g.confidence
                      )}`}
                    >
                      {g.confidence}
                    </span>
                    <span className="text-gray-400 font-mono">
                      {g.aliasCount} aliases
                    </span>
                    <span className="text-gray-300 font-mono text-[11px]">
                      {g.aliases.join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Custom-only locations */}
          <div>
            <div className="text-xs text-gray-400 uppercase mb-1">
              Custom / Fallback-Only Locations
            </div>
            {health.customOnlyLocations.length === 0 ? (
              <div className="text-xs text-gray-500">(none)</div>
            ) : (
              <ul className="space-y-1">
                {health.customOnlyLocations.map((l) => (
                  <li
                    key={l.canonicalLocationKey}
                    className="text-xs flex items-baseline gap-2 flex-wrap"
                  >
                    <span className="text-white">{l.preferredName}</span>
                    {l.kind && (
                      <span className="text-[10px] text-gray-400">
                        kind={l.kind}
                      </span>
                    )}
                    <span className="text-gray-400 font-mono">
                      {l.canonicalLocationKey}
                    </span>
                    <span className="text-gray-300">{l.reasons.join('; ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Expandable full diagnostics */}
          {health.diagnostics.length > 0 && (
            <details className="bg-gray-900/60 rounded border border-gray-800">
              <summary className="px-3 py-2 cursor-pointer text-xs text-gray-400 uppercase tracking-wide">
                Drilldown — all {health.diagnostics.length} locations
              </summary>
              <div className="px-3 pb-3 space-y-2 max-h-96 overflow-auto">
                {health.diagnostics.map((d) => {
                  const eff = d.effectiveConvergence;
                  const rawMatchesEffective =
                    !!eff && eff.effectiveDisplayName === d.preferredName;
                  return (
                    <div
                      key={d.canonicalLocationKey}
                      className="text-xs border-b border-gray-800/60 pb-2"
                    >
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span
                          className={`uppercase px-1.5 py-0.5 rounded text-[10px] ${locationConfidenceBadge(
                            d.confidence
                          )}`}
                        >
                          {d.confidence}
                        </span>
                        <span className="text-white">{d.preferredName}</span>
                        <span className="font-mono text-gray-400">
                          {d.canonicalLocationKey}
                        </span>
                        {d.kind && (
                          <span className="text-[10px] text-gray-400">
                            kind={d.kind}
                          </span>
                        )}
                        {d.convergenceDisposition && (
                          <span
                            className={`uppercase px-1.5 py-0.5 rounded text-[10px] ${convergenceChip(
                              d.convergenceDisposition
                            )}`}
                          >
                            {d.convergenceDisposition}
                          </span>
                        )}
                        {d.reviewDisposition && (
                          <span
                            className={`uppercase px-1.5 py-0.5 rounded text-[10px] ${reviewBadge(
                              d.reviewDisposition
                            )}`}
                          >
                            {d.reviewDisposition}
                          </span>
                        )}
                      </div>
                      <div className="text-gray-400 font-mono text-[11px] mt-0.5">
                        sourceKinds: {JSON.stringify(d.sourceKinds)}
                      </div>
                      <div className="text-gray-400 font-mono text-[11px]">
                        aliases ({d.aliasCount}):{' '}
                        {d.aliases.length > 0 ? d.aliases.join(', ') : '—'}
                      </div>
                      {d.reasons.length > 0 && (
                        <div className="text-gray-300 text-[11px]">
                          reasons: {d.reasons.join('; ')}
                        </div>
                      )}
                      {/* Phase 16 — derived effective identity. Read-only
                          hook; never rewrites any source field shown above. */}
                      {eff ? (
                        <div className="mt-1 text-[11px]">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-gray-500 uppercase tracking-wide text-[10px]">
                              effective
                            </span>
                            <span className="text-white">
                              {eff.effectiveDisplayName}
                            </span>
                            <span className="font-mono text-gray-400">
                              {eff.effectiveLocationKey}
                            </span>
                            <span
                              className={`text-[10px] ${
                                rawMatchesEffective
                                  ? 'text-gray-500'
                                  : 'text-amber-300'
                              }`}
                            >
                              {rawMatchesEffective
                                ? 'raw and effective match'
                                : 'effective differs from raw'}
                            </span>
                          </div>
                          <div className="text-gray-500 font-mono text-[10px]">
                            appliedByRule: {eff.appliedByRule}
                          </div>
                        </div>
                      ) : (
                        d.reviewDisposition !== undefined && (
                          <div className="mt-1 text-[11px] text-gray-500 italic">
                            effective: not applied
                          </div>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
