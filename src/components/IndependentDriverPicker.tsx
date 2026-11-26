'use client';

import type { ExternalDriver } from '@/lib/externalAssignmentDelivery';
import type { IndependentJob, LinkedWellBuiltDriver } from '@/lib/independentDispatchJobs';
import type { IndependentDriverProfile } from '@/lib/independentDriverProfiles';
import { driverAvailability } from '@/lib/independentDriverAvailability';

export type SelectedDriverShifts = Record<string, '' | 'day' | 'night'>;

export function IndependentDriverPicker({ job, jobs, outside, linked, profiles, now, selected, onChange, disabled }: {
  job: IndependentJob; jobs: IndependentJob[]; outside: ExternalDriver[]; linked: LinkedWellBuiltDriver[];
  profiles: IndependentDriverProfile[]; now: number; selected: SelectedDriverShifts;
  onChange: (next: SelectedDriverShifts) => void; disabled: boolean;
}) {
  const defaultShift = job.shift === 'day' || job.shift === 'night' ? job.shift : '';
  const assignedShifts = new Map<string, '' | 'day' | 'night'>(Array.isArray(job.drivers)
    ? job.drivers.map(driver => [driver.key, driver.shift || ''] as const)
    : job.externalDriverId ? [[`outside:${job.externalDriverId}`, defaultShift]]
      : job.wbDriverId ? [[`wellbuilt:${job.wbDriverId}`, defaultShift]] : []);
  const rows = [
    ...outside.map(driver => ({ key: `outside:${driver.externalDriverId}`, name: driver.displayName,
      active: driver.active, preference: driver.shiftPreference || 'unset' })),
    ...linked.map(driver => ({ key: `wellbuilt:${driver.driverId}`, name: driver.displayName,
      active: driver.active, preference: profiles.find(profile => profile.driverKey === `wellbuilt:${driver.driverId}`)?.shiftPreference || 'unset' })),
  ];
  function shiftFor(driver: typeof rows[number]): '' | 'day' | 'night' {
    if (Object.prototype.hasOwnProperty.call(selected, driver.key)) return selected[driver.key];
    const saved = assignedShifts.get(driver.key);
    if (saved === 'day' || saved === 'night') return saved;
    if (driver.preference === 'day' || driver.preference === 'night') return driver.preference;
    return defaultShift;
  }
  const count = Object.keys(selected).length;
  return <details className="w-full rounded border border-gray-600 bg-gray-900 text-sm text-white">
    <summary className="cursor-pointer px-3 py-2 text-cyan-200">Choose drivers{count ? ` · ${count}` : ''}</summary>
    <div className="max-h-64 overflow-auto border-t border-gray-700 p-2">
      {([{ preference: 'day', label: 'Prefers day shift' }, { preference: 'night', label: 'Prefers night shift' },
        { preference: 'either', label: 'Either shift' }, { preference: 'unset', label: 'Preference not set' }] as const).map(group => {
        const groupRows = rows.filter(driver => driver.preference === group.preference);
        if (!groupRows.length) return null;
        return <div key={group.label} role="group" aria-label={`${group.label} candidates`} className="mb-2 last:mb-0">
        <p className="mb-1 flex justify-between text-xs font-semibold text-cyan-200"><span>{group.label} · {groupRows.length}</span><span>Shift on this job</span></p>
        {groupRows.map(driver => {
          const current = assignedShifts.has(driver.key);
          const availability = driverAvailability(job, driver.key, jobs, driver.active, now);
          const unavailable = current || !availability.available;
          const checked = Object.prototype.hasOwnProperty.call(selected, driver.key);
          const commitments = jobs.filter(item => ['assigned', 'in_progress'].includes(item.status)).flatMap(item => {
            const legacyMatch = driver.key === `outside:${item.externalDriverId}` || driver.key === `wellbuilt:${item.wbDriverId}`;
            const member = Array.isArray(item.drivers) ? item.drivers.find(entry => entry.key === driver.key)
              : legacyMatch ? { shift: item.shift === 'day' || item.shift === 'night' ? item.shift : '' } : null;
            return member ? [{ id: item.id, status: item.status, title: item.title, shift: member.shift || '' }] : [];
          });
          return <div key={driver.key} className="grid grid-cols-[minmax(8rem,1fr)_minmax(0,1.5fr)_auto] items-center gap-2 rounded px-2 py-1 hover:bg-gray-800">
            <label className={`flex min-w-0 items-center gap-2 ${unavailable ? 'text-gray-500' : 'text-white'}`}>
              <input type="checkbox" aria-label={`Choose ${driver.name} for ${job.title}`} checked={checked} disabled={disabled || (unavailable && !checked)}
                onChange={event => {
                  const next = { ...selected };
                  if (event.target.checked) next[driver.key] = shiftFor(driver);
                  else delete next[driver.key];
                  onChange(next);
                }} />
              <span className="truncate">{driver.name}</span>
            </label>
            <div className="min-w-0 text-[11px] text-gray-400"><p className="break-words">{current ? 'On this job' : availability.label}</p>
              {!!commitments.length && <div className="mt-1 flex flex-wrap gap-1">{commitments.map(item => <span key={item.id} title={item.title}
                className={`rounded border px-1 py-0.5 ${item.status === 'in_progress' ? 'border-amber-600 text-amber-200' : 'border-blue-600 text-blue-200'}`}>
                {item.status === 'in_progress' ? 'Working' : 'Assigned'} · {item.shift === 'day' ? 'Day' : item.shift === 'night' ? 'Night' : 'shift unset'}
              </span>)}</div>}
              {checked && <span className="mt-1 inline-block rounded border border-cyan-600 px-1 py-0.5 text-cyan-200">This job · {shiftFor(driver) === 'day' ? 'Day' : shiftFor(driver) === 'night' ? 'Night' : 'shift unset'}</span>}
            </div>
            <select aria-label={`Shift for ${driver.name} on ${job.title}`} value={shiftFor(driver)} disabled={disabled || unavailable}
              onChange={event => onChange({ ...selected, [driver.key]: event.target.value as SelectedDriverShifts[string] })}
              className="rounded border border-gray-600 bg-gray-950 px-2 py-1 text-xs text-white">
              <option value="">Unset</option><option value="day">Day</option><option value="night">Night</option>
            </select>
          </div>;
        })}
      </div>; })}
    </div>
  </details>;
}
