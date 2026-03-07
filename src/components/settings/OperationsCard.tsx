'use client';

import { useState } from 'react';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

export function OperationsCard({ company, onSave }: Props) {
  const [saving, setSaving] = useState<string | null>(null);

  const toggle = async (field: 'splitTickets' | 'transferRequiresApproval', current: boolean) => {
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
