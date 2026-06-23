'use client';

// Bulk Maintained Well Import modal. Single modal, in-place states
// (input → preview). P1 is PREVIEW ONLY — no writes. The Import button is
// inert unless an `onImport` handler is supplied (wired in P2).

import { useEffect, useState } from 'react';
import { loadOperators, loadWellsForOperator, type NdicOperator } from '@/lib/firestoreWells';
import {
  parseImportText,
  matchRows,
  summarize,
  type ImportRow,
  type ImportStatus,
} from '@/lib/bulkWellImport';

interface BulkWellImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Existing route names for the Default Route dropdown (incl. 'Unrouted'). */
  routes: string[];
  /** Current maintained-well names, for ALREADY_MAINTAINED detection. */
  existingWellNames: string[];
  /** P2: supplied to enable writes. Receives the rows approved for import. */
  onImport?: (rows: ImportRow[]) => Promise<void>;
}

const STATUS_META: Record<ImportStatus, { icon: string; cls: string; label: string }> = {
  MATCHED: { icon: '✓', cls: 'text-green-400', label: 'matched' },
  NEEDS_REVIEW: { icon: '?', cls: 'text-amber-400', label: 'need review' },
  NOT_FOUND: { icon: '✕', cls: 'text-red-400', label: 'not found' },
  DUPLICATE: { icon: '⚠', cls: 'text-yellow-400', label: 'duplicate' },
  ALREADY_MAINTAINED: { icon: '●', cls: 'text-gray-400', label: 'already maintained' },
};

export function BulkWellImportModal({
  isOpen,
  onClose,
  routes,
  existingWellNames,
  onImport,
}: BulkWellImportModalProps) {
  const [operatorOptions, setOperatorOptions] = useState<NdicOperator[]>([]);
  const [selectedOperators, setSelectedOperators] = useState<string[]>([]);
  const [defaultRoute, setDefaultRoute] = useState('Unrouted');
  const [pasteText, setPasteText] = useState('');

  const [step, setStep] = useState<'input' | 'preview'>('input');
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load operator list when the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    loadOperators().then(setOperatorOptions).catch(() => setOperatorOptions([]));
  }, [isOpen]);

  // Reset everything each time the modal closes.
  useEffect(() => {
    if (isOpen) return;
    setSelectedOperators([]);
    setDefaultRoute('Unrouted');
    setPasteText('');
    setStep('input');
    setRows([]);
    setError(null);
    setParsing(false);
    setImporting(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const addOperator = (name: string) => {
    if (!name || selectedOperators.includes(name)) return;
    setSelectedOperators(prev => [...prev, name]);
  };
  const removeOperator = (name: string) => {
    setSelectedOperators(prev => prev.filter(o => o !== name));
  };

  const handleParse = async () => {
    setError(null);
    if (selectedOperators.length === 0) {
      setError('Select at least one operator to match against.');
      return;
    }
    if (!pasteText.trim()) {
      setError('Paste a well list first.');
      return;
    }
    setParsing(true);
    try {
      const candidateArrays = await Promise.all(
        selectedOperators.map(op => loadWellsForOperator(op)),
      );
      const candidates = candidateArrays.flat();
      const { rows: parsed } = parseImportText(pasteText);
      if (parsed.length === 0) {
        setError('No well names found in the pasted text.');
        setParsing(false);
        return;
      }
      const matched = matchRows(parsed, candidates, existingWellNames, defaultRoute);
      setRows(matched);
      setStep('preview');
    } catch {
      setError('Failed to load operator wells. Try again.');
    } finally {
      setParsing(false);
    }
  };

  const counts = summarize(rows);
  const importable = rows.filter(r => r.status === 'MATCHED');

  const handleImport = async () => {
    if (!onImport) return;
    setImporting(true);
    setError(null);
    try {
      await onImport(importable);
      onClose();
    } catch {
      setError('Import failed. No changes may have been saved.');
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-800 rounded-lg border border-gray-700 w-full max-w-3xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
          <h3 className="text-lg font-semibold text-white">Bulk Import Maintained Wells</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto">
          {step === 'input' && (
            <div className="space-y-4">
              {/* Operators */}
              <div>
                <label className="text-gray-400 text-xs block mb-1">Operator(s)</label>
                <select
                  value=""
                  onChange={e => { addOperator(e.target.value); e.target.value = ''; }}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                >
                  <option value="">Add an operator…</option>
                  {operatorOptions
                    .filter(o => !selectedOperators.includes(o.name))
                    .map(o => (
                      <option key={o.name} value={o.name}>
                        {o.name}{o.state ? ` (${o.state})` : ''}
                      </option>
                    ))}
                </select>
                {selectedOperators.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {selectedOperators.map(o => (
                      <span key={o} className="inline-flex items-center gap-1 bg-gray-700 text-gray-200 text-xs px-2 py-1 rounded">
                        {o}
                        <button onClick={() => removeOperator(o)} className="text-gray-400 hover:text-white">×</button>
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-gray-500 text-xs mt-1">Pasted wells are matched against every selected operator&apos;s catalog.</p>
              </div>

              {/* Default Route */}
              <div>
                <label className="text-gray-400 text-xs block mb-1">Default Route</label>
                <select
                  value={defaultRoute}
                  onChange={e => setDefaultRoute(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                >
                  {(routes.includes('Unrouted') ? routes : ['Unrouted', ...routes]).map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <p className="text-gray-500 text-xs mt-1">Used when a row has no route. A route in the CSV is used as-is, even if new.</p>
              </div>

              {/* Paste */}
              <div>
                <label className="text-gray-400 text-xs block mb-1">Paste List (one well per line, or Well Name,Route)</label>
                <textarea
                  value={pasteText}
                  onChange={e => setPasteText(e.target.value)}
                  rows={8}
                  placeholder={'PIKE FEDERAL 1-3-2H\nCATFISH 4-5-6H,Newtown\nTHOR 2-1H'}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm font-mono"
                />
              </div>

              {error && <p className="text-red-400 text-sm">{error}</p>}
            </div>
          )}

          {step === 'preview' && (
            <div className="space-y-3">
              {/* Summary */}
              <div className="text-sm text-gray-300">
                <span className="font-semibold text-white">{rows.length} wells found</span>
                <span className="ml-3">
                  {(Object.keys(STATUS_META) as ImportStatus[]).map(s =>
                    counts[s] > 0 ? (
                      <span key={s} className={`mr-3 ${STATUS_META[s].cls}`}>
                        {STATUS_META[s].icon} {counts[s]} {STATUS_META[s].label}
                      </span>
                    ) : null,
                  )}
                </span>
              </div>

              {/* Grid */}
              <div className="border border-gray-700 rounded divide-y divide-gray-700 max-h-[45vh] overflow-y-auto">
                {rows.map((r, i) => {
                  const meta = STATUS_META[r.status];
                  return (
                    <div key={`${r.name}-${i}`} className="flex items-start gap-3 px-3 py-2 text-sm">
                      <span className={`${meta.cls} font-bold w-4 text-center`}>{meta.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-white truncate">{r.name}</div>
                        <div className="text-gray-500 text-xs truncate">{r.reason}</div>
                      </div>
                      <span className="text-gray-400 text-xs whitespace-nowrap">{r.route}</span>
                    </div>
                  );
                })}
              </div>

              {error && <p className="text-red-400 text-sm">{error}</p>}
              {!onImport && (
                <p className="text-amber-400 text-xs">Preview only — importing is enabled in the next build step.</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-700">
          <button onClick={onClose} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded text-sm">
            Cancel
          </button>
          {step === 'input' ? (
            <button
              onClick={handleParse}
              disabled={parsing}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm disabled:opacity-50"
            >
              {parsing ? 'Parsing…' : 'Parse Wells'}
            </button>
          ) : (
            <>
              <button
                onClick={() => { setStep('input'); setError(null); }}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded text-sm"
              >
                Back
              </button>
              <button
                onClick={handleImport}
                disabled={!onImport || importing || importable.length === 0}
                title={!onImport ? 'Importing is enabled in the next build step' : undefined}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm disabled:opacity-50"
              >
                {importing ? 'Importing…' : `Import ${importable.length} Wells`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
