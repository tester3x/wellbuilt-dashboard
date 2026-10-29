'use client';

import { useEffect, useRef, useState } from 'react';
import { getFullReport, getVerifiedEvidenceReadUrl, listFullReports,
  type FullReportDetail, type FullReportSummary } from '@/lib/equipment/fullReports';

export function FullReportsPanel({ companyId }: { companyId: string }) {
  const [rows, setRows] = useState<FullReportSummary[]>([]);
  const [selected, setSelected] = useState<FullReportDetail | null>(null);
  const [photo, setPhoto] = useState<{ url: string; label: string } | null>(null);
  const photoRequest = useRef(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    photoRequest.current += 1;
    setLoading(true); setError(''); setRows([]); setSelected(null); setPhoto(null);
    listFullReports(companyId).then(result => { if (live) setRows(result); })
      .catch(err => { if (live) setError(err instanceof Error ? err.message : 'Could not load full reports'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [companyId]);
  const open = async (documentId: string) => {
    const token = ++photoRequest.current; setPhoto(null);
    try {
      const report = await getFullReport(companyId, documentId);
      if (token === photoRequest.current) { setSelected(report); setError(''); }
    } catch (err) {
      if (token === photoRequest.current) setError(err instanceof Error ? err.message : 'Could not open report');
    }
  };
  const close = () => { photoRequest.current += 1; setPhoto(null); setSelected(null); };
  const viewPhoto = async (evidenceId: string, label: string) => {
    if (!selected) return;
    const token = ++photoRequest.current;
    setPhoto(null); setError('');
    try {
      const result = await getVerifiedEvidenceReadUrl(companyId, selected.documentId, evidenceId);
      if (token === photoRequest.current) { setPhoto({ url: result.url, label }); setError(''); }
    } catch (err) {
      if (token === photoRequest.current) setError(err instanceof Error ? err.message : 'Could not open photo');
    }
  };
  return <section className="mt-8">
    <h2 className="text-lg font-semibold mb-3">Complete DVIR reports</h2>
    {error && <p role="alert" className="text-red-300 mb-3">{error}</p>}
    {loading ? <p className="text-gray-400">Loading reports…</p> : rows.length === 0
      ? <p className="text-gray-400">No complete reports submitted yet.</p>
      : <div className="overflow-x-auto rounded-lg border border-gray-700"><table className="w-full text-sm">
        <thead className="bg-gray-800 text-gray-400"><tr>
          <th className="text-left p-3">Completed</th><th className="text-left p-3">Assets</th>
          <th className="text-left p-3">Type</th><th className="text-left p-3">Driver</th>
          <th className="text-left p-3">Result</th>
        </tr></thead><tbody>{rows.map(row => <tr key={row.documentId} className="border-t border-gray-700">
          <td className="p-3"><button type="button" onClick={() => open(row.documentId)} className="text-blue-300 hover:underline">{new Date(row.completedAt).toLocaleString()}</button></td>
          <td className="p-3">{row.assetLabels.join(' + ')}</td><td className="p-3">{row.inspectionType.replace('_', ' ')} · v{row.version}</td>
          <td className="p-3">{row.driverId}</td><td className="p-3">{row.noDefects ? 'No defects' : 'Needs attention'}</td>
        </tr>)}</tbody></table></div>}
    {selected && <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={close}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto p-6" onClick={event => event.stopPropagation()}>
        <div className="flex justify-between gap-4 mb-4"><div><h2 className="text-xl font-bold">DVIR {selected.inspectionType.replace('_', ' ')} · v{selected.version}</h2>
          <p className="text-sm text-gray-400">{selected.inspectionId} · {new Date(selected.completedAt).toLocaleString()}</p></div>
          <button type="button" onClick={close} aria-label="Close report">✕</button></div>
        {error && <p role="alert" className="text-red-300 mb-3">{error}</p>}
        <p className="mb-3">{selected.driver.displayName || selected.driver.driverHash} · {selected.noDefects ? 'No defects' : `${selected.issues.length} issue(s)`}</p>
        {selected.inspectionProfile && <p className="text-sm text-gray-400 mb-3">Profile {selected.inspectionProfile.profileId}, revision {selected.inspectionProfile.revision}</p>}
        {selected.assets.map(asset => <div key={asset.assetId} className="mb-5">
          <h3 className="font-semibold capitalize border-b border-gray-700 pb-1">{asset.role}: {asset.label || asset.unitNumber || asset.assetId}</h3>
          {selected.areas.filter(area => area.assetId === asset.assetId).map(area => <div key={area.areaId} className="mt-3">
            <h4 className="text-blue-200 font-medium">{area.label}</h4>
            <ul className="text-sm mt-1">{area.items.map(item => <li key={item.itemId} className="flex justify-between border-b border-gray-800 py-1 gap-4">
              <span>{item.componentLabel}</span><span className={item.result === 'pass' ? 'text-emerald-300' : 'text-amber-300'}>{item.result.replace('_', ' ')}</span>
            </li>)}</ul></div>)}
        </div>)}
        {selected.issues.length > 0 && <div><h3 className="font-semibold">Issues</h3>{selected.issues.map(issue => {
          const evidence = selected.verifiedEvidence.find(item => item.binding.issueId === issue.issueId);
          return <div key={issue.issueId} className="text-sm border-b border-gray-800 py-2">
            {issue.componentLabel} · {issue.severity}: {issue.notes || 'No note'}
            {evidence && <button type="button" className="ml-3 text-blue-300 hover:underline"
              onClick={() => viewPhoto(evidence.evidenceId, issue.componentLabel)}>View verified photo</button>}
          </div>;
        })}</div>}
        {photo && <div className="mt-4 rounded border border-gray-700 p-3">
          <div className="flex justify-between gap-3 mb-2"><strong>{photo.label} photo</strong>
            <button type="button" onClick={() => { photoRequest.current += 1; setPhoto(null); }}>Close photo</button></div>
          {/* The authenticated read URL is temporary and never saved in the report. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo.url} alt={`${photo.label} inspection evidence`} referrerPolicy="no-referrer"
            className="max-h-[55vh] max-w-full object-contain" />
        </div>}
        <p className="text-sm text-gray-400 mt-5">Signed {new Date(selected.signature.signedAt).toLocaleString()} by {selected.signature.signerDisplayName || selected.driver.displayName || selected.driver.driverHash}</p>
      </div></div>}
  </section>;
}
