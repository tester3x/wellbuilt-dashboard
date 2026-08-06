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
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (reset: boolean) => {
    setLoading(true);
    try {
      const page = await service.listAdminAudit({ limit: 25, ...(reset || !cursor ? {} : { cursor }) });
      setEntries((prev) => (reset ? page.entries : [...prev, ...page.entries]));
      setCursor(page.nextCursor);
      setNotice(null);
    } catch (err) {
      setNotice(errorGuidance(err instanceof AdminServiceError ? err : { kind: 'unknown' }).message);
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
      ) : entries.length === 0 ? (
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
