'use client';

/**
 * Company Join Code card (Employee Onboarding).
 *
 * Self-contained, drop into an expanded company row. Calls the deployed,
 * governed getCompanyJoinCode callable via adminGetCompanyJoinCode — it
 * retrieves the company's existing 8-character code or allocates one on first
 * use, and NEVER replaces an existing code. Company admins are server-scoped to
 * their own company; platform admins target the row's company by id.
 *
 * Guarantees: gated to manage-drivers/platform admins (drivers never see it);
 * the plaintext code lives only in transient React state + an explicit
 * clipboard copy — never in logs, analytics, the URL, or browser storage.
 */
import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { isPlatformAdmin } from '../../lib/auth';
import { adminGetCompanyJoinCode } from '../../lib/secureDriverAdmin';
import {
  canManageJoinCode,
  joinCodeCallArgs,
  friendlyJoinCodeError,
  joinCodeActionLabel,
  type JoinCodeState,
} from '../../lib/joinCodeCardModel';

export function CompanyJoinCodeCard({ companyId }: { companyId: string }) {
  const { user, userCompany } = useAuth();
  const [state, setState] = useState<JoinCodeState>({ phase: 'idle' });
  const [copied, setCopied] = useState(false);

  // Clear the displayed plaintext code when the card unmounts (leaving the page /
  // collapsing the row) and whenever the target company changes — the code never
  // lingers in state across navigation or company switches.
  useEffect(() => {
    return () => {
      setState({ phase: 'idle' });
      setCopied(false);
    };
  }, []);
  useEffect(() => {
    setState({ phase: 'idle' });
    setCopied(false);
  }, [companyId]);

  // Drivers and unauthorized users never see or invoke the control.
  if (!canManageJoinCode(user, userCompany)) return null;

  const platform = isPlatformAdmin(user);

  const load = async () => {
    if (state.phase === 'loading') return;
    setCopied(false);
    setState({ phase: 'loading' });
    try {
      const { joinCode } = await adminGetCompanyJoinCode(joinCodeCallArgs(platform, companyId));
      setState({ phase: 'ready', joinCode });
    } catch (err) {
      setState({ phase: 'error', message: friendlyJoinCodeError(err) });
    }
  };

  const copy = async () => {
    if (state.phase !== 'ready') return;
    try {
      await navigator.clipboard.writeText(state.joinCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="border-t border-gray-600 pt-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-cyan-400 text-sm font-medium">Company Join Code</h4>
        {state.phase !== 'ready' && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void load();
            }}
            disabled={state.phase === 'loading'}
            className="px-2 py-1 text-xs rounded bg-cyan-700 hover:bg-cyan-600 text-white disabled:opacity-50"
          >
            {joinCodeActionLabel(state)}
          </button>
        )}
      </div>

      <p className="text-gray-400 text-xs mb-2">
        New employees enter this 8-character code when registering in WB Mobile to join your
        company. It is generated once and reused — share it privately with each new hire. Anyone
        with the code can request to join (you still approve every registration).
      </p>

      {state.phase === 'ready' && (
        <div className="flex items-center gap-3">
          <span className="font-mono tracking-widest text-lg text-white bg-gray-900 border border-gray-600 rounded px-3 py-1 select-all">
            {state.joinCode}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              void copy();
            }}
            className="px-2 py-1 text-xs rounded bg-green-700 hover:bg-green-600 text-white"
          >
            {copied ? '✓ Copied!' : 'Copy Code'}
          </button>
        </div>
      )}

      {state.phase === 'error' && (
        <div
          role="status"
          className="text-red-300 text-xs bg-red-900/30 border border-red-700 rounded p-2"
        >
          {state.message}
        </div>
      )}
    </div>
  );
}
