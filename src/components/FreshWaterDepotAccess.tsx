'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '@/lib/firebase';
import type { NdicWell } from '@/lib/firestoreWells';

interface Props {
  companyId: string;
  depots: NdicWell[];
}

const empty = { login: '', passcode: '' };
const inputClass = 'w-full rounded border border-gray-600 bg-gray-950 px-2 py-1.5 text-white';

export function FreshWaterDepotAccess({ companyId, depots }: Props) {
  const [catalogId, setCatalogId] = useState('');
  const [credentials, setCredentials] = useState(empty);
  const [loadedDepot, setLoadedDepot] = useState('');
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!catalogId) return;
    let active = true;
    const call = httpsCallable<unknown, typeof empty>(getFirebaseFunctions(), 'staffFreshWaterDepotAccess');
    void call({ action: 'read', companyId, catalogId }).then(({ data }) => {
      if (!active) return;
      setCredentials(data);
      setLoadedDepot(catalogId);
    }).catch(() => {
      if (active) setMessage('Depot access could not be loaded. Check your permissions and try again.');
    });
    return () => { active = false; };
  }, [catalogId, companyId]);

  const changeDepot = (nextId: string) => {
    setCredentials(empty);
    setLoadedDepot('');
    setRevealed(false);
    setMessage('');
    setCatalogId(nextId);
  };

  const save = async (action: 'save' | 'clear') => {
    if (loadedDepot !== catalogId || !catalogId || saving) return;
    setSaving(true);
    setRevealed(false);
    setMessage('');
    try {
      const call = httpsCallable(getFirebaseFunctions(), 'staffFreshWaterDepotAccess');
      await call({ action, companyId, catalogId, ...(action === 'save' ? credentials : {}) });
      if (action === 'clear') setCredentials(empty);
      setMessage(action === 'save' ? 'Depot access saved.' : 'Depot access cleared.');
    } catch {
      setMessage('Depot access could not be updated. Check your permissions and try again.');
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save('save');
  };

  return (
    <form onSubmit={submit} className="mb-3 grid gap-2 rounded border border-gray-700 bg-gray-900 p-3 text-sm">
      <p className="font-semibold text-white">Fresh Water Depot Access</p>
      <p className="text-gray-400">Credentials for the selected company. Dispatch and admins only.</p>
      <label>
        <span>Fresh water depot</span>
        <select value={catalogId} onChange={e => changeDepot(e.target.value)} disabled={saving} className={inputClass}>
          <option value="">Choose a depot</option>
          {depots.filter(depot => depot.catalogId).map(depot => (
            <option key={depot.catalogId} value={depot.catalogId}>
              {depot.well_name}{depot.county ? ' · ' + depot.county : ''} · {depot.catalogId}
            </option>
          ))}
        </select>
      </label>
      {catalogId && loadedDepot !== catalogId && !message && <p role="status">Loading depot access…</p>}
      {catalogId && loadedDepot === catalogId && (
        <fieldset disabled={saving} className="grid gap-2">
          <label>
            <span>Login</span>
            <input className={inputClass} autoComplete="off" maxLength={128} value={credentials.login}
              onChange={e => setCredentials({ ...credentials, login: e.target.value })} />
          </label>
          <label>
            <span>Passcode</span>
            <input className={inputClass} type={revealed ? 'text' : 'password'} autoComplete="new-password"
              maxLength={128} value={credentials.passcode}
              onChange={e => setCredentials({ ...credentials, passcode: e.target.value })} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={!credentials.login.trim() && !credentials.passcode.trim()}
              className="rounded bg-cyan-700 px-2 py-1 text-white disabled:opacity-50">Save access</button>
            <button type="button" onClick={() => setRevealed(!revealed)} className="rounded border border-gray-600 px-2 py-1">
              {revealed ? 'Hide passcode' : 'Show passcode'}
            </button>
            <button type="button" onClick={() => {
              if (window.confirm('Clear the saved login and passcode for this depot?')) void save('clear');
            }} className="rounded border border-gray-600 px-2 py-1">Clear saved access</button>
          </div>
        </fieldset>
      )}
      {message && <p role="status">{message}</p>}
    </form>
  );
}
