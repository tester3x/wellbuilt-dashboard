'use client';

// Add Pull Modal — shared component for recording a load from the dashboard.
// Used on: WB Mobile Well Status page, Well History page, Dispatch page.
// Writes an incoming packet to RTDB packets/incoming — Cloud Function processes it.

import { useState, useRef, useEffect } from 'react';
import { ref, set } from 'firebase/database';
import { getFirebaseDatabase } from '@/lib/firebase';
import { WellResponse, subscribeToWellStatusesUnified } from '@/lib/wells';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from 'next/navigation';

interface AddPullModalProps {
  /** Well data array. If omitted, modal subscribes to all wells itself. */
  wells?: WellResponse[];
  /** Pre-fill well name (e.g. from well history page) */
  preselectedWell?: string;
  onClose: () => void;
  onSuccess?: (wellName: string) => void;
  /** Navigate to well history after submit (default: true) */
  navigateOnSuccess?: boolean;
}

// ── Level parsing (same logic as WB T TicketForm) ──
function parseLevelInput(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const apostropheMatch = trimmed.match(/^(\d+)'(\d+(?:\.\d+)?)"?$/);
  if (apostropheMatch) return parseInt(apostropheMatch[1], 10) + parseFloat(apostropheMatch[2]) / 12;
  const spaceMatch = trimmed.match(/^(\d+)\s+(\d+(?:\.\d+)?)$/);
  if (spaceMatch) return parseInt(spaceMatch[1], 10) + parseFloat(spaceMatch[2]) / 12;
  if (trimmed.includes('.') && !trimmed.includes(' ')) {
    const val = parseFloat(trimmed);
    return isNaN(val) ? null : val;
  }
  const val = parseInt(trimmed, 10);
  return isNaN(val) ? null : val;
}

function formatLevelDisplay(feet: number): string {
  const totalInches = Math.floor(feet * 12 + 0.0001);
  const ft = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${ft}'${inches}"`;
}

export function AddPullModal({ wells: wellsProp, preselectedWell, onClose, onSuccess, navigateOnSuccess = true }: AddPullModalProps) {
  const { user } = useAuth();
  const router = useRouter();

  // If no wells provided, subscribe to all wells (e.g. from well history page)
  const [selfWells, setSelfWells] = useState<WellResponse[]>([]);
  useEffect(() => {
    if (wellsProp && wellsProp.length > 0) return;
    const unsub = subscribeToWellStatusesUnified((w) => setSelfWells(w));
    return unsub;
  }, [wellsProp]);
  const wells = (wellsProp && wellsProp.length > 0) ? wellsProp : selfWells;

  // Form state
  const [pullWell, setPullWell] = useState(preselectedWell || '');
  const [pullWellSearch, setPullWellSearch] = useState(preselectedWell || '');
  const [showWellDropdown, setShowWellDropdown] = useState(false);
  const [pullLevel, setPullLevel] = useState('');
  const [pullBbls, setPullBbls] = useState('140');
  const [pullWellDown, setPullWellDown] = useState(false);
  const [pullDateTime, setPullDateTime] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const levelTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Set default datetime
  useEffect(() => {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    setPullDateTime(local.toISOString().slice(0, 16));
  }, []);

  function handleLevelChange(value: string) {
    setPullLevel(value);
    if (levelTimerRef.current) clearTimeout(levelTimerRef.current);
    const trimmed = value.trim();

    const spaceMatch = trimmed.match(/^(\d+)\s+(\d+(?:\.\d+)?)$/);
    if (spaceMatch) {
      const inchStr = spaceMatch[2];
      const inchVal = parseFloat(inchStr);
      if (inchStr.length >= 2 || inchVal >= 2) {
        const parsed = parseLevelInput(trimmed);
        if (parsed !== null) setPullLevel(formatLevelDisplay(parsed));
        return;
      }
      levelTimerRef.current = setTimeout(() => {
        const parsed = parseLevelInput(trimmed);
        if (parsed !== null) setPullLevel(formatLevelDisplay(parsed));
      }, 600);
      return;
    }

    const decimalMatch = trimmed.match(/^(\d+)\.(\d+)$/);
    if (decimalMatch) {
      levelTimerRef.current = setTimeout(() => {
        const parsed = parseLevelInput(trimmed);
        if (parsed !== null) setPullLevel(formatLevelDisplay(parsed));
      }, 600);
      return;
    }

    const intMatch = trimmed.match(/^(\d+)$/);
    if (intMatch) {
      levelTimerRef.current = setTimeout(() => {
        const parsed = parseLevelInput(trimmed);
        if (parsed !== null) setPullLevel(formatLevelDisplay(parsed));
      }, 600);
    }
  }

  async function handleSubmit() {
    if (!pullWell) {
      setMessage('Select a well');
      setTimeout(() => setMessage(''), 3000);
      return;
    }
    if (!pullLevel.trim()) {
      setMessage('Enter tank level');
      setTimeout(() => setMessage(''), 3000);
      return;
    }
    if (submitting) return;
    setSubmitting(true);

    try {
      const db = getFirebaseDatabase();
      const parsed = parseLevelInput(pullLevel);
      const levelFeet = parsed ?? 0;
      const dt = new Date(pullDateTime);
      const packetId = `${dt.toISOString().replace(/[-:T.]/g, '').slice(0, 14)}_${pullWell.replace(/\s/g, '')}_dashboard`;

      const packet = {
        packetId,
        wellName: pullWell,
        tankLevelFeet: levelFeet,
        bblsTaken: parseInt(pullBbls) || 0,
        dateTime: dt.toLocaleString(),
        dateTimeUTC: dt.toISOString(),
        driverName: user?.displayName || user?.email || 'Dashboard',
        driverId: user?.uid || 'dashboard',
        requestType: 'pull',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        wellDown: pullWellDown,
      };

      await set(ref(db, `packets/incoming/${packetId}`), packet);
      onSuccess?.(pullWell);
      onClose();
      if (navigateOnSuccess) {
        router.push(`/well?name=${encodeURIComponent(pullWell)}`);
      }
    } catch (error) {
      console.error('Error adding pull:', error);
      setMessage('Failed to add pull. Check connection and try again.');
      setTimeout(() => setMessage(''), 5000);
    } finally {
      setSubmitting(false);
    }
  }

  // Find selected well data for info box
  const selectedWell = pullWell ? wells.find(w => w.wellName === pullWell) : null;

  // Calculate estimated level at selected date/time
  let estLevelDisplay = selectedWell?.currentLevel || '--';
  let estBbls = selectedWell?.bbls || 0;

  if (selectedWell) {
    let flowRateMinutes = 0;
    if (selectedWell.flowRate && selectedWell.flowRate !== '--') {
      const parts = selectedWell.flowRate.split(':');
      if (parts.length === 3) {
        flowRateMinutes = (parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0) + (parseInt(parts[2]) || 0) / 60;
      } else if (parts.length === 2) {
        flowRateMinutes = (parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0);
      }
    }

    let bottomAfterPullInches = 0;
    if (selectedWell.lastPullBottomLevel) {
      const blMatch = selectedWell.lastPullBottomLevel.match(/(\d+)'(\d+)"/);
      if (blMatch) bottomAfterPullInches = parseInt(blMatch[1]) * 12 + parseInt(blMatch[2]);
    }

    let baseTimestamp = 0;
    if (selectedWell.lastPullDateTimeUTC) {
      baseTimestamp = new Date(selectedWell.lastPullDateTimeUTC).getTime();
    } else if (selectedWell.timestampUTC) {
      baseTimestamp = new Date(selectedWell.timestampUTC).getTime();
    } else if (selectedWell.timestamp) {
      baseTimestamp = new Date(selectedWell.timestamp).getTime();
    }

    if (baseTimestamp > 0 && flowRateMinutes > 0 && bottomAfterPullInches > 0 && pullDateTime) {
      const selectedTime = new Date(pullDateTime).getTime();
      const minutesElapsed = (selectedTime - baseTimestamp) / (1000 * 60);
      const minutesPerInch = flowRateMinutes / 12;
      let estInches = bottomAfterPullInches + (minutesElapsed / minutesPerInch);
      estInches = Math.max(0, estInches);
      const estFeet = Math.floor(estInches / 12);
      const estRemInches = Math.round(estInches % 12);
      estLevelDisplay = `${estFeet}'${estRemInches}"`;
      const currentLevelInches = selectedWell.currentLevelInches || estInches;
      const bblPerFoot = selectedWell.bbls && currentLevelInches > 0
        ? (selectedWell.bbls / (currentLevelInches / 12))
        : 20;
      estBbls = Math.max(0, Math.round((estInches / 12) * bblPerFoot));
    }
  }

  const lastPullStr = selectedWell?.lastPullDateTime
    ? `${selectedWell.lastPullDateTime}${selectedWell.lastPullBbls ? ` \u2022 ${selectedWell.lastPullBbls} bbl` : ''}`
    : null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 border border-gray-700">
        <h3 className="text-lg font-semibold text-white mb-4">Record Load</h3>

        {message && (
          <div className="bg-red-900/50 border border-red-500 text-red-200 px-3 py-2 rounded text-sm mb-3">
            {message}
          </div>
        )}

        {/* Well search — always shown, pre-filled when coming from a specific well */}
        <div className="mb-4 relative">
          <label className="block text-sm text-gray-400 mb-1">Well</label>
          <input
            type="text"
            value={pullWellSearch}
            onChange={(e) => {
              setPullWellSearch(e.target.value);
              setPullWell('');
              setShowWellDropdown(true);
            }}
            onFocus={() => setShowWellDropdown(true)}
            placeholder="Search wells..."
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-green-500"
          />
          {showWellDropdown && pullWellSearch && (
            <div className="absolute z-50 top-full left-0 w-full mt-1 bg-gray-900 border border-gray-600 rounded-lg shadow-lg max-h-48 overflow-y-auto">
              {[...new Set(wells.map(w => w.wellName))].sort()
                .filter(w => w.toLowerCase().includes(pullWellSearch.toLowerCase()))
                .slice(0, 10)
                .map(w => (
                  <button key={w} onClick={() => { setPullWell(w); setPullWellSearch(w); setShowWellDropdown(false); }}
                    className="w-full text-left px-3 py-2 text-sm text-white hover:bg-gray-700 transition-colors">
                    {w}
                  </button>
                ))
              }
            </div>
          )}
        </div>

        {/* Well info box */}
        {selectedWell && (
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 mb-4 text-sm space-y-1">
            <div>
              <span className="text-gray-500">Estimated tank level:  </span>
              <span className="text-white font-semibold">{estLevelDisplay}</span>
              {estBbls > 0 && <span className="text-gray-400"> - {estBbls} BBL</span>}
            </div>
            <div>
              <span className="text-gray-500">Estimated flow rate:  </span>
              <span className="text-white font-semibold">{selectedWell.flowRate || '--'}</span>
            </div>
            {lastPullStr && (
              <div>
                <span className="text-gray-500">Last pull:  </span>
                <span className="text-white font-semibold">{lastPullStr}</span>
              </div>
            )}
          </div>
        )}

        {/* Well DOWN checkbox */}
        <div className="flex justify-end mb-3">
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <span className={pullWellDown ? 'text-red-400 font-medium' : 'text-gray-500'}>Well DOWN</span>
            <input
              type="checkbox"
              checked={pullWellDown}
              onChange={(e) => setPullWellDown(e.target.checked)}
              className="rounded border-gray-500 text-red-500 focus:ring-red-500 bg-gray-800"
            />
          </label>
        </div>

        {/* Date/Time */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Date/Time</label>
            <input
              type="datetime-local"
              value={pullDateTime}
              onChange={(e) => setPullDateTime(e.target.value)}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500"
            />
          </div>
          <div />
        </div>

        {/* Tank Level */}
        <div className="mb-4">
          <label className="block text-sm text-gray-400 mb-1">Tank Level</label>
          <input
            type="text"
            value={pullLevel}
            onChange={(e) => handleLevelChange(e.target.value)}
            onBlur={() => {
              const raw = pullLevel.trim();
              if (!raw || raw.includes("'") || raw.includes('"')) return;
              const parsed = parseLevelInput(raw);
              if (parsed !== null) setPullLevel(formatLevelDisplay(parsed));
            }}
            placeholder="e.g. 10 8 or 10' 8&quot;"
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-green-500"
          />
          <p className="text-green-500 text-xs mt-1">e.g. 10 6 or 10 5.5</p>
        </div>

        {/* Barrels Taken */}
        <div className="mb-6">
          <label className="block text-sm text-gray-400 mb-1">Barrels Taken</label>
          <input
            type="number"
            value={pullBbls}
            onChange={(e) => setPullBbls(e.target.value)}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500"
          />
        </div>

        {/* Buttons */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !pullWell}
            className="flex-1 px-4 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
          >
            {submitting ? 'Adding...' : 'Submit Pull'}
          </button>
        </div>
      </div>
    </div>
  );
}
