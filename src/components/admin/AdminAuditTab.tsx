'use client';

/**
 * vc51.9A7 — bounded paginated platform-admin audit display. Reads go
 * through the adminListAdminAudit callable ONLY — no Firestore access,
 * and the records themselves are allowlist-bounded server-side (no
 * tokens, credentials, or payloads exist to display).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  createAdminContractService,
  AdminServiceError,
  type AdminAuditEntry,
} from '@/lib/adminContractService';
import { errorGuidance } from '@/lib/adminUiLogic';

const service = createAdminContractService();

export function AdminAuditTab() {
  const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  /**
   * Load phase, tracked separately from the list.
   *
   * `entries` starts empty and is only replaced on success, so keying the
   * empty state on its length made every FAILED load render "No audit
   * records yet." On an audit surface that is a false statement of fact:
   * the operator is told nothing was ever recorded when in truth the read
   * never happened. It did exactly that here — one bootstrap record
   * existed while the tab reported none.
   */
  const [loadPhase, setLoadPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (reset: boolean) => {
    setLoading(true);
    setLoadPhase('loading');
    try {
      const page = await service.listAdminAudit({ limit: 25, ...(reset || !cursor ? {} : { cursor }) });
      setEntries((prev) => (reset ? page.entries : [...prev, ...page.entries]));
      setCursor(page.nextCursor);
      setNotice(null);
      setLoadPhase('ready');
    } catch (err) {
      setNotice(errorGuidance(err instanceof AdminServiceError ? err : { kind: 'unknown' }).message);
      setLoadPhase('error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  useEffect(() => { void load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const auditTime = (id: string) => {
    const ms = Number(id.split('_')[0]);
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : '(server time)';
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-white text-sm font-medium">Platform admin audit</h3>
        <p className="text-gray-400 text-xs">Server-owned records of every protected mutation — verified actor, server time, changed field names, bounded reason.</p>
      </div>
      {notice && <div role="status" className="text-amber-300 text-xs bg-amber-900/30 border border-amber-700 rounded p-2">{notice}</div>}
      {loading && entries.length === 0 ? (
        <p className="text-gray-400 text-sm">Loading audit records…</p>
      ) : loadPhase === 'error' && entries.length === 0 ? (
        <div className="text-sm">
          <p className="text-red-400 mb-2">
            Audit records could not be read, so none are shown. This is not a statement
            that none exist.
          </p>
          <button
            onClick={() => { void load(true); }}
            className="px-3 py-1 rounded bg-gray-600 hover:bg-gray-500 text-white"
          >
            Retry
          </button>
        </div>
      ) : loadPhase === 'ready' && entries.length === 0 ? (
        <p className="text-gray-400 text-sm">No audit records yet.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((e) => (
            <li key={e.auditId} className="bg-gray-700 rounded p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-blue-300">{e.operation}</code>
                <span className="text-gray-300">{e.targetType}/{e.targetId}</span>
                <span className="text-gray-500">{auditTime(e.auditId)}</span>
                <span className="text-gray-500">contract v{e.contractVersion} · policy v{e.adminPolicyVersion}</span>
              </div>
              <div className="text-gray-400 mt-0.5">
                actor {e.actorEmail ?? e.actorUid} (verified)
                {e.changedFields?.length ? ` · changed: ${e.changedFields.join(', ')}` : ''}
                {e.reason ? ` · reason: ${e.reason}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button onClick={() => void load(false)} disabled={loading}
          className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm disabled:opacity-50">
          {loading ? 'Loading…' : 'Load older records'}
        </button>
      )}
    </div>
  );
}
