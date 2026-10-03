'use client';
import { useMemo, useRef, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '@/lib/firebase';
import { importWallTime, importWallTimeToUtc } from '@/lib/pullImportTime';
import { readPullExport } from '@/lib/pullImportFile';
import { parsePullChat, findPullChatNotices, type PullImportRow } from '../../../functions/src/imports/pullParser';

type ReviewRow = PullImportRow & { status: 'ready' | 'review' | 'duplicate' | 'excluded'; packetId: string; bank: number; afterFeet: number | null };
type Preview = { batchId: string; expiresAt: number; rows: ReviewRow[]; counts: Record<string, number>; calibration: { wellName: string; bblPerFoot: number; tankHeight: number | null }[] };
export function HistoricalPullImportTab({ configs }: { configs: Record<string, { ndicName?: string; bblPerFoot?: number; tanks?: number; tankCapacity?: number; tankHeight?: number }> }) {
  const [text, setText] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [defaultWell, setDefaultWell] = useState('');
  const [defaultBbls, setDefaultBbls] = useState('');
  const [timeZone, setTimeZone] = useState('America/Chicago');
  const [dateOrder, setDateOrder] = useState<'mdy' | 'dmy'>('mdy');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [rows, setRows] = useState<PullImportRow[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [banks, setBanks] = useState<Record<string, number>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState('all');
  const generation = useRef(0);
  const [parsedSettings, setParsedSettings] = useState('');
  const settingsKey = JSON.stringify({ defaultWell, defaultBbls, timeZone, dateOrder, startDate, endDate });
  const notices = useMemo(() => text ? findPullChatNotices(text) : [], [text]);
  const names = Object.keys(configs).sort();
  const inputClass = 'bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white w-full';
  function invalidate() { generation.current++; setPreview(null); setSelected(new Set()); setResult(null); setError(''); }
  function parse(source = text) {
    invalidate(); setAcknowledged(new Set()); setPage(0);
    try { setParsedSettings(settingsKey); setRows(parsePullChat(source, { wellNames: names.flatMap(name => [name, configs[name].ndicName || '']).filter(Boolean), defaultWell, defaultBbls: defaultBbls ? Number(defaultBbls) : undefined, timeZone, dateOrder, startDate, endDate })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  async function upload(file?: File) {
    if (!file) return;
    invalidate(); setBusy(true); const token = generation.current;
    try { const value = await readPullExport(file); if (token !== generation.current) return; setSourceName(file.name); setText(value); setConfirmed(false); setBanks({}); parse(value); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function changeRow(id: string, patch: Partial<PullImportRow>) { invalidate(); setRows(previous => previous.map(row => row.id === id ? { ...row, ...patch } : row)); }
  async function runPreview() {
    invalidate(); setBusy(true); const token = generation.current;
    try {
      const fn = httpsCallable(getFirebaseFunctions(), 'previewHistoricalPullImport', { timeout: 120000 });
      const response = await fn({ rows: rows.filter(row => !row.excluded), banks, acknowledged: [...acknowledged], calibrationConfirmed: confirmed, sourceName });
      if (token !== generation.current) return;
      const data = response.data as Preview;
      const excluded = rows.filter(row => row.excluded).map(row => ({ ...row, status: 'excluded' as const, packetId: '', bank: 0, afterFeet: null }));
      data.rows = [...data.rows, ...excluded];
      data.counts.excluded = excluded.length;
      setPreview(data); setRows(data.rows.map(({ status, packetId, bank, afterFeet, ...row }) => row));
      setSelected(new Set(data.rows.filter(row => row.status === 'ready').map(row => row.id))); setPage(0);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview || !selected.size || busy) return;
    setBusy(true); setError('');
    try {
      const fn = httpsCallable(getFirebaseFunctions(), 'applyHistoricalPullImport', { timeout: 120000 });
      const response = await fn({ batchId: preview.batchId, selectedIds: [...selected] });
      setResult(response.data); setSelected(new Set());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function downloadReport() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ sourceName, preview, result }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `pull-import-${preview?.batchId || 'preview'}.json`; link.click(); URL.revokeObjectURL(url);
  }
  const display = (preview?.rows || rows.map(row => ({ ...row, status: row.excluded ? 'excluded' : row.issues.length ? 'review' : 'unverified' }))).filter(row => filter === 'all' || row.status === filter);
  const pageRows = display.slice(page * 25, page * 25 + 25);
  const usedWells = [...new Set(rows.map(row => row.wellName).filter(name => configs[name]))];
  return <section className="bg-gray-900 rounded-lg p-4 space-y-4 text-gray-100">
    <h3 className="text-xl font-semibold">Import past pulls</h3>
    <p className="text-sm text-gray-300">Upload one WhatsApp channel at a time. Preview, review flagged entries, and import only checked rows. Written barrels override the default. Periods mean decimal feet; apostrophes and spaces mean feet/inches.</p>
    <fieldset disabled={busy} className="space-y-4 disabled:opacity-70">
      <label className="block">WhatsApp ZIP or TXT <input aria-label="WhatsApp export" type="file" accept=".zip,.txt" className="block mt-1" onChange={e => upload(e.target.files?.[0])} /></label>
      {sourceName && <p className="text-sm">Loaded: {sourceName}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <label>Well for unnamed entries<select aria-label="Default well" className={inputClass} value={defaultWell} onChange={e => { invalidate(); setDefaultWell(e.target.value); }}><option value="">Choose when needed</option>{names.map(name => <option key={name}>{name}</option>)}</select></label>
        <label>Default barrels (only if missing)<input className={inputClass} type="number" min="1" max="1000" value={defaultBbls} onChange={e => { invalidate(); setDefaultBbls(e.target.value); }} /></label>
        <label>Chat time zone<select className={inputClass} value={timeZone} onChange={e => { invalidate(); setTimeZone(e.target.value); }}><option value="America/Chicago">Central</option><option value="America/Denver">Mountain</option><option value="UTC">UTC</option></select></label>
        <label>Start date<input className={inputClass} type="date" value={startDate} onChange={e => { invalidate(); setStartDate(e.target.value); }} /></label>
        <label>End date<input className={inputClass} type="date" value={endDate} onChange={e => { invalidate(); setEndDate(e.target.value); }} /></label>
        <label>Export date order<select className={inputClass} value={dateOrder} onChange={e => { invalidate(); setDateOrder(e.target.value as 'mdy' | 'dmy'); }}><option value="mdy">Month / day / year</option><option value="dmy">Day / month / year</option></select></label>
      </div>
      <button disabled={!text} className="bg-gray-700 rounded px-3 py-2 disabled:opacity-40" onClick={() => parse()}>Parse with these settings</button>
      {!!notices.length && <details className="border border-amber-500 rounded p-3"><summary>Tank setup notices ({notices.length}) — review before importing</summary><p className="text-sm my-2">A changed tank bank changes the math. Split the date range at a tank change and use the bank valid for that range.</p>{notices.map(notice => <pre key={notice.messageIndex} className="whitespace-pre-wrap text-sm my-2 border-t border-gray-700 pt-2">{notice.source}</pre>)}</details>}
      {!!rows.length && <>
        <div className="grid sm:grid-cols-2 gap-3">{usedWells.map(well => <label key={well}>{well}: barrels per foot across active tanks<input aria-label={`${well} calibration`} className={inputClass} type="number" min="0.01" max="1000" step="any" placeholder={String(configs[well].bblPerFoot || 'Required if missing')} value={banks[well] ?? ''} onChange={e => { invalidate(); const value = e.target.value; setBanks(previous => { const next = { ...previous }; if (value) next[well] = Number(value); else delete next[well]; return next; }); setConfirmed(false); }} /></label>)}</div>
        <label className="block text-sm"><input type="checkbox" checked={confirmed} onChange={e => { invalidate(); setConfirmed(e.target.checked); }} /> I checked that the tank calibration was valid for this date range. I understand this adds history and seeds the average without changing the last live pull.</label>
        <button disabled={!confirmed || !rows.some(row => !row.excluded) || parsedSettings !== settingsKey} onClick={runPreview} className="bg-blue-600 rounded px-3 py-2 disabled:opacity-40">Check saved history and preview</button>{parsedSettings !== settingsKey && <p className="text-amber-300 text-sm">Settings changed. Click “Parse with these settings” before previewing.</p>}
      </>}
      {!!rows.length && <>
        <div className="flex flex-wrap items-center gap-3"><span>{rows.length} entries</span><select aria-label="Row filter" className="bg-gray-800 border border-gray-600 p-1" value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }}><option value="all">All</option><option value="review">Needs review</option><option value="ready">Ready</option><option value="duplicate">Already saved</option><option value="excluded">Excluded</option></select>{preview && <span className="text-sm">{Object.entries(preview.counts).map(([key, value]) => `${value} ${key}`).join(' · ')}</span>}</div>
        <div className="overflow-x-auto"><table className="w-full text-sm min-w-[900px]"><thead><tr className="text-left"><th>Import</th><th>Well</th><th>Pull time ({timeZone === 'America/Chicago' ? 'Central' : timeZone === 'America/Denver' ? 'Mountain' : 'UTC'})</th><th>Top (feet)</th><th>Barrels</th><th>Review</th></tr></thead><tbody>{pageRows.map(row => <tr key={row.id} className="border-t border-gray-700 align-top">
          <td className="p-2"><input aria-label={`Select ${row.id}`} type="checkbox" disabled={row.status !== 'ready' || !!result} checked={selected.has(row.id)} onChange={e => setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(row.id); else next.delete(row.id); return next; })} /><label className="block text-xs mt-2"><input type="checkbox" checked={row.excluded} onChange={e => changeRow(row.id, { excluded: e.target.checked })} /> Exclude</label></td>
          <td className="p-2"><select aria-label={`Well ${row.id}`} className={inputClass} value={row.wellName} onChange={e => changeRow(row.id, { wellName: e.target.value })}>{!configs[row.wellName] && <option value={row.wellName}>{row.wellName || 'Choose well'}</option>}{names.map(name => <option key={name}>{name}</option>)}</select></td>
          <td className="p-2"><input aria-label={`Time ${row.id}`} className={inputClass} type="datetime-local" step="1" value={importWallTime(row.dateTimeUTC, timeZone)} onChange={e => { try { changeRow(row.id, { dateTimeUTC: e.target.value ? importWallTimeToUtc(e.target.value, timeZone) : '' }); } catch { setError('That time is ambiguous or invalid. Choose the actual pull time.'); } }} /></td>
          <td className="p-2"><input aria-label={`Top ${row.id}`} className={inputClass} type="number" step="any" value={row.tankLevelFeet ?? ''} onChange={e => changeRow(row.id, { tankLevelFeet: e.target.value ? Number(e.target.value) : null })} /></td>
          <td className="p-2"><input aria-label={`Barrels ${row.id}`} className={inputClass} type="number" step="any" value={row.bblsTaken ?? ''} onChange={e => changeRow(row.id, { bblsTaken: e.target.value ? Number(e.target.value) : null })} /></td>
          <td className="p-2 max-w-xs"><span className={row.status === 'ready' ? 'text-green-400' : row.status === 'review' ? 'text-amber-300' : 'text-gray-400'}>{row.status}</span>{row.issues.map(issue => <p key={issue} className="text-xs text-amber-200">{issue}</p>)}{!!row.issues.length && <label className="block text-xs my-2"><input type="checkbox" checked={acknowledged.has(row.id)} onChange={e => { invalidate(); setAcknowledged(previous => { const next = new Set(previous); if (e.target.checked) next.add(row.id); else next.delete(row.id); return next; }); }} /> I checked or corrected this entry; preview again</label>}<details className="mt-2"><summary>Original message</summary><pre className="whitespace-pre-wrap text-xs mt-2">{row.source}</pre></details></td>
        </tr>)}</tbody></table></div>
        <div className="flex gap-3 items-center"><button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page + 1} of {Math.max(1, Math.ceil(display.length / 25))}</span><button disabled={(page + 1) * 25 >= display.length} onClick={() => setPage(page + 1)}>Next</button></div>
      </>}
      {preview && !result && <div className="flex flex-wrap gap-3 items-center"><button className="bg-green-700 rounded px-4 py-2 disabled:opacity-40" disabled={!selected.size || Date.now() > preview.expiresAt} onClick={apply}>Import {selected.size} checked pulls</button><span className="text-xs">Preview expires in 20 minutes. A new live pull requires a fresh preview.</span></div>}
    </fieldset>
    {busy && <p role="status">Working…</p>}
    {error && <p role="alert" className="text-red-300 whitespace-pre-wrap">{error}</p>}
    {result && <div role="status" className="bg-green-950 rounded p-3"><p>Imported {result.imported} pulls; skipped {result.duplicates} already saved.</p>{result.modelResults?.map((model: any) => <p key={model.wellName}>{model.wellName}: {model.seeded ? `average ${model.flowRate}, ${model.bbls24hrs} bbl/day` : model.reason}{model.seeded && !model.statusSeeded ? ' — live status changed; its seed was skipped.' : ''}</p>)}<p className="text-sm mt-2">Last live pull and down state preserved. No tickets or invoices created.</p></div>}
    {preview && <button className="underline text-sm" onClick={downloadReport}>Download import report</button>}
  </section>;
}


