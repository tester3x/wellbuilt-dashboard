'use client';

import { useState } from 'react';
import { deleteField } from 'firebase/firestore';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

export function OperationsCard({ company, onSave }: Props) {
  const [saving, setSaving] = useState<string | null>(null);

  const toggle = async (field: 'splitTickets' | 'transferRequiresApproval' | 'liveDispatchSync', current: boolean) => {
    setSaving(field);
    try {
      await updateCompanyFields(company.id, { [field]: !current });
      onSave();
    } catch (err) {
      console.error(`Failed to toggle ${field}:`, err);
    } finally {
      setSaving(null);
    }
  };

  const setCancelMode = async (mode: 'recycle' | 'void') => {
    setSaving('cancelledNumberHandling');
    try {
      await updateCompanyFields(company.id, { cancelledNumberHandling: mode });
      onSave();
    } catch (err) {
      console.error('Failed to update cancel mode:', err);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-orange-500/30 bg-orange-900/20">
        <h3 className="text-orange-400 font-medium text-sm">Operations</h3>
      </div>

      <div className="p-4 space-y-3">
        {/* Split Tickets toggle */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white text-sm">Split Tickets</div>
            <div className="text-gray-500 text-xs">Allow drivers to split a load across multiple tickets</div>
          </div>
          <button
            onClick={() => toggle('splitTickets', company.splitTickets || false)}
            disabled={saving === 'splitTickets'}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              company.splitTickets ? 'bg-orange-500' : 'bg-gray-600'
            } ${saving === 'splitTickets' ? 'opacity-50' : ''}`}
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
            disabled={saving === 'transferRequiresApproval'}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              company.transferRequiresApproval ? 'bg-orange-500' : 'bg-gray-600'
            } ${saving === 'transferRequiresApproval' ? 'opacity-50' : ''}`}
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
          <div className={`flex rounded-md overflow-hidden border border-gray-600 ${saving === 'liveDispatchSync' ? 'opacity-50' : ''}`}>
            <button
              onClick={async () => {
                setSaving('liveDispatchSync');
                try {
                  await updateCompanyFields(company.id, { liveDispatchSync: deleteField() as any });
                  onSave();
                } catch (err) { console.error(err); } finally { setSaving(null); }
              }}
              disabled={saving === 'liveDispatchSync'}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                company.liveDispatchSync === undefined || company.liveDispatchSync === null
                  ? 'bg-orange-500 text-black'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              Off
            </button>
            <button
              onClick={async () => {
                setSaving('liveDispatchSync');
                try {
                  await updateCompanyFields(company.id, { liveDispatchSync: true });
                  onSave();
                } catch (err) { console.error(err); } finally { setSaving(null); }
              }}
              disabled={saving === 'liveDispatchSync'}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                company.liveDispatchSync === true
                  ? 'bg-orange-500 text-black'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              Sync
            </button>
            <button
              onClick={async () => {
                setSaving('liveDispatchSync');
                try {
                  await updateCompanyFields(company.id, { liveDispatchSync: false });
                  onSave();
                } catch (err) { console.error(err); } finally { setSaving(null); }
              }}
              disabled={saving === 'liveDispatchSync'}
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
          <div className={`flex rounded-md overflow-hidden border border-gray-600 ${saving === 'invoicingMode' ? 'opacity-50' : ''}`}>
            <button
              onClick={async () => {
                setSaving('invoicingMode');
                try {
                  await updateCompanyFields(company.id, { invoicingMode: 'invoice_tickets' });
                  onSave();
                } catch (err) { console.error(err); } finally { setSaving(null); }
              }}
              disabled={saving === 'invoicingMode'}
              className={`flex-1 px-3 py-1 text-xs font-medium transition-colors ${
                (company.invoicingMode || 'invoice_tickets') === 'invoice_tickets'
                  ? 'bg-orange-500 text-black'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              Invoice + Tickets
            </button>
            <button
              onClick={async () => {
                setSaving('invoicingMode');
                try {
                  await updateCompanyFields(company.id, { invoicingMode: 'ticket_only' });
                  onSave();
                } catch (err) { console.error(err); } finally { setSaving(null); }
              }}
              disabled={saving === 'invoicingMode'}
              className={`flex-1 px-3 py-1 text-xs font-medium transition-colors ${
                company.invoicingMode === 'ticket_only'
                  ? 'bg-orange-500 text-black'
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              Ticket Only
            </button>
            <button
              onClick={async () => {
                setSaving('invoicingMode');
                try {
                  await updateCompanyFields(company.id, { invoicingMode: 'hybrid' });
                  onSave();
                } catch (err) { console.error(err); } finally { setSaving(null); }
              }}
              disabled={saving === 'invoicingMode'}
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
          <div className={`flex rounded-md overflow-hidden border border-gray-600 ${saving === 'cancelledNumberHandling' ? 'opacity-50' : ''}`}>
            <button
              onClick={() => setCancelMode('recycle')}
              disabled={saving === 'cancelledNumberHandling'}
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
              disabled={saving === 'cancelledNumberHandling'}
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
