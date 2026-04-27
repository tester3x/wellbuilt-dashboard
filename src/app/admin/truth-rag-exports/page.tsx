'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { httpsCallable } from 'firebase/functions';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { SubHeader } from '@/components/SubHeader';
import { getFirebaseFunctions } from '@/lib/firebase';
import { hasCapability } from '@/lib/auth';

// ── Types mirrored from functions/src/truth/truthRagHistory.ts ─────────────

type RunStatus = 'started' | 'completed' | 'failed';
type RunMode = 'manual' | 'rerun' | 'scheduled_prep';

interface RunStats {
  rawCount: number;
  canonicalCount: number;
  eventCount: number;
  jsaRecordCount: number;
  sessionRecordCount: number;
  summaryRecordCount: number;
}

interface RunSummary {
  runId: string;
  date: string;
  companyId: string | null;
  mode: RunMode;
  status: RunStatus;
  generatedAt?: string;
  startedAt?: string;
  completedAt: string | null;
  durationMs: number | null;
  warningCount: number;
  stats: RunStats | null;
  notableFindings: string[];
  triggeredBy: { uid?: string; role?: string } | null;
  sourceErrorCount: number;
  reason: string | null;
  errorMessage: string | null;
}

interface ListResult {
  count: number;
  limit: number;
  runs: RunSummary[];
}

interface RunDetail {
  manifest: Record<string, unknown> & {
    runId: string;
    date: string;
    mode: RunMode;
    status: RunStatus;
    companyId?: string | null;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    warningCount?: number;
    sourceErrors?: string[];
    notableFindings?: string[];
    stats?: RunStats;
    errorMessage?: string;
    reason?: string;
    loaded?: Record<string, number>;
  };
  rawRecordCount: number;
  canonicalRecordCount: number;
  sampleRawRecords: Array<Record<string, unknown>>;
  sampleCanonicalRecords: Array<Record<string, unknown>>;
  sampleSize: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusClass(status: RunStatus): string {
  if (status === 'completed') return 'bg-green-700/40 text-green-200';
  if (status === 'failed') return 'bg-red-700/40 text-red-200';
  return 'bg-amber-700/40 text-amber-200';
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function TruthRagExportsPage() {
  const { user, loading, userCompany } = useAuth();
  const router = useRouter();

  const [date, setDate] = useState(todayIso());
  const [companyId, setCompanyId] = useState('');
  const [reason, setReason] = useState('');

  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [triggerBusy, setTriggerBusy] = useState<'export' | 'rerun' | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.push('/login');
      return;
    }
    if (!hasCapability(user, 'viewTruthDebug', userCompany)) {
      router.push('/');
    }
  }, [user, loading, userCompany, router]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), 'listTruthRagExports');
      const payload: { companyId?: string; limit: number } = { limit: 25 };
      const trimmed = companyId.trim();
      if (trimmed) payload.companyId = trimmed;
      const res = await fn(payload);
      const data = res.data as ListResult;
      setRuns(data.runs);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setHistoryLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    if (!user || loading) return;
    loadHistory();
  }, [user, loading, loadHistory]);

  async function loadDetail(runId: string) {
    setSelectedRunId(runId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), 'getTruthRagExportRun');
      const res = await fn({ runId, sampleSize: 10 });
      setDetail(res.data as RunDetail);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailLoading(false);
    }
  }

  async function runExport(mode: 'export' | 'rerun') {
    setTriggerBusy(mode);
    setTriggerError(null);
    try {
      const fnName =
        mode === 'export' ? 'exportTruthRagForDay' : 'rerunTruthRagExportForDay';
      const fn = httpsCallable(getFirebaseFunctions(), fnName);
      const payload: {
        date: string;
        companyId?: string;
        reason?: string;
      } = { date };
      const trimmedCompany = companyId.trim();
      if (trimmedCompany) payload.companyId = trimmedCompany;
      if (mode === 'rerun' && reason.trim()) payload.reason = reason.trim();
      const res = await fn(payload);
      const data = res.data as { runId: string };
      await loadHistory();
      if (data.runId) await loadDetail(data.runId);
    } catch (err) {
      setTriggerError(err instanceof Error ? err.message : String(err));
    } finally {
      setTriggerBusy(null);
    }
  }

  const hasSelectedRun = !!selectedRunId;
  const lastRun = runs[0];
  const lastStats = lastRun?.stats ?? null;
  const runCount = runs.length;

  const rerunDisabled = !date || triggerBusy !== null;
  const rerunReason = useMemo(() => {
    if (!hasSelectedRun) return 'Select a prior run to re-run its (date, companyId).';
    return null;
  }, [hasSelectedRun]);

  if (loading) {
    return <div className="p-6 text-gray-400">Loading…</div>;
  }
  if (!user) return null;

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <AppHeader />
      <SubHeader
        backHref="/admin"
        title="Truth RAG Exports"
        subtitle="Admin-triggered derived export runs. Writes to truth_rag_exports only."
      />

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* ── Section 0: quick visibility strip ──────────────────────────── */}
        <section className="bg-gray-800 rounded p-4 flex flex-wrap gap-6 items-center">
          <Stat label="run count" value={runCount} />
          <Stat
            label="last status"
            value={lastRun ? lastRun.status : '—'}
            highlight={
              lastRun?.status === 'failed'
                ? 'bad'
                : lastRun?.status === 'started'
                ? 'warn'
                : null
            }
          />
          <Stat
            label="last warnings"
            value={lastRun ? lastRun.warningCount : '—'}
            highlight={lastRun && lastRun.warningCount > 0 ? 'warn' : null}
          />
          <Stat label="last raw" value={lastStats ? lastStats.rawCount : '—'} />
          <Stat
            label="last canonical"
            value={lastStats ? lastStats.canonicalCount : '—'}
          />
          <Link
            href="/admin/truth-debug/"
            className="ml-auto text-xs text-blue-400 hover:text-blue-300 underline"
          >
            /admin/truth-debug
          </Link>
        </section>

        {/* ── Section 1: Trigger panel ───────────────────────────────────── */}
        <section className="bg-gray-800 rounded p-4">
          <h3 className="text-sm font-semibold text-white mb-3">
            1. Export Trigger Panel
          </h3>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col">
              <span className="text-xs text-gray-400">Date (YYYY-MM-DD)</span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="bg-gray-700 px-2 py-1 rounded text-white"
              />
            </label>
            <label className="flex flex-col">
              <span className="text-xs text-gray-400">Company ID (blank = all)</span>
              <input
                type="text"
                value={companyId}
                placeholder="e.g. mongoose"
                onChange={(e) => setCompanyId(e.target.value)}
                className="bg-gray-700 px-2 py-1 rounded text-white min-w-[16rem]"
              />
            </label>
            <label className="flex flex-col">
              <span className="text-xs text-gray-400">Reason (rerun only)</span>
              <input
                type="text"
                value={reason}
                placeholder="optional note for rerun manifest"
                onChange={(e) => setReason(e.target.value)}
                className="bg-gray-700 px-2 py-1 rounded text-white min-w-[18rem]"
              />
            </label>
            <button
              onClick={() => runExport('export')}
              disabled={!date || triggerBusy !== null}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2 rounded font-medium"
            >
              {triggerBusy === 'export' ? 'Exporting…' : 'Run Export'}
            </button>
            <button
              onClick={() => runExport('rerun')}
              disabled={rerunDisabled}
              title={rerunReason ?? ''}
              className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 px-4 py-2 rounded font-medium"
            >
              {triggerBusy === 'rerun' ? 'Rerunning…' : 'Rerun Selected'}
            </button>
          </div>
          {triggerError && (
            <div className="mt-3 p-3 rounded bg-red-900/40 border border-red-700 text-red-200 text-xs">
              <div className="font-semibold mb-1">Export failed</div>
              <pre className="whitespace-pre-wrap">{triggerError}</pre>
              <div className="mt-2 text-red-300/80">
                Ensure you are signed in as admin/it (not DEV_MODE). Callable
                requires Firebase Auth + RTDB users/{'{uid}'}.role to be admin
                or it.
              </div>
            </div>
          )}
        </section>

        {/* ── Section 2: Export Run History ──────────────────────────────── */}
        <section className="bg-gray-800 rounded p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white">
              2. Export Run History
            </h3>
            <button
              onClick={loadHistory}
              disabled={historyLoading}
              className="text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 px-2 py-1 rounded"
            >
              {historyLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {historyError && (
            <div className="mb-3 p-2 rounded bg-red-900/40 border border-red-700 text-red-200 text-xs">
              {historyError}
            </div>
          )}
          {!historyLoading && runs.length === 0 && !historyError && (
            <div className="text-xs text-gray-400">
              No export runs found. Run one above to get started.
            </div>
          )}
          {runs.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700">
                    <th className="text-left font-normal py-2">runId</th>
                    <th className="text-left font-normal py-2">date</th>
                    <th className="text-left font-normal py-2">company</th>
                    <th className="text-left font-normal py-2">mode</th>
                    <th className="text-left font-normal py-2">status</th>
                    <th className="text-right font-normal py-2">raw</th>
                    <th className="text-right font-normal py-2">canonical</th>
                    <th className="text-right font-normal py-2">warn</th>
                    <th className="text-left font-normal py-2">duration</th>
                    <th className="text-left font-normal py-2">startedAt</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr
                      key={r.runId}
                      onClick={() => loadDetail(r.runId)}
                      className={`cursor-pointer hover:bg-gray-700/40 border-b border-gray-700/40 ${
                        selectedRunId === r.runId ? 'bg-gray-700/60' : ''
                      }`}
                    >
                      <td className="py-2 pr-2 font-mono text-gray-200">
                        {r.runId}
                      </td>
                      <td className="py-2 pr-2 font-mono">{r.date}</td>
                      <td className="py-2 pr-2 font-mono text-gray-300">
                        {r.companyId ?? 'all'}
                      </td>
                      <td className="py-2 pr-2">{r.mode}</td>
                      <td className="py-2 pr-2">
                        <span
                          className={`px-2 py-0.5 rounded text-xs ${statusClass(r.status)}`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="py-2 pr-2 text-right font-mono">
                        {r.stats?.rawCount ?? '—'}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono">
                        {r.stats?.canonicalCount ?? '—'}
                      </td>
                      <td
                        className={`py-2 pr-2 text-right font-mono ${
                          r.warningCount > 0 ? 'text-amber-300' : ''
                        }`}
                      >
                        {r.warningCount}
                      </td>
                      <td className="py-2 pr-2 font-mono text-gray-300">
                        {fmtMs(r.durationMs)}
                      </td>
                      <td className="py-2 font-mono text-gray-400">
                        {r.startedAt ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Section 3: Export Run Detail ───────────────────────────────── */}
        <section className="bg-gray-800 rounded p-4">
          <h3 className="text-sm font-semibold text-white mb-3">
            3. Export Run Detail
          </h3>
          {!selectedRunId && (
            <div className="text-xs text-gray-400">
              Click a row in the history table to view its manifest + sample records.
            </div>
          )}
          {detailLoading && (
            <div className="text-xs text-gray-400">Loading detail…</div>
          )}
          {detailError && (
            <div className="p-2 rounded bg-red-900/40 border border-red-700 text-red-200 text-xs">
              {detailError}
            </div>
          )}
          {detail && !detailLoading && (
            <div className="space-y-4">
              <ManifestGrid manifest={detail.manifest} />

              {Array.isArray(detail.manifest.notableFindings) &&
                detail.manifest.notableFindings.length > 0 && (
                  <div className="bg-gray-900 rounded p-3">
                    <div className="text-xs text-gray-500 uppercase mb-2">
                      Notable findings
                    </div>
                    <ul className="text-xs font-mono text-gray-200 space-y-1">
                      {detail.manifest.notableFindings.map((f, i) => (
                        <li key={i}>- {f}</li>
                      ))}
                    </ul>
                  </div>
                )}

              <SampleRecordBlock
                title={`Sample raw records (${detail.sampleRawRecords.length} of ${detail.rawRecordCount})`}
                records={detail.sampleRawRecords}
              />
              <SampleRecordBlock
                title={`Sample canonical records (${detail.sampleCanonicalRecords.length} of ${detail.canonicalRecordCount})`}
                records={detail.sampleCanonicalRecords}
              />
            </div>
          )}
        </section>

        {/* ── Section 4: Warnings / errors ───────────────────────────────── */}
        <section className="bg-gray-800 rounded p-4">
          <h3 className="text-sm font-semibold text-white mb-3">
            4. Warnings / Errors
          </h3>
          {!detail && (
            <div className="text-xs text-gray-400">
              Select a run above to see its warnings and source errors.
            </div>
          )}
          {detail && (
            <div className="space-y-3 text-xs">
              <div className="flex gap-4 flex-wrap">
                <Stat
                  label="warningCount"
                  value={detail.manifest.warningCount ?? 0}
                  highlight={
                    (detail.manifest.warningCount ?? 0) > 0 ? 'warn' : null
                  }
                />
                <Stat
                  label="sourceErrors"
                  value={detail.manifest.sourceErrors?.length ?? 0}
                  highlight={
                    (detail.manifest.sourceErrors?.length ?? 0) > 0
                      ? 'warn'
                      : null
                  }
                />
                <Stat
                  label="status"
                  value={detail.manifest.status}
                  highlight={
                    detail.manifest.status === 'failed' ? 'bad' : null
                  }
                />
              </div>
              {detail.manifest.status === 'failed' && detail.manifest.errorMessage && (
                <div className="p-2 rounded bg-red-900/40 border border-red-700 text-red-200">
                  <div className="text-xs font-semibold mb-1">errorMessage</div>
                  <pre className="whitespace-pre-wrap">
                    {detail.manifest.errorMessage}
                  </pre>
                </div>
              )}
              {detail.manifest.sourceErrors &&
                detail.manifest.sourceErrors.length > 0 && (
                  <div className="bg-gray-900 rounded p-3">
                    <div className="text-xs text-gray-500 uppercase mb-2">
                      sourceErrors
                    </div>
                    <ul className="text-xs font-mono text-amber-300 space-y-1">
                      {detail.manifest.sourceErrors.map((e, i) => (
                        <li key={i}>- {e}</li>
                      ))}
                    </ul>
                  </div>
                )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | number;
  highlight?: 'warn' | 'bad' | null;
}) {
  const color =
    highlight === 'bad'
      ? 'text-red-300'
      : highlight === 'warn'
      ? 'text-amber-300'
      : 'text-white';
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase text-gray-500 tracking-wide">
        {label}
      </span>
      <span className={`text-sm font-mono ${color}`}>{value}</span>
    </div>
  );
}

function ManifestGrid({ manifest }: { manifest: RunDetail['manifest'] }) {
  const entries: Array<[string, string]> = [
    ['runId', manifest.runId],
    ['date', manifest.date],
    ['mode', manifest.mode],
    ['status', manifest.status],
    ['companyId', manifest.companyId ?? 'all'],
    ['startedAt', manifest.startedAt ?? '—'],
    ['completedAt', manifest.completedAt ?? '—'],
    ['durationMs', fmtMs(manifest.durationMs ?? null)],
    ['warningCount', String(manifest.warningCount ?? 0)],
  ];
  if (manifest.reason) entries.push(['reason', manifest.reason]);
  const loaded = manifest.loaded;
  const stats = manifest.stats;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-gray-500">{k}</span>
          <span className="text-sm font-mono text-white truncate">{v}</span>
        </div>
      ))}
      {loaded && (
        <div className="col-span-full border-t border-gray-700/60 pt-2 mt-2 text-xs text-gray-400">
          loaded:{' '}
          {Object.entries(loaded)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}
        </div>
      )}
      {stats && (
        <div className="col-span-full text-xs text-gray-400">
          stats:{' '}
          {Object.entries(stats)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}
        </div>
      )}
    </div>
  );
}

function SampleRecordBlock({
  title,
  records,
}: {
  title: string;
  records: Array<Record<string, unknown>>;
}) {
  if (records.length === 0) {
    return (
      <div className="bg-gray-900 rounded p-3">
        <div className="text-xs text-gray-500 uppercase mb-2">{title}</div>
        <div className="text-xs text-gray-500">(none)</div>
      </div>
    );
  }
  return (
    <div className="bg-gray-900 rounded p-3">
      <div className="text-xs text-gray-500 uppercase mb-2">{title}</div>
      <ul className="text-xs font-mono text-gray-200 space-y-1 max-h-60 overflow-auto">
        {records.map((r, i) => (
          <li key={i} className="border-b border-gray-800/60 py-1">
            {typeof r.text === 'string' ? r.text : JSON.stringify(r)}
          </li>
        ))}
      </ul>
    </div>
  );
}
