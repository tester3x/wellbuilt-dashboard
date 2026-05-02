'use client';

// ============================================================
// WB Diagnostics viewer (Phase 1)
//
// Admin-only viewer for the `wb_diagnostics` Firestore collection.
// Surface for app-side instrumentation written by WB T / WB JSA /
// WB S helpers (and dashboard observability events) via the
// writeDiagnosticLog Cloud Function.
//
// Capability: viewDiagnostics. Defaults to `it` only — mirrors the
// Truth Debug page. Customers can override via roleCapabilities.
//
// Phase 1 surface:
//   - Live Firestore subscription, limit 200 most recent rows.
//   - Filters: app, area, driverHash, shiftId, event, date range.
//   - Row click toggles expanded raw-JSON view.
//   - Per-row "Copy JSON" button writes the full record to the
//     clipboard for sharing with claude-home / debug threads.
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  collection,
  limit as fsLimit,
  onSnapshot,
  orderBy,
  query,
  where,
  type DocumentData,
  type QueryConstraint,
  type Timestamp,
} from 'firebase/firestore';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { SubHeader } from '@/components/SubHeader';
import { getFirestoreDb } from '@/lib/firebase';
import { hasCapability } from '@/lib/auth';

type DiagApp = 'wbs' | 'wbt' | 'wbjsa' | 'dashboard' | 'functions';
type DiagArea =
  | 'jsa'
  | 'logout'
  | 'tickets'
  | 'dispatch'
  | 'split_load'
  | 'shift'
  | 'auth'
  | 'general'
  | 'transfer';
type DiagResult = 'ok' | 'skipped' | 'error';

interface DiagRow {
  id: string;
  timestamp: Timestamp | null;
  clientTimestamp: string | null;
  app: DiagApp;
  area: DiagArea;
  event: string;
  driverHash: string | null;
  shiftId: string | null;
  operatorSlug: string | null;
  operatorId: string | null;
  source: string | null;
  result: DiagResult;
  reason: string | null;
  counts: Record<string, unknown> | null;
  extra: Record<string, unknown> | null;
  appVersion: string | null;
  platform: string | null;
}

const APP_OPTIONS: Array<{ value: '' | DiagApp; label: string }> = [
  { value: '', label: 'All apps' },
  { value: 'wbs', label: 'WB Suite (wbs)' },
  { value: 'wbt', label: 'WB Tickets (wbt)' },
  { value: 'wbjsa', label: 'WB JSA (wbjsa)' },
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'functions', label: 'Functions' },
];

const AREA_OPTIONS: Array<{ value: '' | DiagArea; label: string }> = [
  { value: '', label: 'All areas' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'jsa', label: 'JSA' },
  { value: 'logout', label: 'Logout' },
  { value: 'tickets', label: 'Tickets' },
  { value: 'dispatch', label: 'Dispatch' },
  { value: 'split_load', label: 'Split load' },
  { value: 'shift', label: 'Shift' },
  { value: 'auth', label: 'Auth' },
  { value: 'general', label: 'General' },
];

const RESULT_BADGE: Record<DiagResult, string> = {
  ok: 'bg-emerald-700 text-emerald-100',
  skipped: 'bg-amber-700 text-amber-100',
  error: 'bg-rose-700 text-rose-100',
};

const APP_BADGE: Record<DiagApp, string> = {
  wbs: 'bg-blue-800 text-blue-100',
  wbt: 'bg-indigo-800 text-indigo-100',
  wbjsa: 'bg-fuchsia-800 text-fuchsia-100',
  dashboard: 'bg-slate-700 text-slate-100',
  functions: 'bg-zinc-700 text-zinc-100',
};

function formatTs(ts: Timestamp | null, clientTs: string | null): string {
  const d = ts ? ts.toDate() : clientTs ? new Date(clientTs) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function compactCounts(counts: Record<string, unknown> | null): string {
  if (!counts) return '';
  const entries = Object.entries(counts).filter(
    ([, v]) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean',
  );
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${String(v)}`).join(' · ');
}

export default function DiagnosticsPage() {
  const { user, loading, userCompany } = useAuth();
  const router = useRouter();

  const [filterApp, setFilterApp] = useState<'' | DiagApp>('');
  const [filterArea, setFilterArea] = useState<'' | DiagArea>('');
  const [filterDriver, setFilterDriver] = useState('');
  const [filterShift, setFilterShift] = useState('');
  const [filterEvent, setFilterEvent] = useState('');

  const [rows, setRows] = useState<DiagRow[]>([]);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const headerCheckboxRef = useRef<HTMLInputElement | null>(null);
  // Anchor for shift-click range selection. Tracks the last single-row
  // toggle / shift-range endpoint so the next shift+click can extend a
  // range from there. Resets when "Clear from view" hides rows.
  const lastClickedIdRef = useRef<string | null>(null);

  // Auth gate — same redirect pattern as truth-debug. Keeps the
  // page consistent with other admin tools and avoids flashing
  // sensitive data before the role check resolves.
  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.push('/login');
      return;
    }
    if (!hasCapability(user, 'viewDiagnostics', userCompany)) {
      router.push('/');
    }
  }, [user, loading, userCompany, router]);

  // Resolve which Firestore filter to push server-side. Firestore
  // composite indexes only cover (singleField, timestamp DESC), so
  // we pick at most ONE indexed equality filter and apply the rest
  // client-side. driverHash > shiftId > app > area > none.
  const serverConstraints = useMemo<QueryConstraint[]>(() => {
    const c: QueryConstraint[] = [];
    if (filterDriver.trim()) {
      c.push(where('driverHash', '==', filterDriver.trim()));
    } else if (filterShift.trim()) {
      c.push(where('shiftId', '==', filterShift.trim()));
    } else if (filterApp) {
      c.push(where('app', '==', filterApp));
    } else if (filterArea) {
      c.push(where('area', '==', filterArea));
    }
    c.push(orderBy('timestamp', 'desc'));
    c.push(fsLimit(200));
    return c;
  }, [filterApp, filterArea, filterDriver, filterShift]);

  useEffect(() => {
    if (loading || !user) return;
    if (!hasCapability(user, 'viewDiagnostics', userCompany)) return;

    setBusy(true);
    setSubscribeError(null);
    const db = getFirestoreDb();
    const q = query(collection(db, 'wb_diagnostics'), ...serverConstraints);
    const unsub = onSnapshot(
      q,
      (snap) => {
        const next: DiagRow[] = snap.docs.map((d) => {
          const data = d.data() as DocumentData;
          return {
            id: d.id,
            timestamp: (data.timestamp as Timestamp | undefined) ?? null,
            clientTimestamp:
              typeof data.clientTimestamp === 'string' ? data.clientTimestamp : null,
            app: data.app as DiagApp,
            area: data.area as DiagArea,
            event: typeof data.event === 'string' ? data.event : '',
            driverHash: typeof data.driverHash === 'string' ? data.driverHash : null,
            shiftId: typeof data.shiftId === 'string' ? data.shiftId : null,
            operatorSlug:
              typeof data.operatorSlug === 'string' ? data.operatorSlug : null,
            operatorId: typeof data.operatorId === 'string' ? data.operatorId : null,
            source: typeof data.source === 'string' ? data.source : null,
            result: (data.result as DiagResult) || 'ok',
            reason: typeof data.reason === 'string' ? data.reason : null,
            counts:
              data.counts && typeof data.counts === 'object'
                ? (data.counts as Record<string, unknown>)
                : null,
            extra:
              data.extra && typeof data.extra === 'object'
                ? (data.extra as Record<string, unknown>)
                : null,
            appVersion: typeof data.appVersion === 'string' ? data.appVersion : null,
            platform: typeof data.platform === 'string' ? data.platform : null,
          };
        });
        setRows(next);
        setBusy(false);
      },
      (err) => {
        console.warn('[diagnostics] subscription failed:', err);
        setSubscribeError(err.message || 'Subscription failed');
        setBusy(false);
      },
    );
    return () => unsub();
  }, [serverConstraints, user, loading, userCompany]);

  // Reset shift-click anchor when filters change — the previous anchor
  // row may not be visible under the new filter, so clearing prevents
  // weird shift-range behavior. hiddenIds is intentionally NOT reset
  // here: hidden rows MUST stay hidden across filter changes and across
  // live-query snapshots until the user explicitly clicks "Show cleared
  // rows" (or the page is fully refreshed → component remount → empty
  // default).
  useEffect(() => {
    lastClickedIdRef.current = null;
  }, [filterApp, filterArea, filterDriver, filterShift, filterEvent]);

  // Client-side fan-out filter. Catches the dimensions we couldn't
  // push into Firestore (because each composite index is
  // singleField + timestamp). For event, we substring-match
  // case-insensitively so "logout" matches "logout.cascade.sent" /
  // "logout.signal.received". Also drops rows the user explicitly
  // hid via "Clear from view" — that hide is purely client-side and
  // does NOT touch Firestore.
  const filtered = useMemo(() => {
    const ev = filterEvent.trim().toLowerCase();
    return rows.filter((r) => {
      if (hiddenIds.has(r.id)) return false;
      if (filterApp && r.app !== filterApp) return false;
      if (filterArea && r.area !== filterArea) return false;
      if (filterDriver.trim() && r.driverHash !== filterDriver.trim()) return false;
      if (filterShift.trim() && r.shiftId !== filterShift.trim()) return false;
      if (ev && !(r.event || '').toLowerCase().includes(ev)) return false;
      return true;
    });
  }, [rows, filterApp, filterArea, filterDriver, filterShift, filterEvent, hiddenIds]);

  const copyRow = async (row: DiagRow) => {
    try {
      const payload = {
        ...row,
        timestamp: row.timestamp ? row.timestamp.toDate().toISOString() : null,
      };
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch (err) {
      console.warn('[diagnostics] clipboard write failed:', err);
    }
  };

  // ── Selection + bulk copy ────────────────────────────────────────────────
  // Selection state is decoupled from current filter — selecting rows then
  // changing filters preserves the selection so users can build a paste
  // out of multiple slices. Copy operates on whatever's currently checked,
  // regardless of whether those rows are still visible.
  const toggleRow = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const r of filtered) next.add(r.id);
      return next;
    });
  };

  // Internal: header-checkbox uncheck-all-visible. Not exposed as a
  // toolbar button — the toolbar's "Clear from view" handles the
  // user-facing "remove these from my view" action.
  const clearChecked = () => setChecked(new Set());

  // Hide checked rows from the current view. Does NOT delete any
  // Firestore document and does NOT modify any diagnostics data.
  // Hidden rows STAY hidden across filter changes AND live-query
  // snapshot refreshes until the user clicks "Show cleared rows" or
  // does a full page refresh. Operates on currently-visible-and-
  // checked rows only — checked rows that are off-screen due to
  // active filters are not hidden by this action; the entire checked
  // set is then cleared so the user starts fresh.
  const clearCheckedFromView = () => {
    if (checked.size === 0) return;
    const visibleCheckedIds = filtered
      .filter((r) => checked.has(r.id))
      .map((r) => r.id);
    if (visibleCheckedIds.length > 0) {
      setHiddenIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleCheckedIds) next.add(id);
        return next;
      });
    }
    setChecked(new Set());
    lastClickedIdRef.current = null;
  };

  // Manual "show everything" — only path back to seeing cleared rows
  // without a full page refresh.
  const restoreHidden = () => {
    setHiddenIds(new Set());
  };

  // Range-select on shift-click; plain click and ctrl/cmd-click both
  // toggle a single row. The anchor is the most recently clicked row
  // (single-toggle or shift-range endpoint). Mimics standard desktop
  // file-manager / table semantics.
  const handleCheckboxClick = (
    e: React.MouseEvent<HTMLInputElement>,
    rowId: string,
    visibleIndex: number,
  ) => {
    e.stopPropagation();
    if (
      e.shiftKey &&
      lastClickedIdRef.current &&
      lastClickedIdRef.current !== rowId
    ) {
      e.preventDefault();
      const lastIdx = filtered.findIndex((r) => r.id === lastClickedIdRef.current);
      if (lastIdx >= 0) {
        const [from, to] =
          lastIdx <= visibleIndex ? [lastIdx, visibleIndex] : [visibleIndex, lastIdx];
        // Range-fill state mirrors the anchor row's current checked
        // state (OS file-manager behavior): if anchor is checked,
        // checking the range; if anchor is unchecked, unchecking it.
        const anchorChecked = checked.has(lastClickedIdRef.current);
        setChecked((prev) => {
          const next = new Set(prev);
          for (let i = from; i <= to; i++) {
            const id = filtered[i]?.id;
            if (!id) continue;
            if (anchorChecked) next.add(id);
            else next.delete(id);
          }
          return next;
        });
      }
    }
    // For plain click and ctrl/cmd click, default toggle fires via
    // onChange (no preventDefault). We only update the anchor here.
    lastClickedIdRef.current = rowId;
  };

  const visibleCheckedCount = useMemo(
    () => filtered.reduce((n, r) => (checked.has(r.id) ? n + 1 : n), 0),
    [filtered, checked],
  );
  const allVisibleChecked = filtered.length > 0 && visibleCheckedCount === filtered.length;
  const someVisibleChecked = visibleCheckedCount > 0 && !allVisibleChecked;

  // Header tri-state checkbox indeterminate flag — React doesn't expose
  // `indeterminate` as a prop so we set it imperatively via ref.
  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someVisibleChecked;
    }
  }, [someVisibleChecked]);

  const formatRowForCopy = (r: DiagRow): string => {
    const ts = formatTs(r.timestamp, r.clientTimestamp);
    const driver = r.driverHash ? `${r.driverHash.slice(0, 12)}…` : '—';
    const shift = r.shiftId || '—';
    const operator = r.operatorSlug || r.operatorId || '—';
    const source = r.source || '—';
    const reason = r.reason || '—';
    const countsStr = r.counts
      ? Object.entries(r.counts)
          .filter(
            ([, v]) =>
              typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean',
          )
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' ')
      : '—';
    const extraStr = r.extra ? JSON.stringify(r.extra) : '—';
    return [
      `${ts}  [${r.app}/${r.area}]  ${r.event}  result=${r.result}`,
      `  driver=${driver}  shiftId=${shift}  operator=${operator}`,
      `  source=${source}`,
      `  reason=${reason}`,
      `  counts: ${countsStr}`,
      `  extra: ${extraStr}`,
    ].join('\n');
  };

  const copyChecked = async () => {
    // Visible-only per UX contract: copy only currently-visible checked
    // rows. Off-screen-but-checked rows (filtered out OR hidden via
    // "Clear from view") are not included — what the user sees is what
    // gets copied.
    const selected = filtered.filter((r) => checked.has(r.id));
    if (selected.length === 0) return;
    const text = selected.map(formatRowForCopy).join('\n\n---\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(`Copied ${selected.length} row${selected.length === 1 ? '' : 's'}`);
      setTimeout(() => setCopyStatus(null), 2500);
    } catch (err) {
      console.warn('[diagnostics] bulk clipboard write failed:', err);
      setCopyStatus('Copy failed — clipboard blocked');
      setTimeout(() => setCopyStatus(null), 2500);
    }
  };

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-gray-900 text-white">
        <AppHeader />
        <div className="max-w-7xl mx-auto px-4 py-6">Loading…</div>
      </div>
    );
  }

  if (!hasCapability(user, 'viewDiagnostics', userCompany)) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <AppHeader />
      <SubHeader
        backHref="/"
        title="WB Diagnostics"
        subtitle="Live view of wb_diagnostics — Phase 1 instrumentation surface"
      />

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {/* ── Focus presets ─────────────────────────────────────────────────
            One-click filters for common investigation scopes. Each preset
            sets a coordinated combination of the standard filters below.
            "Clear" resets every filter to default. */}
        <section className="bg-indigo-900/30 border border-indigo-700/60 rounded p-3 flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-indigo-200 font-semibold mr-1">Focus</span>
          <button
            type="button"
            onClick={() => {
              setFilterApp('wbt');
              setFilterArea('transfer');
              setFilterDriver('');
              setFilterShift('');
              setFilterEvent('');
            }}
            className={`px-3 py-1 rounded text-xs font-semibold border ${
              filterApp === 'wbt' && filterArea === 'transfer' && !filterEvent
                ? 'bg-indigo-600 border-indigo-400 text-white'
                : 'bg-gray-800 border-indigo-700/60 text-indigo-200 hover:bg-indigo-800/40'
            }`}
            title="Filter to WB Tickets transfer-flow instrumentation: accept, hydrate, arrive phase decision, dropoff photo path"
          >
            Transfers
          </button>
          <button
            type="button"
            onClick={() => {
              setFilterApp('');
              setFilterArea('');
              setFilterDriver('');
              setFilterShift('');
              setFilterEvent('');
            }}
            className="px-3 py-1 rounded text-xs font-semibold border border-gray-600 text-gray-300 hover:bg-gray-700"
            title="Reset all filters to defaults"
          >
            Clear
          </button>
          <span className="text-xs text-gray-400 ml-2 hidden md:inline">
            Transfer events:
            <code className="text-indigo-300 ml-1">transfer.djd_item_render</code>{', '}
            <code className="text-indigo-300">accept_tap</code>{', '}
            <code className="text-indigo-300">hydrate_*</code>{', '}
            <code className="text-indigo-300">navigate_*</code>{', '}
            <code className="text-indigo-300">arrive_*</code>{', '}
            <code className="text-indigo-300">photo-transfer.*</code>
          </span>
        </section>

        <section className="bg-gray-800/60 border border-gray-700 rounded p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <label className="flex flex-col text-xs text-gray-300">
            App
            <select
              className="mt-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white"
              value={filterApp}
              onChange={(e) => setFilterApp(e.target.value as '' | DiagApp)}
            >
              {APP_OPTIONS.map((o) => (
                <option key={o.value || 'all'} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col text-xs text-gray-300">
            Area
            <select
              className="mt-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white"
              value={filterArea}
              onChange={(e) => setFilterArea(e.target.value as '' | DiagArea)}
            >
              {AREA_OPTIONS.map((o) => (
                <option key={o.value || 'all'} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col text-xs text-gray-300">
            driverHash
            <input
              className="mt-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white font-mono"
              placeholder="exact match"
              value={filterDriver}
              onChange={(e) => setFilterDriver(e.target.value)}
            />
          </label>

          <label className="flex flex-col text-xs text-gray-300">
            shiftId
            <input
              className="mt-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white font-mono"
              placeholder="exact match"
              value={filterShift}
              onChange={(e) => setFilterShift(e.target.value)}
            />
          </label>

          <label className="flex flex-col text-xs text-gray-300">
            event contains
            <input
              className="mt-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white"
              placeholder="substring (client-side)"
              value={filterEvent}
              onChange={(e) => setFilterEvent(e.target.value)}
            />
          </label>
        </section>

        <section className="text-xs text-gray-400 flex items-center gap-3">
          <span>
            {busy ? 'Loading…' : `${filtered.length} of ${rows.length} most recent`}
          </span>
          {subscribeError && (
            <span className="text-rose-300">Error: {subscribeError}</span>
          )}
        </section>

        <section className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={selectAllVisible}
            disabled={filtered.length === 0}
            className="px-2 py-1 rounded border border-gray-600 text-gray-200 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Select all visible ({filtered.length})
          </button>
          <button
            type="button"
            onClick={copyChecked}
            disabled={checked.size === 0}
            className="px-2 py-1 rounded border border-blue-500 bg-blue-700 text-white hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Copy checked ({checked.size})
          </button>
          <button
            type="button"
            onClick={clearCheckedFromView}
            disabled={checked.size === 0}
            title="Hide selected rows from the current view. Does NOT delete from Firestore. Returns on filter reset or refresh."
            className="px-2 py-1 rounded border border-amber-500 text-amber-200 hover:bg-amber-700/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Clear from view ({checked.size})
          </button>
          {hiddenIds.size > 0 && (
            <button
              type="button"
              onClick={restoreHidden}
              title="Bring back rows you cleared from view this session."
              className="px-2 py-1 rounded border border-gray-600 text-gray-200 hover:bg-gray-700"
            >
              Show cleared rows ({hiddenIds.size})
            </button>
          )}
          {checked.size > 0 && (
            <span className="text-gray-300">
              {checked.size} row{checked.size === 1 ? '' : 's'} selected
            </span>
          )}
          {hiddenIds.size > 0 && (
            <span className="text-amber-300">
              {hiddenIds.size} hidden from view
            </span>
          )}
          {copyStatus && <span className="text-emerald-300">{copyStatus}</span>}
          <span className="text-gray-500 ml-2 hidden md:inline">
            Tip: Shift-click a checkbox to select a range.
          </span>
        </section>

        <section className="bg-gray-800/60 border border-gray-700 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-800 text-gray-300 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2 w-8">
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    checked={allVisibleChecked}
                    onChange={(e) => {
                      if (e.target.checked) selectAllVisible();
                      else clearChecked();
                    }}
                    aria-label="Select all visible rows"
                    className="cursor-pointer"
                  />
                </th>
                <th className="text-left px-3 py-2">When</th>
                <th className="text-left px-2 py-2">App</th>
                <th className="text-left px-2 py-2">Area</th>
                <th className="text-left px-2 py-2">Event</th>
                <th className="text-left px-2 py-2">Driver / Shift</th>
                <th className="text-left px-2 py-2">Operator</th>
                <th className="text-left px-2 py-2">Source</th>
                <th className="text-left px-2 py-2">Result</th>
                <th className="text-left px-2 py-2">Counts / Reason</th>
                <th className="text-right px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && !busy && (
                <tr>
                  <td colSpan={11} className="px-3 py-6 text-center text-gray-400">
                    No diagnostic events match the current filters.
                  </td>
                </tr>
              )}
              {filtered.map((row, visibleIndex) => {
                const expanded = expandedId === row.id;
                const counts = compactCounts(row.counts);
                return (
                  <>
                    <tr
                      key={row.id}
                      className="border-t border-gray-700/60 hover:bg-gray-800/80 cursor-pointer"
                      onClick={() => setExpandedId(expanded ? null : row.id)}
                    >
                      <td
                        className="px-3 py-2 w-8"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={checked.has(row.id)}
                          onChange={() => toggleRow(row.id)}
                          onClick={(e) => handleCheckboxClick(e, row.id, visibleIndex)}
                          aria-label={`Select row ${row.event}`}
                          className="cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                        {formatTs(row.timestamp, row.clientTimestamp)}
                      </td>
                      <td className="px-2 py-2">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-medium ${APP_BADGE[row.app] || 'bg-gray-700 text-gray-200'}`}
                        >
                          {row.app}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-xs text-gray-300">{row.area}</td>
                      <td className="px-2 py-2 font-mono text-xs">{row.event}</td>
                      <td className="px-2 py-2 font-mono text-[11px] text-gray-300">
                        {row.driverHash ? `${row.driverHash.slice(0, 10)}…` : '—'}
                        {row.shiftId ? <div className="text-gray-500">{row.shiftId}</div> : null}
                      </td>
                      <td className="px-2 py-2 font-mono text-[11px] text-gray-300">
                        {row.operatorSlug || row.operatorId || '—'}
                      </td>
                      <td className="px-2 py-2 font-mono text-[11px] text-gray-400">
                        {row.source || '—'}
                      </td>
                      <td className="px-2 py-2">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-medium ${RESULT_BADGE[row.result]}`}
                        >
                          {row.result}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-xs text-gray-300">
                        {counts ? <div className="font-mono">{counts}</div> : null}
                        {row.reason ? <div className="text-gray-400">{row.reason}</div> : null}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          className="text-xs text-blue-300 hover:text-blue-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            void copyRow(row);
                          }}
                        >
                          Copy JSON
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr key={row.id + '-detail'} className="bg-gray-900/80">
                        <td colSpan={11} className="px-4 py-3">
                          <pre className="text-[11px] font-mono text-gray-200 overflow-x-auto whitespace-pre-wrap">
{JSON.stringify(
  {
    ...row,
    timestamp: row.timestamp
      ? row.timestamp.toDate().toISOString()
      : null,
  },
  null,
  2,
)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
}
