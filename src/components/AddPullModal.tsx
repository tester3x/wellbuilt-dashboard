'use client';

// Add Pull Modal — shared component for recording a load from the dashboard.
// Used on: WB Mobile Well Status page, Well History page, Dispatch page.
// Writes an incoming packet to RTDB packets/incoming — Cloud Function processes it.
// Optionally creates Firestore invoice + ticket for billing/payroll.

import { useState, useEffect } from 'react';
import { submitManualPull, describeManualPullError } from '@/lib/staffSubmitManualPull';
import { WellResponse, subscribeToWellStatusesUnified } from '@/lib/wells';
import { type NdicWell } from '@/lib/firestoreWells';
import { useAuth } from '@/contexts/AuthContext';
import { useRouter } from 'next/navigation';

export interface ApprovedDriver {
  key: string;
  displayName: string;
  legalName?: string;
  active?: boolean;
  companyId?: string;
  companyName?: string;
  assignedRoutes?: string[];
}

interface AddPullModalProps {
  /** Well data array. If omitted, modal subscribes to all wells itself. */
  wells?: WellResponse[];
  /** Pre-fill well name (e.g. from well history page) */
  preselectedWell?: string;
  /** Driver list for Create Ticket feature */
  drivers?: ApprovedDriver[];
  /** Pre-loaded disposal wells for drop-off search */
  allDisposals?: NdicWell[];
  onClose: () => void;
  onSuccess?: (wellName: string) => void;
  /** Navigate to well history after submit (default: true) */
  navigateOnSuccess?: boolean;
  /** Global message setter from parent (optional) */
  onMessage?: (msg: string) => void;
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

export function AddPullModal({
  wells: wellsProp,
  preselectedWell,
  drivers = [],
  allDisposals = [],
  onClose,
  onSuccess,
  navigateOnSuccess = true,
  onMessage,
}: AddPullModalProps) {
  const { user } = useAuth();
  const router = useRouter();

  // If no wells provided, subscribe to all wells
  const [selfWells, setSelfWells] = useState<WellResponse[]>([]);
  useEffect(() => {
    if (wellsProp && wellsProp.length > 0) return;
    const unsub = subscribeToWellStatusesUnified(
      (w) => setSelfWells(w),
      undefined,
      { companyId: user?.companyId || null },
    );
    return unsub;
  }, [wellsProp, user?.companyId]);
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

  // Create Ticket fields
  // Bottom-after-pull estimate (display only; used by the bottom hint).
  const [bottomLevel, setBottomLevel] = useState('');

  // Set default datetime
  useEffect(() => {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    setPullDateTime(local.toISOString().slice(0, 16));
  }, []);

  // BBL per foot — use stored bblPerFoot from well_config if available, else legacy formula
  function getWellBblPerFoot(): number {
    const selectedWell = pullWell ? wells.find(w => w.wellName === pullWell) : null;
    if (selectedWell?.bblPerFoot) return selectedWell.bblPerFoot;
    const numTanks = selectedWell?.tanks || 1;
    return numTanks * 20;
  }

  function handleLevelBlur() {
    const raw = pullLevel.trim();
    if (!raw || raw.includes("'") || raw.includes('"')) return;
    const parsed = parseLevelInput(raw);
    if (parsed !== null) {
      setPullLevel(formatLevelDisplay(parsed));
      autoCalcBottomLevel(formatLevelDisplay(parsed), pullBbls);
    }
  }

  function autoCalcBottomLevel(levelStr: string, bblsStr: string) {
    const topParsed = parseLevelInput(levelStr);
    const bblsNum = parseInt(bblsStr) || 0;
    if (topParsed !== null && bblsNum > 0) {
      const bblPerFoot = getWellBblPerFoot();
      const bottomFeet = Math.max(0, topParsed - bblsNum / bblPerFoot);
      setBottomLevel(formatLevelDisplay(bottomFeet));
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
      const parsed = parseLevelInput(pullLevel);
      const levelFeet = parsed ?? 0;
      const dt = new Date(pullDateTime);

      // Governed dispatcher/admin MANUAL pull (hot oiler / washout / third-party /
      // non-WB-M/WB-T water). Replaces the legacy direct packets/incoming write
      // (denied by production rules). The callable authenticates the staff caller,
      // derives company from auth (never a client override), submits through the
      // canonical WB-M pull-input path, and creates NO ticket/invoice/Payroll/
      // Billing projection. No driver impersonation. Idempotent server-side.
      await submitManualPull({
        wellName: pullWell,
        tankLevelFeet: levelFeet,
        bblsTaken: parseInt(pullBbls) || 0,
        dateTimeUTC: dt.toISOString(),
        wellDown: pullWellDown,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });

      // WB-M-only manual dispatch entry: no ticket/invoice/Payroll/Billing is
      // created here (a genuine ticket belongs to WB-T or a separate governed
      // recovery workflow). The governed callable records level/history only.
      onMessage?.('Pull recorded successfully');
      onSuccess?.(pullWell);
      onClose();
      if (navigateOnSuccess) {
        router.push(`/well?name=${encodeURIComponent(pullWell)}`);
      }
    } catch (error) {
      console.error('Error adding pull:', error);
      setMessage(describeManualPullError(error));
      setTimeout(() => setMessage(''), 6000);
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
      const bblPerFoot = getWellBblPerFoot();
      estBbls = Math.max(0, Math.round((estInches / 12) * bblPerFoot));
    }
  }

  const lastPullStr = selectedWell?.lastPullDateTime
    ? `${selectedWell.lastPullDateTime}${selectedWell.lastPullBbls ? ` \u2022 ${selectedWell.lastPullBbls} bbl` : ''}`
    : null;

  // Bottom level hint (always visible under BBLs)
  const bottomHint = (() => {
    const topParsed = parseLevelInput(pullLevel);
    const bblsNum = parseInt(pullBbls) || 0;
    if (topParsed !== null && bblsNum > 0) {
      const bblPerFoot = getWellBblPerFoot();
      const bottomFeet = Math.max(0, topParsed - bblsNum / bblPerFoot);
      return formatLevelDisplay(bottomFeet);
    }
    return null;
  })();

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 border border-gray-700 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-white mb-4">Record Load</h3>

        {message && (
          <div className={`px-3 py-2 rounded text-sm mb-3 ${message.includes('⚠️') || message.includes('Failed') ? 'bg-red-900/50 border border-red-500 text-red-200' : 'bg-green-900/50 border border-green-500 text-green-200'}`}>
            {message}
          </div>
        )}

        {/* Well search */}
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
            onChange={(e) => setPullLevel(e.target.value)}
            onBlur={handleLevelBlur}
            placeholder="e.g. 10 6 or 10'6&quot;"
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-green-500"
          />
          <p className="text-green-500 text-xs mt-1">e.g. 10 6 or 10 5.5</p>
        </div>

        {/* Barrels Taken */}
        <div className="mb-4">
          <label className="block text-sm text-gray-400 mb-1">Barrels Taken</label>
          <input
            type="number"
            value={pullBbls}
            onChange={(e) => {
              const val = e.target.value;
              setPullBbls(val);
              autoCalcBottomLevel(pullLevel, val);
            }}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-green-500"
          />
          {bottomHint && <p className="text-green-500 text-xs mt-1">Bottom after pull: {bottomHint}</p>}
        </div>

        {/* +Add Pull is a WB-M-only manual/external-water workflow (hot oiler,
            washout, third-party, non-WB-M/WB-T). It records level/history only.
            Tickets/invoices belong to WB-T or a separate governed recovery flow —
            this control cannot and must not produce commercial documents. */}
        <p className="mb-4 text-xs text-gray-500">
          Records a WB-M level/history pull only. No ticket, invoice, Payroll, or
          Billing is created here.
        </p>

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
