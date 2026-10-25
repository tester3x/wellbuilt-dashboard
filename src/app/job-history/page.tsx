'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import { AppHeader } from '@/components/AppHeader';
import { useAuth } from '@/contexts/AuthContext';
import { hasCapability } from '@/lib/auth';
import { loadAllCompanies, type CompanyConfig } from '@/lib/companySettings';
import { isResolvedDispatchCard } from '@/lib/dispatchActiveVisibility';
import { dispatchTimestampToDate } from '@/lib/dispatchTimestampToDate';
import { getFirestoreDb } from '@/lib/firebase';
import { docBelongsToTenant } from '@/lib/tenantScope';

interface HistoryJob {
  id: string;
  companyId?: string;
  status: string;
  reassignedTo?: string;
  wellName?: string;
  ndicWellName?: string;
  driverName?: string;
  driverFirstName?: string;
  jobType?: string;
  serviceType?: string;
  ticketNumber?: string;
  invoiceNumber?: string;
  assignedAt?: unknown;
  declinedAt?: unknown;
  dismissedAt?: unknown;
  dismissReason?: string;
  declineReason?: string;
  cancelledReason?: string;
  cancelReason?: string;
  dismissedBy?: string;
}

const PAGE_SIZE = 50;

function dateLabel(value: unknown): string {
  return dispatchTimestampToDate(value)?.toLocaleString() || '—';
}

function resolvedTime(job: HistoryJob): number {
  return (dispatchTimestampToDate(job.dismissedAt)
    || dispatchTimestampToDate(job.declinedAt)
    || dispatchTimestampToDate(job.assignedAt))?.getTime() || 0;
}

export default function JobHistoryPage() {
  const { user, userCompany, authResolved } = useAuth();
  const router = useRouter();
  const canView = hasCapability(user, 'viewDispatch', userCompany);
  const [companies, setCompanies] = useState<CompanyConfig[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [jobs, setJobs] = useState<HistoryJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [decision, setDecision] = useState<'all' | 'dismissed' | 'reassigned'>('all');
  const [shown, setShown] = useState(PAGE_SIZE);
  const viewedCompanyId = user?.companyId || companyId;

  useEffect(() => {
    if (!authResolved) return;
    if (!user) router.push('/login');
    else if (!canView) router.push('/');
  }, [authResolved, user, canView, router]);

  useEffect(() => {
    if (!authResolved || !user || !canView || user.companyId) return;
    loadAllCompanies().then(setCompanies).catch(() => setError('Could not load company list.'));
  }, [authResolved, user, canView]);

  const loadHistory = useCallback(async () => {
    if (!user || !canView || !viewedCompanyId) return;
    setLoading(true);
    setError('');
    try {
      // Use the same tenant-scoped read as Dispatch. No write or number recycling
      // occurs on this page; the original dispatch document is the audit record.
      const dispatches = collection(getFirestoreDb(), 'dispatches');
      const snap = await getDocs(user.companyId
        ? query(dispatches, where('companyId', '==', viewedCompanyId))
        : query(dispatches,
            where('status', 'in', ['dismissed', 'cancelled', 'declined']),
            orderBy('assignedAt', 'desc')));
      const records = snap.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as HistoryJob))
        .filter(job => docBelongsToTenant(job.companyId, viewedCompanyId) && isResolvedDispatchCard(job))
        .sort((a, b) => resolvedTime(b) - resolvedTime(a));
      setJobs(records);
      setShown(PAGE_SIZE);
    } catch (err) {
      console.error('Failed to load job history:', err);
      setJobs([]);
      setError('Could not load job history. Try again.');
    } finally {
      setLoading(false);
    }
  }, [user, canView, viewedCompanyId]);

  useEffect(() => {
    if (!authResolved || !user || !canView || !viewedCompanyId) return;
    void loadHistory();
  }, [authResolved, user, canView, viewedCompanyId, loadHistory]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return jobs.filter(job => {
      if (decision === 'dismissed' && job.status !== 'dismissed') return false;
      if (decision === 'reassigned' && job.status === 'dismissed') return false;
      if (!needle) return true;
      return [job.id, job.wellName, job.ndicWellName, job.driverName,
        job.driverFirstName, job.reassignedTo, job.ticketNumber, job.invoiceNumber,
        job.dismissReason, job.declineReason, job.cancelledReason, job.cancelReason]
        .some(value => String(value || '').toLowerCase().includes(needle));
    });
  }, [jobs, search, decision]);

  if (!authResolved || !user || !canView) return null;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link href="/dispatch/?tab=cancelled" className="text-sm text-cyan-300 hover:underline">← Back to Needs Review</Link>
            <h1 className="mt-2 text-2xl font-bold">Job History</h1>
            <p className="text-sm text-gray-400">Dismissed and reassigned jobs. Saved for reference after Dispatch has made a decision.</p>
          </div>
          <button type="button" onClick={() => void loadHistory()} disabled={!viewedCompanyId || loading}
            className="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-50">Refresh</button>
        </div>

        {!user.companyId && (
          <label className="block max-w-sm text-sm text-gray-300">Company
            <select value={companyId} onChange={event => { setCompanyId(event.target.value); setJobs([]); }}
              className="mt-1 block w-full rounded border border-slate-600 bg-slate-900 p-2">
              <option value="">Select a company</option>
              {companies.map(company => <option key={company.id} value={company.id}>{company.name || company.id}</option>)}
            </select>
          </label>
        )}

        {viewedCompanyId && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-60 flex-1 text-sm text-gray-300">Search history
              <input value={search} onChange={event => { setSearch(event.target.value); setShown(PAGE_SIZE); }}
                placeholder="Well, driver, ticket, invoice, reason, or job ID"
                className="mt-1 block w-full rounded border border-slate-600 bg-slate-900 p-2" />
            </label>
            <label className="text-sm text-gray-300">Decision
              <select value={decision} onChange={event => { setDecision(event.target.value as typeof decision); setShown(PAGE_SIZE); }}
                className="mt-1 block w-full rounded border border-slate-600 bg-slate-900 p-2">
                <option value="all">All resolved</option>
                <option value="dismissed">Dismissed</option>
                <option value="reassigned">Reassigned</option>
              </select>
            </label>
          </div>
        )}

        {error && <p role="alert" className="rounded border border-red-700 bg-red-950 p-3 text-red-200">{error}</p>}
        {loading && <p className="text-gray-400">Loading job history…</p>}
        {!loading && viewedCompanyId && !error && (
          <>
            <p className="text-sm text-gray-400">{filtered.length} matching {filtered.length === 1 ? 'job' : 'jobs'}</p>
            {filtered.length === 0 && <p className="rounded border border-slate-700 p-6 text-gray-400">No resolved jobs match this search.</p>}
            <div className="space-y-3">
              {filtered.slice(0, shown).map(job => (
                <article key={job.id} className="rounded-lg border border-slate-700 bg-slate-900 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h2 className="font-semibold">{job.ndicWellName || job.wellName || 'Job without a well name'}</h2>
                      <p className="text-sm text-gray-400">{job.serviceType || job.jobType || 'Job'} · {job.driverName || job.driverFirstName || 'Driver unknown'}</p>
                    </div>
                    <span className="rounded bg-slate-700 px-2 py-1 text-xs font-semibold uppercase">{job.status === 'dismissed' ? 'Dismissed' : 'Reassigned'}</span>
                  </div>
                  <dl className="mt-3 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div><dt className="text-gray-400">Assigned</dt><dd>{dateLabel(job.assignedAt)}</dd></div>
                    <div><dt className="text-gray-400">Dismissed / declined</dt><dd>{dateLabel(job.dismissedAt || job.declinedAt)}</dd></div>
                    {job.reassignedTo && <div><dt className="text-gray-400">Reassigned to</dt><dd>{job.reassignedTo}</dd></div>}
                    {(job.ticketNumber || job.invoiceNumber) && <div><dt className="text-gray-400">Ticket / invoice</dt><dd>{[job.ticketNumber, job.invoiceNumber].filter(Boolean).join(' / ')}</dd></div>}
                    <div><dt className="text-gray-400">Job ID</dt><dd className="break-all font-mono text-xs">{job.id}</dd></div>
                  </dl>
                  {(job.declineReason || job.cancelledReason || job.cancelReason || job.dismissReason) && (
                    <div className="mt-3 space-y-1 text-sm">
                      {(job.declineReason || job.cancelledReason || job.cancelReason) && <p><span className="text-gray-400">Driver reason:</span> {job.declineReason || job.cancelledReason || job.cancelReason}</p>}
                      {job.dismissReason && <p><span className="text-gray-400">Dispatch reason:</span> {job.dismissReason}</p>}
                    </div>
                  )}
                </article>
              ))}
            </div>
            {filtered.length > shown && <button type="button" onClick={() => setShown(value => value + PAGE_SIZE)}
              className="rounded bg-slate-800 px-4 py-2 text-sm hover:bg-slate-700">Show 50 more</button>}
          </>
        )}
        {!viewedCompanyId && <p className="text-gray-400">Select a company to view its job history.</p>}
      </main>
    </div>
  );
}
