'use client';

import { useRef, useState } from 'react';
import { formatDispatchOnsiteByInput, parseDispatchOnsiteByInput } from '@/lib/dispatchOnsiteByInput';

type PartName = 'month' | 'day' | 'year' | 'hour' | 'minute';
type Parts = Record<PartName, string> & { meridiem: '' | 'AM' | 'PM' };

const emptyParts: Parts = { month: 'mm', day: 'dd', year: 'yyyy', hour: 'hh', minute: 'mm', meridiem: '' };
const fields: { name: PartName; label: string; length: number; width: string }[] = [
  { name: 'month', label: 'Month', length: 2, width: 'w-7' },
  { name: 'day', label: 'Day', length: 2, width: 'w-7' },
  { name: 'year', label: 'Year', length: 4, width: 'w-12' },
  { name: 'hour', label: 'Hour', length: 2, width: 'w-7' },
  { name: 'minute', label: 'Minute', length: 2, width: 'w-7' },
];

function partsFromValue(value: string): Parts {
  const formatted = formatDispatchOnsiteByInput(value);
  const match = formatted.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!match) return { ...emptyParts };
  return { month: match[1], day: match[2], year: match[3], hour: match[4], minute: match[5], meridiem: match[6] as 'AM' | 'PM' };
}

export function SegmentedOnsiteByInput({ value, onChange }: {
  value: string;
  onChange: (value: string, hasTypedPart: boolean) => void;
}) {
  const [parts, setParts] = useState<Parts>(() => partsFromValue(value));
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const meridiemRef = useRef<HTMLSelectElement | null>(null);

  function update(next: Parts) {
    setParts(next);
    const hasTypedPart = fields.some(({ name }) => /\d/.test(next[name]));
    const parsed = next.meridiem
      ? parseDispatchOnsiteByInput(`${next.month}/${next.day}/${next.year} ${next.hour}:${next.minute} ${next.meridiem}`)
      : null;
    onChange(parsed || '', hasTypedPart);
  }

  return (
    <div className="relative w-full overflow-x-auto rounded border border-gray-700 bg-gray-900 text-white text-sm focus-within:border-purple-500">
      <div className="flex min-w-[270px] items-center gap-0.5 px-2 py-1.5">
        {fields.map(({ name, label, length, width }, index) => (
          <span key={name} className="inline-flex items-center gap-0.5">
            {index === 1 || index === 2 ? <span className="text-gray-400">/</span> : null}
            {index === 3 ? <span className="w-1" /> : null}
            {index === 4 ? <span className="text-gray-400">:</span> : null}
            <input
              ref={(node) => { refs.current[index] = node; }}
              id={index === 0 ? 'sw-onsite-by' : undefined}
              type="text"
              inputMode="numeric"
              enterKeyHint="next"
              autoComplete="off"
              aria-label={`Be onsite by ${label}`}
              value={parts[name]}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.currentTarget.select()}
              onChange={(e) => update({ ...parts, [name]: e.target.value.replace(/\D/g, '').slice(0, length) })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (refs.current[index + 1] || meridiemRef.current)?.focus();
                }
              }}
              className={`${width} min-w-0 bg-transparent text-center text-white rounded-sm focus:bg-purple-600/40 focus:outline-none`}
            />
          </span>
        ))}
        <select
          ref={meridiemRef}
          aria-label="Be onsite by AM or PM"
          value={parts.meridiem}
          onChange={(e) => update({ ...parts, meridiem: e.target.value as Parts['meridiem'] })}
          className="ml-0.5 w-12 bg-transparent text-white focus:outline-none"
        >
          <option value="">--</option>
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </select>
        <svg aria-hidden="true" className="ml-auto mr-1 h-4 w-4 shrink-0 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7">
          <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4m10-4v4M3 10h18" />
        </svg>
      </div>
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (next && next.length > 16) return;
          setParts(partsFromValue(next));
          onChange(next, !!next);
        }}
        max="2099-12-31T23:59"
        aria-label="Choose Be onsite by date and time"
        onClick={(e) => {
          try { e.currentTarget.showPicker(); } catch { /* Native tap remains available. */ }
        }}
        className="sw-onsite-picker absolute right-0 top-0 h-full w-9 opacity-0 cursor-pointer"
      />
    </div>
  );
}
