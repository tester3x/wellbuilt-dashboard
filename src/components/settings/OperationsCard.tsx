'use client';

import { useState } from 'react';
import { deleteField } from 'firebase/firestore';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';
import {
  buildBooleanToggle,
  buildCancelledNumberHandling,
  buildInvoicingMode,
  buildLiveDispatchSync,
} from '@/lib/companySettingsCore';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
  /** Whether the current user may edit company operations (manageCompany). */
  canEdit: boolean;
}

export function OperationsCard({ company, onSave, canEdit }: Props) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Single write path for every control in this card. Two invariants:
  //  1. Capability gate — a user without manageCompany can never write. The
  //     controls are also disabled below, but this guards the handler too since
  //     the deployed rules do NOT enforce capability on these direct writes.
  //  2. Failures are SURFACED (not swallowed) so the operator learns the change
  //     did not apply.
  const saveField = async (key: string, fields: Record<string, unknown>) => {
    if (!canEdit) return;
    setSaving(key);
    setError(null);
    try {
      await updateCompanyFields(company.id, fields);
      onSave();
    } catch (err) {
      console.error(`Failed to save ${key}:`, err);
      setError('Could not save that change — it was not applied. Please try again.');
    } finally {
      setSaving(null);
    }
  };

  const toggle = (field: 'splitTickets' | 'transferRequiresApproval' | 'liveDispatchSync', current: boolean) =>
    saveField(field, buildBooleanToggle(field, current));

  const setCancelMode = (mode: 'recycle' | 'void') =>
    saveField('cancelledNumberHandling', buildCancelledNumberHandling(mode));

  const locked = !canEdit;

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-orange-500/30 bg-orange-900/20">
        <h3 className="text-orange-400 font-medium text-sm">Operations</h3>
      </div>

      {locked && (
        <div className="px-4 pt-3 text-gray-400 text-xs">View-only — you do not have permission to change operations settings.</div>
      )}
      {error && (
        <div className="px-4 pt-3 text-red-400 text-xs" role="alert">{error}</div>
      )}

      <div className="p-4 space-y-3">
        {/* Split Tickets toggle */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white text-sm">Split Tickets</div>
            <div className="text-gray-500 text-xs">Allow drivers to split a load across multiple tickets</div>
          </div>
          <button
            onClick={() => toggle('splitTickets', company.splitTickets || false)}
            disabled={locked || saving === 'splitTickets'}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              company.splitTickets ? 'bg-orange-500' : 'bg-gray-600'
            } ${saving === 'splitTickets' ? 'opacity-50' : ''} ${locked ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              company.splitTickets ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
        </div>

        {/* Transfer Requires Approval toggle */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white text-sm">Transfer Requires Approval</div>
            <div className="text-gray-500 text-xs">Load transfers require dispatch approval before completing</div>
          </div>
          <button
            onClick={() => toggle('transferRequiresApproval', company.transferRequiresApproval || false)}
            disabled={locked || saving === 'transferRequiresApproval'}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              company.transferRequiresApproval ? 'bg-orange-500' : 'bg-gray-600'
            } ${saving === 'transferRequiresApproval' ? 'opacity-50' : ''} ${locked ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              company.transferRequiresApproval ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
        </div>

        {/* Live Dispatch Sync — three-state: undefined (off), true (sync), false (dispatch-only) */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <div>
              <div className="text-white text-sm">Live Dispatch Sync</div>
              <div className="text-gray-500 text-xs">
                {company.liveDispatchSync === true
                  ? 'Driver jobs sync to dispatch board. Drivers can start their own loads.'
                  : company.liveDispatchSync === false
                  ? 'Dispatch-only mode. Drivers cannot start their own loads.'
                  : 'Off — no dispatch sync. Drivers work independently.'}
              </div>
            </div>
          </div>
          <div className={`flex rounded-md overflow-hidden border border-gray-600 ${saving === 'liveDispatchSync' || locked ? 'opacity-50' : ''}`}>
            <button
              onClick={() => saveField('liveDispatchSync', buildLiveDispatchSync(deleteField()))}
              disabled={locked || saving === 'liveDispatchSync'}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                company.liveDispatchSync === undefined || company.liveDispatchSync === null
                  ? 'bg-orange-500 text-black'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              Off
            </button>
            <button
              onClick={() => saveField('liveDispatchSync', buildLiveDispatchSync(true))}
              disabled={locked || saving === 'liveDispatchSync'}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                company.liveDispatchSync === true
                  ? 'bg-orange-500 text-black'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              Sync
            </button>
            <button
              onClick={() => saveField('liveDispatchSync', buildLiveDispatchSync(false))}
              disabled={locked || saving === 'liveDispatchSync'}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                company.liveDispatchSync === false
                  ? 'bg-orange-500 text-black'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              Dispatch Only
            </button>
          </div>
        </div>

        {/* Invoicing Mode — three-state: invoice_tickets (default), ticket_only, hybrid */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <div>
              <div className="text-white text-sm">Invoicing Mode</div>
              <div className="text-gray-500 text-xs">
                {(company.invoicingMode || 'invoice_tickets') === 'invoice_tickets'
                  ? 'Invoice wraps tickets. Full billing documents with grouped loads.'
                  : company.invoicingMode === 'ticket_only'
                  ? 'No invoice wrapper. Each ticket is a standalone billing document.'
                  : 'Single ticket = standalone. Multi-ticket jobs auto-create invoice wrapper.'}
              </div>
            </div>
          </div>
          <div className={`flex rounded-md overflow-hidden border border-gray-600 ${saving === 'invoicingMode' || locked ? 'opacity-50' : ''}`}>
            <button
              onClick={() => saveField('invoicingMode', buildInvoicingMode('invoice_tickets'))}
              disabled={locked || saving === 'invoicingMode'}
              className={`flex-1 px-3 py-1 text-xs font-medium transition-colors ${
                (company.invoicingMode || 'invoice_tickets') === 'invoice_tickets'
                  ? 'bg-orange-500 text-black'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              Invoice + Tickets
            </button>
            <button
              onClick={() => saveField('invoicingMode', buildInvoicingMode('ticket_only'))}
              disabled={locked || saving === 'invoicingMode'}
              className={`flex-1 px-3 py-1 text-xs font-medium transition-colors ${
                company.invoicingMode === 'ticket_only'
                  ? 'bg-orange-500 text-black'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              Ticket Only
            </button>
            <button
              onClick={() => saveField('invoicingMode', buildInvoicingMode('hybrid'))}
              disabled={locked || saving === 'invoicingMode'}
              className={`flex-1 px-3 py-1 text-xs font-medium transition-colors ${
                company.invoicingMode === 'hybrid'
                  ? 'bg-orange-500 text-black'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              Hybrid
            </button>
          </div>
        </div>

        {/* Cancelled Number Handling segmented picker */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white text-sm">Cancelled Job Numbers</div>
            <div className="text-gray-500 text-xs">Recycle deletes &amp; reuses numbers. Void keeps for audit trail.</div>
          </div>
          <div className={`flex rounded-md overflow-hidden border border-gray-600 ${saving === 'cancelledNumberHandling' || locked ? 'opacity-50' : ''}`}>
            <button
              onClick={() => setCancelMode('recycle')}
              disabled={locked || saving === 'cancelledNumberHandling'}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                (company.cancelledNumberHandling || 'recycle') === 'recycle'
                  ? 'bg-orange-500 text-black'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              Recycle
            </button>
            <button
              onClick={() => setCancelMode('void')}
              disabled={locked || saving === 'cancelledNumberHandling'}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                company.cancelledNumberHandling === 'void'
                  ? 'bg-orange-500 text-black'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              Void
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
