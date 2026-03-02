'use client';

import { useState } from 'react';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

export function InvoiceConfigCard({ company, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [invoicePrefix, setInvoicePrefix] = useState(company.invoicePrefix || '');
  const [ticketPrefix, setTicketPrefix] = useState(company.ticketPrefix || '');
  const [invoiceBook, setInvoiceBook] = useState(company.invoiceBook || false);
  const [notes, setNotes] = useState(company.notes || '');

  const startEdit = () => {
    setInvoicePrefix(company.invoicePrefix || '');
    setTicketPrefix(company.ticketPrefix || '');
    setInvoiceBook(company.invoiceBook || false);
    setNotes(company.notes || '');
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await updateCompanyFields(company.id, {
        invoicePrefix: invoicePrefix.trim() || null,
        ticketPrefix: ticketPrefix.trim() || null,
        invoiceBook,
        notes: notes.trim() || null,
      });
      setEditing(false);
      onSave();
    } catch (err) {
      console.error('Failed to save invoice config:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-teal-500/30 bg-teal-900/20">
        <h3 className="text-teal-400 font-medium text-sm">Invoice &amp; Ticket Config</h3>
        {!editing && (
          <button
            onClick={startEdit}
            className="px-3 py-1 text-xs rounded bg-teal-600 hover:bg-teal-500 text-white"
          >
            Edit
          </button>
        )}
      </div>

      <div className="p-4">
        {editing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-gray-400 text-xs block mb-1">Invoice Prefix</label>
                <input
                  type="text"
                  value={invoicePrefix}
                  onChange={e => setInvoicePrefix(e.target.value)}
                  placeholder="e.g., LG"
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-gray-400 text-xs block mb-1">Ticket Prefix</label>
                <input
                  type="text"
                  value={ticketPrefix}
                  onChange={e => setTicketPrefix(e.target.value)}
                  placeholder="e.g., WT"
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="settings-invoiceBook"
                checked={invoiceBook}
                onChange={e => setInvoiceBook(e.target.checked)}
                className="rounded"
              />
              <label htmlFor="settings-invoiceBook" className="text-gray-300 text-sm">
                Uses Invoice Book (sequential invoice numbering)
              </label>
            </div>
            <div>
              <label className="text-gray-400 text-xs block mb-1">Notes</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Any special instructions..."
                className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm h-20 resize-none"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded text-sm disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-gray-400">Invoice Prefix:</span>
                <span className="text-white ml-2 font-mono">{company.invoicePrefix || '—'}</span>
              </div>
              <div>
                <span className="text-gray-400">Ticket Prefix:</span>
                <span className="text-white ml-2 font-mono">{company.ticketPrefix || '—'}</span>
              </div>
            </div>
            <div>
              <span className="text-gray-400">Invoice Book:</span>
              <span className="text-white ml-2">{company.invoiceBook ? 'Yes' : 'No'}</span>
            </div>
            {company.notes && (
              <div>
                <span className="text-gray-400">Notes:</span>
                <span className="text-gray-300 ml-2">{company.notes}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
