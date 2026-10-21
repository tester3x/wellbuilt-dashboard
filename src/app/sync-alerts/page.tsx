'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { hasCapability } from '@/lib/auth';
import { listOfficeSyncAlerts, type OfficeSyncAlert } from '@/lib/officeSyncAlerts';
export default function SyncAlertsPage() {
  const { user, userCompany, operatingCompanyId, authResolved } = useAuth();
  const [rows, setRows] = useState<OfficeSyncAlert[]>([]);
  const [status, setStatus] = useState('');
  const allowed = !!user && hasCapability(user, 'manageDrivers', userCompany);
  const scope = JSON.stringify([user?.uid, operatingCompanyId, allowed, authResolved]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const refresh = useCallback(async () => {
    if (!authResolved || !allowed || !operatingCompanyId) return;
    setStatus('Checking saved updates…');
    try { const result = await listOfficeSyncAlerts(operatingCompanyId); if (currentScope.current !== scope) return; setRows(result); setStatus(''); }
    catch { if (currentScope.current === scope) setStatus('Could not check alerts. Previous results are retained; try Refresh.'); }
  }, [authResolved, allowed, operatingCompanyId, scope]);
  useEffect(() => { setRows([]); void refresh(); }, [refresh]);
  if (!authResolved) return <p className="p-6">Loading account…</p>;
  if (!allowed) return <p className="p-6">Office/admin access is required.</p>;
  if (!operatingCompanyId) return <p className="p-6">Select a company to review saved updates.</p>;
  return <main className="mx-auto max-w-4xl p-6">
    <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Sync needs office review</h1><button className="rounded bg-blue-600 px-4 py-2 text-white" onClick={() => void refresh()}>Refresh</button></div>
    <p className="my-4">The driver’s saved update is retained on their device. Alerts clear when it leaves the retry queue after delivery or an explicit resolution. Review the reference with support; do not recreate the job or inspection.</p>
    {status && <p role="status">{status}</p>}
    {!status && rows.length === 0 && <p>No reported updates waiting for office review.</p>}
    {rows.map(row => <article key={row.id} className="my-4 rounded border border-amber-500 p-4">
      <h2 className="font-bold">{row.driverName || 'Driver'} — {row.kind}</h2>
      <p>{row.reason === 'rejected_update' ? 'Update rejected; office assistance required.' : 'Delivery has failed repeatedly.'}</p>
      <p>{row.attempts} attempts · First reported {new Date(row.firstReportedAtMs).toLocaleString()}</p>
      <p className="break-all">Reference: {row.resourceId}</p>
    </article>)}
  </main>;
}
