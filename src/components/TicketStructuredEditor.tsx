'use client';

import { useState } from 'react';
import type { Ticket } from '@/lib/tickets';
import { staffMutateTicketPaper } from '@/lib/canonicalPaper';

export function TicketStructuredEditor(input: {
  ticket: Ticket;
  allowedFields: string[];
  canEdit: boolean;
  onPreview?: () => void;
  previewAvailable?: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  function valueFor(field: string): string {
    if (draft[field] != null) return draft[field];
    const raw = (input.ticket as unknown as Record<string, unknown>)[field];
    return raw == null ? '' : String(raw);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSaved('');
    const fields: Record<string, unknown> = {};
    for (const field of input.allowedFields) {
      if (draft[field] != null) fields[field] = draft[field];
    }
    if (!Object.keys(fields).length) {
      setError('No changes.');
      return;
    }
    try {
      await staffMutateTicketPaper(input.ticket.id, fields);
      setSaved('Saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'mutation_rejected');
    }
  }

  return (
    <div className="bg-[#111827] border border-gray-700 rounded-lg p-6 text-white" data-paper-mode="edit_form">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">Structured ticket editor</h2>
        <div className="flex gap-3">
          {input.previewAvailable && input.onPreview && (
            <button type="button" className="text-sm text-yellow-400 underline" onClick={input.onPreview}>
              Preview paper
            </button>
          )}
          <button type="button" className="text-sm text-gray-400" onClick={input.onClose}>Close</button>
        </div>
      </div>
      <form onSubmit={onSubmit} className="space-y-3">
        {input.allowedFields.map((field) => (
          <label key={field} className="block text-sm">
            <span className="text-gray-400">{field}</span>
            <input
              className="mt-1 w-full bg-gray-900 border border-gray-600 rounded px-2 py-1"
              value={valueFor(field)}
              disabled={!input.canEdit}
              onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
            />
          </label>
        ))}
        {input.canEdit && (
          <button type="submit" className="bg-cyan-700 hover:bg-cyan-600 px-4 py-2 rounded text-sm">Save</button>
        )}
        {error && <p className="text-red-400 text-sm" data-paper-rejected-draft="true">{error}</p>}
        {saved && <p className="text-green-400 text-sm">{saved}</p>}
      </form>
    </div>
  );
}
