'use client';

import Link from 'next/link';
import type { SpillListFilter, SpillListRow, SpillLoadState } from '@/lib/spill/spillIncidentProjection';
import { emptyListCopy, filterSpillRows, notifyRollupLabel } from '@/lib/spill/spillIncidentProjection';

const FILTERS: { id: SpillListFilter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'acknowledged', label: 'Acknowledged' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' },
];

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function SpillIncidentList(props: {
  state: SpillLoadState;
  rows: SpillListRow[];
  filter: SpillListFilter;
  onFilter: (f: SpillListFilter) => void;
  onRetry: () => void;
  companyName?: string | null;
}) {
  const visible = filterSpillRows(props.rows, props.filter);
  const malformed = props.rows.filter((r) => r.malformed);

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => props.onFilter(f.id)}
            className={`px-3 py-1.5 rounded text-sm ${
              props.filter === f.id ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {props.state.kind === 'loading' && (
        <div className="text-gray-400 text-center py-16">Loading spill incidents…</div>
      )}
      {props.state.kind === 'denied' && (
        <div className="text-red-400 text-center py-16">
          Access denied. You can only view spill incidents for your company.
        </div>
      )}
      {props.state.kind === 'missing_index' && (
        <div className="text-amber-400 text-center py-16">
          A Firestore index is required to list incidents. Retry after the index is deployed.
          <div className="mt-3">
            <button type="button" onClick={props.onRetry} className="px-3 py-1.5 bg-gray-700 rounded text-sm text-white">Retry</button>
          </div>
        </div>
      )}
      {props.state.kind === 'retryable' && (
        <div className="text-amber-400 text-center py-16">
          {props.state.message}
          <div className="mt-3">
            <button type="button" onClick={props.onRetry} className="px-3 py-1.5 bg-gray-700 rounded text-sm text-white">Retry</button>
          </div>
        </div>
      )}
      {props.state.kind === 'error' && (
        <div className="text-red-400 text-center py-16">
          {props.state.message}
          <div className="mt-3">
            <button type="button" onClick={props.onRetry} className="px-3 py-1.5 bg-gray-700 rounded text-sm text-white">Retry</button>
          </div>
        </div>
      )}
      {props.state.kind === 'empty' && (
        <div className="text-gray-400 text-center py-16">{emptyListCopy()}</div>
      )}
      {props.state.kind === 'ready' && visible.length === 0 && (
        <div className="text-gray-400 text-center py-16">{emptyListCopy()}</div>
      )}

      {malformed.length > 0 && (props.state.kind === 'ready' || props.state.kind === 'empty') && (
        <div className="mb-3 text-amber-400 text-xs">{malformed.length} malformed record(s) omitted from filters — open All to inspect.</div>
      )}

      {props.state.kind === 'ready' && visible.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-700">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-800 text-gray-400 text-xs uppercase">
              <tr>
                <th className="px-3 py-2">Date/time</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">Driver</th>
                <th className="px-3 py-2">Company</th>
                <th className="px-3 py-2">Ticket/job</th>
                <th className="px-3 py-2">Phase</th>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Media</th>
                <th className="px-3 py-2">Notification</th>
                <th className="px-3 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={`${row.companyId}-${row.incidentId}`} className="border-t border-gray-800 hover:bg-gray-800/60">
                  <td className="px-3 py-2">
                    <Link href={`/safety/spills/${encodeURIComponent(row.incidentId)}?companyId=${encodeURIComponent(row.companyId)}`} className="text-blue-400 hover:underline">
                      {fmt(row.occurredAtIso)}
                    </Link>
                    {row.malformed && <div className="text-amber-400 text-xs">malformed</div>}
                  </td>
                  <td className="px-3 py-2 capitalize text-white">{row.status}</td>
                  <td className="px-3 py-2 text-gray-300">{row.severity || '—'}</td>
                  <td className="px-3 py-2 text-gray-300">{row.driverName || row.driverId || '—'}</td>
                  <td className="px-3 py-2 text-gray-300">{row.companyName || row.companyId}</td>
                  <td className="px-3 py-2 text-gray-300">{row.ticketNumber || row.invoiceNumber || '—'}</td>
                  <td className="px-3 py-2 text-gray-300">{row.phase || '—'}</td>
                  <td className="px-3 py-2 text-gray-300">{row.location || '—'}</td>
                  <td className="px-3 py-2 text-gray-300">{row.photoCount} photo / {row.videoCount} video</td>
                  <td className="px-3 py-2 text-gray-400">{notifyRollupLabel(row.notifyRollup)}</td>
                  <td className="px-3 py-2 text-gray-400">{fmt(row.updatedAtIso)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
