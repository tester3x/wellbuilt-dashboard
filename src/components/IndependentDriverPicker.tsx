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
      active: driver.active, source: 'Outside', preference: driver.shiftPreference || 'unset' })),
    ...linked.map(driver => ({ key: `wellbuilt:${driver.driverId}`, name: driver.displayName,
      active: driver.active, source: 'WB', preference: profiles.find(profile => profile.driverKey === `wellbuilt:${driver.driverId}`)?.shiftPreference || 'unset' })),
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
      {([{ shift: 'day', label: 'Day Shift' }, { shift: 'night', label: 'Night Shift' }, { shift: '', label: 'Shift not set' }] as const).map(group => {
        const groupRows = rows.filter(driver => shiftFor(driver) === group.shift);
        if (!groupRows.length) return null;
        return <div key={group.label} role="group" aria-label={`${group.label} candidates`} className="mb-2 last:mb-0">
        <p className="mb-1 flex justify-between text-xs font-semibold text-cyan-200"><span>{group.label}</span><span>{groupRows.length}</span></p>
        {groupRows.map(driver => {
          const current = assignedShifts.has(driver.key);
          const availability = driverAvailability(job, driver.key, jobs, driver.active, now);
          const unavailable = current || !availability.available;
          const checked = Object.prototype.hasOwnProperty.call(selected, driver.key);
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
              <span className="shrink-0 rounded border border-gray-600 px-1 text-[10px] text-gray-300">{driver.source}</span>
            </label>
            <p className="min-w-0 break-words text-[11px] text-gray-400">{current ? 'On this job' : availability.label}{driver.preference === 'day' || driver.preference === 'night' ? ` · Profile: ${driver.preference}` : ''}</p>
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
