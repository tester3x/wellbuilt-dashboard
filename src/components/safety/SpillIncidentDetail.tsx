'use client';

import {
  isSpillActionAvailable,
  spillActionDisabledReason,
  type SpillActionType,
} from '@/lib/spill/spillActions';
import type { SpillDetailView, SpillLoadState } from '@/lib/spill/spillIncidentProjection';
import { notifyRollupLabel } from '@/lib/spill/spillIncidentProjection';
import { SPILL_DETAIL_NOT_FOUND_COPY } from '@/lib/spill/spillDetailRoute';

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function yn(v: boolean | null): string {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  return '—';
}

const ACTIONS: { type: SpillActionType; label: string }[] = [
  { type: 'acknowledge', label: 'Acknowledge' },
  { type: 'assignOwner', label: 'Assign follow-up owner' },
  { type: 'addNote', label: 'Add internal follow-up note' },
  { type: 'resolve', label: 'Mark resolved' },
  { type: 'close', label: 'Close incident' },
  { type: 'reopen', label: 'Reopen with reason' },
];

export function SpillIncidentDetail(props: {
  state: SpillLoadState;
  detail: SpillDetailView | null;
  canManage: boolean;
  onRetry: () => void;
}) {
  if (props.state.kind === 'loading') {
    return <div className="text-gray-400 text-center py-16">Loading incident…</div>;
  }
  if (props.state.kind === 'denied') {
    return <div className="text-red-400 text-center py-16">Access denied for this incident.</div>;
  }
  if (props.state.kind === 'empty') {
    return <div className="text-gray-400 text-center py-16">{SPILL_DETAIL_NOT_FOUND_COPY}</div>;
  }
  if (props.state.kind === 'missing_index' || props.state.kind === 'retryable' || props.state.kind === 'error') {
    const msg = props.state.kind === 'missing_index'
      ? 'A Firestore index is required.'
      : props.state.kind === 'retryable' ? props.state.message : props.state.message;
    return (
      <div className="text-amber-400 text-center py-16">
        {msg}
        <div className="mt-3">
          <button type="button" onClick={props.onRetry} className="px-3 py-1.5 bg-gray-700 rounded text-sm text-white">Retry</button>
        </div>
      </div>
    );
  }
  const d = props.detail;
  if (!d) return <div className="text-gray-400 text-center py-16">{SPILL_DETAIL_NOT_FOUND_COPY}</div>;

  return (
    <div className="space-y-6 text-sm">
      {d.malformed && (
        <div className="bg-amber-900/40 border border-amber-700 text-amber-200 px-3 py-2 rounded">
          This record is malformed (missing incident or company identity). Fields below are shown as stored.
        </div>
      )}

      <section className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h3 className="text-white font-medium mb-3">Identity</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-gray-300">
          <dt className="text-gray-500">Incident ID</dt><dd className="font-mono text-xs">{d.incidentId}</dd>
          <dt className="text-gray-500">Schema version</dt><dd>{d.schemaVersion}</dd>
          <dt className="text-gray-500">Company</dt><dd>{d.companyName || d.companyId}</dd>
          <dt className="text-gray-500">Driver</dt><dd>{d.driverName || d.driverId || '—'}</dd>
          <dt className="text-gray-500">Ticket</dt><dd>{d.ticketNumber || '—'}</dd>
          <dt className="text-gray-500">Job / invoice</dt><dd>{d.invoiceNumber || d.invoiceDocId || '—'}</dd>
          <dt className="text-gray-500">Phase</dt><dd>{d.phase || '—'}</dd>
          <dt className="text-gray-500">Location</dt><dd>{d.location || '—'}</dd>
          <dt className="text-gray-500">Operator</dt><dd>{d.operator || '—'}</dd>
          <dt className="text-gray-500">Well</dt><dd>{d.wellName || '—'}</dd>
          <dt className="text-gray-500">Drop-off</dt><dd>{d.hauledTo || '—'}</dd>
          <dt className="text-gray-500">Truck / trailer</dt><dd>{[d.truckNumber, d.trailer].filter(Boolean).join(' / ') || '—'}</dd>
          <dt className="text-gray-500">Status</dt><dd className="capitalize">{d.status}{d.rawStatus ? ` (${d.rawStatus})` : ''}</dd>
          <dt className="text-gray-500">Severity</dt><dd>{d.severity || '—'}</dd>
        </dl>
      </section>

      <section className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h3 className="text-white font-medium mb-3">Submitted packet</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-gray-300">
          <dt className="text-gray-500">Material / type</dt><dd>{d.material || '—'}</dd>
          <dt className="text-gray-500">Estimated quantity</dt><dd>{d.estimatedAmount != null ? `${d.estimatedAmount} ${d.amountUnit || ''}`.trim() : '—'}</dd>
          <dt className="text-gray-500">Source / cause</dt><dd>{d.sourceCause || '—'}</dd>
          <dt className="text-gray-500">Flow</dt><dd>{d.flowState || '—'}</dd>
          <dt className="text-gray-500">Contained</dt><dd>{yn(d.contained)}</dd>
          <dt className="text-gray-500">Waterway threat</dt><dd>{yn(d.waterwayThreat)}</dd>
          <dt className="text-gray-500">Injuries / danger</dt><dd>{yn(d.injuriesOrDanger)}</dd>
          <dt className="text-gray-500">Emergency services</dt><dd>{yn(d.emergencyServicesContacted)}</dd>
          <dt className="text-gray-500">Actions taken</dt><dd className="col-span-1">{d.actionsTaken || '—'}</dd>
          <dt className="text-gray-500">Notes</dt><dd>{d.notes || '—'}</dd>
          <dt className="text-gray-500">GPS</dt>
          <dd>
            {d.gps
              ? `${d.gps.lat.toFixed(5)}, ${d.gps.lng.toFixed(5)}${d.gps.accuracy != null ? ` (±${d.gps.accuracy}m)` : ''}`
              : '—'}
          </dd>
          <dt className="text-gray-500">Created</dt><dd>{fmt(d.createdAtIso)}</dd>
          <dt className="text-gray-500">Submitted</dt><dd>{fmt(d.submittedAtIso)}</dd>
          <dt className="text-gray-500">Accepted</dt><dd>{fmt(d.acceptedAtIso)}</dd>
          <dt className="text-gray-500">Updated</dt><dd>{fmt(d.updatedAtIso)}</dd>
        </dl>
      </section>

      <section className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h3 className="text-white font-medium mb-3">Media</h3>
        <p className="text-gray-500 text-xs mb-2">Governed storage paths only. Public download URLs are never shown.</p>
        {d.photos.length === 0 && !d.video && <div className="text-gray-400">No media attached.</div>}
        {d.photos.length > 0 && (
          <ul className="space-y-1 text-gray-300 mb-3">
            {d.photos.map((p) => (
              <li key={p.photoId}>
                Photo {p.slot || p.photoId}: {p.mediaState === 'ready' ? 'ready' : p.mediaState === 'pending' ? 'upload pending' : 'unavailable'}
                {p.storagePath ? <span className="text-gray-500 font-mono text-xs ml-2">{p.storagePath}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {d.video && (
          <div className="text-gray-300">
            Video {d.video.videoId}: {d.video.mediaState === 'ready' ? 'ready' : d.video.mediaState === 'pending' ? 'upload pending' : 'unavailable'}
            {d.video.durationSec != null ? ` · ${d.video.durationSec}s` : ''}
            {d.video.storagePath ? <div className="text-gray-500 font-mono text-xs">{d.video.storagePath}</div> : null}
          </div>
        )}
      </section>

      <section className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h3 className="text-white font-medium mb-3">Notifications</h3>
        <p className="text-gray-300 mb-2">{notifyRollupLabel(d.notifyRollup)}</p>
        <p className="text-gray-500 text-xs mb-2">Policy version snapshotted at accept: {d.notifyPolicyVersion ?? '—'}</p>
        {d.deliveries.length === 0 ? (
          <div className="text-gray-400">No delivery records. Nothing is claimed sent.</div>
        ) : (
          <ul className="space-y-1 text-gray-300">
            {d.deliveries.map((x) => (
              <li key={x.deliveryId}>
                {x.displayName || x.recipientKey} · {x.channel} · {x.status}
                {x.addressMasked ? ` · ${x.addressMasked}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h3 className="text-white font-medium mb-3">Acknowledgment / resolution history</h3>
        {d.audit.length === 0 ? (
          <div className="text-gray-400">No audit transitions recorded.</div>
        ) : (
          <ul className="space-y-2 text-gray-300">
            {d.audit.map((a, i) => (
              <li key={i}>
                {fmt(a.atIso)} · {a.action} · {a.actorName || a.actorUid || 'unknown'}
                {a.priorStatus ? ` · ${a.priorStatus} → ${a.resultingStatus}` : ''}
                {a.reason ? ` · ${a.reason}` : ''}
              </li>
            ))}
          </ul>
        )}
        {d.followUpNotes.length > 0 && (
          <div className="mt-3">
            <h4 className="text-gray-400 text-xs uppercase mb-1">Internal notes</h4>
            {d.followUpNotes.map((n, i) => (
              <div key={i} className="text-gray-300">{fmt(n.atIso)} · {n.actorName || '—'} · {n.text}</div>
            ))}
          </div>
        )}
      </section>

      <section className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <h3 className="text-white font-medium mb-3">Actions</h3>
        {!props.canManage && <p className="text-gray-500 text-xs mb-2">View-only for your role.</p>}
        <div className="flex flex-wrap gap-2">
          {ACTIONS.map((a) => {
            const disabled = !props.canManage || !isSpillActionAvailable(a.type);
            const why = !props.canManage ? 'Requires manageSafety' : spillActionDisabledReason(a.type);
            return (
              <button
                key={a.type}
                type="button"
                disabled={disabled}
                title={why || undefined}
                className={`px-3 py-1.5 rounded text-sm ${disabled ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-blue-600 text-white'}`}
              >
                {a.label}
              </button>
            );
          })}
        </div>
        <p className="text-gray-500 text-xs mt-3">
          Governed server callables are not deployed. Actions stay disabled rather than writing Firestore from the Dashboard.
        </p>
      </section>
    </div>
  );
}
