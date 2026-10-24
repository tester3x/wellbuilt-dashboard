'use client';

import { useId, useState } from 'react';

export type PlannedShift = 'day' | 'night' | 'off';

export interface PickerDriver {
  key: string;
  displayName: string;
  legalName?: string;
  loginAlias?: string;
  shiftPlan?: Record<string, PlannedShift>;
}

interface Props {
  drivers: PickerDriver[];
  selectedKeys: Set<string>;
  onSelect: (key: string) => void;
  selection: 'single' | 'multiple';
  shiftDate: string;
  onShiftDateChange: (date: string) => void;
  onShiftChange: (driver: PickerDriver, date: string, shift: PlannedShift) => Promise<void>;
  shiftDot: (driver: PickerDriver) => { symbol: string; title: string };
  readOnlyShifts?: boolean;
  disabledSelection?: boolean;
  onSelectMany?: (keys: string[]) => void;
  suggestedKey?: string | null;
}

/** One job selection control and one dated shift control for all Dispatch builders. */
export function DispatchDriverPicker({ drivers, selectedKeys, onSelect, selection, shiftDate, onShiftDateChange, onShiftChange, shiftDot, readOnlyShifts, disabledSelection, onSelectMany, suggestedKey }: Props) {
  const [filter, setFilter] = useState<'both' | 'day' | 'night'>('both');
  const [search, setSearch] = useState('');
  const pickerId = useId();
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const groups: { shift: PlannedShift | 'unassigned'; title: string; color: string }[] = [
    { shift: 'day', title: 'Day shift', color: 'border-amber-600/40 bg-amber-950/20 text-amber-300' },
    { shift: 'night', title: 'Night shift', color: 'border-blue-600/40 bg-blue-950/20 text-blue-300' },
    { shift: 'off', title: 'Off', color: 'border-gray-700 bg-gray-900/60 text-gray-400' },
    { shift: 'unassigned', title: 'Unassigned', color: 'border-gray-700 bg-gray-900/60 text-gray-400' },
  ];

  async function setShift(driver: PickerDriver, shift: PlannedShift) {
    if (savingKey || readOnlyShifts || driver.shiftPlan?.[shiftDate] === shift) return;
    setSavingKey(driver.key);
    setError('');
    try { await onShiftChange(driver, shiftDate, shift); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save shift'); }
    finally { setSavingKey(null); }
  }

  return <div className="flex min-h-0 flex-col rounded border border-gray-700 bg-gray-900/70 text-xs">
    <div className="flex flex-wrap items-center gap-2 border-b border-gray-700 p-2">
      <label className="text-gray-400">Shift date <input type="date" value={shiftDate} onChange={e => onShiftDateChange(e.target.value)} className="ml-1 rounded border border-gray-600 bg-gray-800 px-1 py-1 text-white" /></label>
      <div className="ml-auto flex gap-1" aria-label="Show shifts">
        {(['day', 'night', 'both'] as const).map(value => <button key={value} type="button" onClick={() => setFilter(value)} aria-pressed={filter === value}
          className={`rounded px-2 py-1 capitalize ${filter === value ? 'bg-cyan-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>{value}</button>)}
      </div>
    </div>
    {selection === 'multiple' && onSelectMany && <div className="flex flex-wrap items-center gap-2 border-b border-gray-700 p-2">
      <input type="search" aria-label="Search drivers" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search drivers"
        className="min-w-0 flex-1 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-white" />
      <button type="button" disabled={disabledSelection} onClick={() => {
        const visible = drivers.filter(driver => (filter === 'both' || driver.shiftPlan?.[shiftDate] === filter) &&
          `${driver.displayName} ${driver.legalName || ''} ${driver.loginAlias || ''}`.toLowerCase().includes(search.trim().toLowerCase()));
        onSelectMany([...new Set([...selectedKeys, ...visible.map(driver => driver.key)])]);
      }} className="rounded bg-cyan-900 px-2 py-1 text-cyan-200 disabled:opacity-40">Select shown</button>
      <button type="button" disabled={disabledSelection || selectedKeys.size === 0} onClick={() => onSelectMany([])}
        className="rounded bg-gray-800 px-2 py-1 text-gray-300 disabled:opacity-40">Clear selection</button>
      <span className="text-gray-400">{selectedKeys.size} selected</span>
    </div>}
    {error && <div role="alert" className="px-2 py-1 text-red-300">{error}</div>}
    <div className="max-h-[min(38vh,360px)] min-h-0 overflow-y-auto" aria-label="Driver list">
      {groups.filter(group => filter === 'both' || group.shift === filter).map(group => {
        const rows = drivers.filter(driver => (driver.shiftPlan?.[shiftDate] || 'unassigned') === group.shift &&
            `${driver.displayName} ${driver.legalName || ''} ${driver.loginAlias || ''}`.toLowerCase().includes(search.trim().toLowerCase()))
          .sort((a, b) => (a.legalName || a.displayName).localeCompare(b.legalName || b.displayName));
        if (!rows.length) return null;
        return <div key={group.shift} className={`border-b last:border-b-0 ${group.color}`}>
          <div className="px-2 py-1 font-bold uppercase tracking-wide">{group.title} ({rows.length})</div>
          {rows.map(driver => {
            const current = driver.shiftPlan?.[shiftDate];
            const dot = shiftDot(driver);
            return <div key={driver.key} className={`flex items-center gap-2 border-t border-gray-700/60 px-2 py-1.5 text-gray-100 ${selectedKeys.has(driver.key) ? 'bg-cyan-950/30' : ''}`}>
              <label className={`flex min-w-0 flex-1 items-center gap-2 py-1 ${disabledSelection ? 'cursor-not-allowed' : 'cursor-pointer hover:text-cyan-200'}`}>
                <input type={selection === 'single' ? 'radio' : 'checkbox'} name={selection === 'single' ? pickerId : undefined}
                  aria-label={`Choose ${driver.legalName || driver.displayName} for job`}
                  checked={selectedKeys.has(driver.key)} disabled={disabledSelection} onChange={() => onSelect(driver.key)} className="shrink-0" />
                <span role="img" aria-label={dot.title} title={dot.title}>{dot.symbol}</span>
                <span className="min-w-0 flex-1 truncate">{driver.legalName || driver.displayName}</span>
                {suggestedKey === driver.key && <span className="shrink-0 rounded bg-cyan-900 px-1.5 py-0.5 text-cyan-100">Suggested</span>}
              </label>
              <div className="flex shrink-0 items-center gap-0.5 rounded border border-gray-600 bg-gray-800 p-0.5" aria-label={`Planned shift for ${driver.legalName || driver.displayName}`}>
                <button type="button" onClick={() => setShift(driver, 'day')} disabled={!!savingKey || readOnlyShifts}
                  aria-label={`Set ${driver.legalName || driver.displayName} to day shift on ${shiftDate}`} aria-pressed={current === 'day'}
                  className={`rounded px-1.5 py-0.5 font-bold ${current === 'day' ? 'bg-amber-600 text-white' : 'text-gray-400 hover:text-white'}`}>D</button>
                <button type="button" onClick={() => setShift(driver, 'night')} disabled={!!savingKey || readOnlyShifts}
                  aria-label={`Set ${driver.legalName || driver.displayName} to night shift on ${shiftDate}`} aria-pressed={current === 'night'}
                  className={`rounded px-1.5 py-0.5 font-bold ${current === 'night' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>N</button>
              </div>
              <button type="button" onClick={() => setShift(driver, 'off')} disabled={!!savingKey || readOnlyShifts}
                aria-label={`Mark ${driver.legalName || driver.displayName} off on ${shiftDate}`}
                className={`shrink-0 rounded px-1 py-0.5 ${current === 'off' ? 'bg-gray-600 text-white' : 'text-gray-500 hover:text-white'}`}>Off</button>
            </div>;
          })}
        </div>;
      })}
      {!drivers.length && <div className="p-2 text-gray-400">No drivers available.</div>}
    </div>
  </div>;
}
