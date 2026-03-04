'use client';

import { useState, useMemo } from 'react';
import {
  type CompanyConfig,
  type TicketTemplate,
  DEFAULT_TICKET_TEMPLATE,
  TEMPLATE_FIELD_GROUPS,
  updateCompanyFields,
} from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

// ── Preview HTML builder ─────────────────────────────────────────────────────

function buildPreviewHtml(T: TicketTemplate): string {
  // Mirrors WB T's buildReceiptHtml() structure with sample data
  return `<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; width: 384px; padding: 16px 12px; font-size: 14px; color: #000; }
    .header-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
    .header-top img { width: 60px; height: auto; }
    .addr-block { text-align: right; font-size: 11px; line-height: 1.4; }
    .company-name { font-family: 'Arial Black', Arial, sans-serif; font-size: 18px; font-weight: 900; text-align: center; line-height: 1.2; margin-bottom: 8px; }
    .company-divider { border-bottom: 2px solid #000; margin-bottom: 8px; }
    .ticket-title { font-size: 22px; font-weight: bold; text-align: center; margin: 8px 0; letter-spacing: 3px; }
    .ticket-meta { display: flex; justify-content: space-between; border-bottom: 2px dashed #000; padding-bottom: 6px; margin-bottom: 8px; font-weight: bold; font-size: 16px; }
    .row { display: flex; justify-content: space-between; border-bottom: 1px dotted #666; padding: 4px 0; }
    .row-label { font-weight: bold; font-size: 13px; min-width: 90px; }
    .row-value { text-align: right; font-size: 14px; flex: 1; }
    .split-section { display: flex; gap: 6px; margin: 8px 0; }
    .split-box { flex: 1; border: 2px solid #000; padding: 4px 6px; text-align: center; }
    .split-label { font-size: 9px; font-weight: bold; color: #444; }
    .split-value { font-size: 16px; font-weight: bold; }
    .notes-section { border: 1px solid #666; padding: 6px 8px; margin: 8px 0; min-height: 24px; font-size: 13px; }
    .notes-label { font-size: 9px; font-weight: bold; color: #444; }
    .footer { border-top: 2px solid #000; margin-top: 14px; padding-top: 6px; display: flex; justify-content: space-between; align-items: flex-end; }
    .sig-block { width: 48%; text-align: center; }
    .sig-line-blank { border-top: 1px solid #000; margin-top: 32px; padding-top: 3px; font-size: 10px; text-align: center; }
  </style>
</head>
<body>
  ${T.companyLogo || T.companyAddress ? `<div class="header-top">
    ${T.companyLogo ? '<div style="width:60px;height:40px;background:#ddd;display:flex;align-items:center;justify-content:center;font-size:8px;color:#666;border-radius:4px;">LOGO</div>' : ''}
    ${T.companyAddress ? '<div class="addr-block">P.O. Box 4447<br/>Williston, ND 58801<br/>(701) 555-0123</div>' : ''}
  </div>` : ''}

  ${T.companyName ? '<div class="company-name">SAMPLE TRUCKING LLC</div><div class="company-divider"></div>' : ''}

  <div class="ticket-title">WATER TICKET</div>

  <div class="ticket-meta">
    ${T.ticketNumber ? '<span># 11305</span>' : '<span></span>'}
    <span>${T.ticketDate ? '03/03/2026' : ''}${T.timeGauged ? '  1:21 PM' : ''}</span>
  </div>

  ${T.pickupCompany ? '<div class="row"><span class="row-label">Company</span><span class="row-value">Slawson Exploration</span></div>' : ''}
  ${T.pickupLocation ? '<div class="row"><span class="row-label">Pickup Location</span><span class="row-value">ATLAS 1-16-21H</span></div>' : ''}
  ${T.pickupApiNo ? '<div class="row"><span class="row-label">API #</span><span class="row-value">33-105-03422</span></div>' : ''}
  ${T.pickupGps ? '<div class="row"><span class="row-label">GPS</span><span class="row-value">48.1234, -103.5678</span></div>' : ''}
  ${T.pickupLegalDesc ? '<div class="row"><span class="row-label">Legal</span><span class="row-value">NWSW 16-152N-99W</span></div>' : ''}
  ${T.pickupCounty ? '<div class="row"><span class="row-label">County</span><span class="row-value">Williams</span></div>' : ''}
  ${T.dropoffLocation ? '<div class="row"><span class="row-label">Drop-off Location</span><span class="row-value">HYDRO CLEAR SWD</span></div>' : ''}
  ${T.dropoffApiNo ? '<div class="row"><span class="row-label">Drop-off API #</span><span class="row-value">33-053-05201</span></div>' : ''}
  ${T.dropoffGps ? '<div class="row"><span class="row-label">Drop-off GPS</span><span class="row-value">47.9501, -103.3366</span></div>' : ''}
  ${T.dropoffCounty ? '<div class="row"><span class="row-label">Drop-off County</span><span class="row-value">McKenzie</span></div>' : ''}
  ${T.dropoffLegalDesc ? '<div class="row"><span class="row-label">Drop-off Legal</span><span class="row-value">NENE 30-151N-99W</span></div>' : ''}
  ${T.invoiceNumber ? '<div class="row"><span class="row-label">Invoice #</span><span class="row-value">LG-1042</span></div>' : ''}

  ${T.jobType || T.quantity || T.tankTop || T.tankBottom ? `<div class="split-section">
    ${T.jobType ? '<div class="split-box"><div class="split-label">TYPE</div><div class="split-value">PW</div></div>' : ''}
    ${T.quantity ? '<div class="split-box"><div class="split-label">QTY</div><div class="split-value">130</div></div>' : ''}
    ${T.tankTop ? '<div class="split-box"><div class="split-label">TOP</div><div class="split-value">10\' 4"</div></div>' : ''}
    ${T.tankBottom ? '<div class="split-box"><div class="split-label">BOTTOM</div><div class="split-value">3\' 8"</div></div>' : ''}
  </div>` : ''}

  ${T.notes ? '<div class="notes-section"><div class="notes-label">NOTES</div>Frac tank fill — load 2 of 3</div>' : ''}

  ${T.startTime || T.stopTime || T.hours ? `<div class="split-section">
    ${T.startTime ? '<div class="split-box"><div class="split-label">START</div><div class="split-value">12:17</div></div>' : ''}
    ${T.stopTime ? '<div class="split-box"><div class="split-label">STOP</div><div class="split-value">14:18</div></div>' : ''}
    ${T.hours ? '<div class="split-box"><div class="split-label">HOURS</div><div class="split-value">2.0</div></div>' : ''}
  </div>` : ''}

  ${T.driverName ? '<div class="row"><span class="row-label">Driver</span><span class="row-value">John Smith</span></div>' : ''}
  ${T.truckNumber ? '<div class="row"><span class="row-label">Truck #</span><span class="row-value">LG-134</span></div>' : ''}
  ${T.trailerNumber ? '<div class="row"><span class="row-label">Trailer #</span><span class="row-value">T-22</span></div>' : ''}

  ${T.driverSignature || T.receiverSignature ? `<div class="footer">
    ${T.driverSignature ? '<div class="sig-block"><div class="sig-line-blank">Driver Signature</div></div>' : ''}
    ${T.receiverSignature ? '<div class="sig-block"><div class="sig-line-blank">Receiver Signature</div></div>' : ''}
  </div>` : ''}
</body>
</html>`;
}

// ── Color map for group headers ──────────────────────────────────────────────

const GROUP_COLORS: Record<string, string> = {
  yellow: 'border-yellow-500/40 bg-yellow-900/20 text-yellow-400',
  green: 'border-green-500/40 bg-green-900/20 text-green-400',
  blue: 'border-blue-500/40 bg-blue-900/20 text-blue-400',
  purple: 'border-purple-500/40 bg-purple-900/20 text-purple-400',
  orange: 'border-orange-500/40 bg-orange-900/20 text-orange-400',
  gray: 'border-gray-500/40 bg-gray-700/20 text-gray-400',
  cyan: 'border-cyan-500/40 bg-cyan-900/20 text-cyan-400',
  indigo: 'border-indigo-500/40 bg-indigo-900/20 text-indigo-400',
  red: 'border-red-500/40 bg-red-900/20 text-red-400',
};

// ── Component ────────────────────────────────────────────────────────────────

export function TicketTemplateCard({ company, onSave }: Props) {
  const [editTarget, setEditTarget] = useState<string | null>(null); // operator name or '_default'
  const [template, setTemplate] = useState<TicketTemplate>({ ...DEFAULT_TICKET_TEMPLATE });
  const [saving, setSaving] = useState(false);

  const operators = company.assignedOperators || [];

  const openEditor = (target: string) => {
    const existing = company.ticketTemplates?.[target];
    setTemplate(existing ? { ...existing } : { ...DEFAULT_TICKET_TEMPLATE });
    setEditTarget(target);
  };

  const toggleField = (key: keyof TicketTemplate) => {
    setTemplate(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleGroup = (groupId: string, value: boolean) => {
    const group = TEMPLATE_FIELD_GROUPS.find(g => g.id === groupId);
    if (!group) return;
    setTemplate(prev => {
      const next = { ...prev };
      group.fields.forEach(f => {
        if (!f.required) next[f.key] = value;
      });
      return next;
    });
  };

  const copyFromDefault = () => {
    const def = company.ticketTemplates?.['_default'];
    if (def) setTemplate({ ...def });
  };

  const save = async () => {
    if (!editTarget) return;
    setSaving(true);
    try {
      const updated = { ...(company.ticketTemplates || {}) };
      updated[editTarget] = template;
      await updateCompanyFields(company.id, { ticketTemplates: updated });
      setEditTarget(null);
      onSave();
    } catch (err) {
      console.error('Failed to save ticket template:', err);
    } finally {
      setSaving(false);
    }
  };

  const openPrintTest = () => {
    const html = buildPreviewHtml(template);
    const win = window.open('', '_blank');
    if (win) {
      win.document.write(html);
      win.document.close();
    }
  };

  // Live preview HTML
  const previewHtml = useMemo(() => buildPreviewHtml(template), [template]);

  const getTemplateStatus = (opName: string) => {
    if (company.ticketTemplates?.[opName]) return 'custom';
    if (company.ticketTemplates?.['_default']) return 'default';
    return 'none';
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case 'custom': return <span className="text-green-400 text-xs">Custom template</span>;
      case 'default': return <span className="text-blue-400 text-xs">Using default</span>;
      default: return <span className="text-gray-500 text-xs">All fields (no template)</span>;
    }
  };

  // Count enabled fields
  const enabledCount = Object.values(template).filter(Boolean).length;
  const totalCount = Object.keys(template).length;

  return (
    <>
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-purple-500/30 bg-purple-900/20 flex items-center justify-between">
          <h3 className="text-purple-400 font-medium text-sm">Ticket Template</h3>
          <button
            onClick={() => openEditor('_default')}
            className="px-2 py-0.5 text-xs rounded bg-purple-700 hover:bg-purple-600 text-white"
          >
            {company.ticketTemplates?.['_default'] ? 'Edit Default' : '+ Set Default'}
          </button>
        </div>

        <div className="p-4 space-y-1">
          {operators.length === 0 && (
            <p className="text-gray-500 text-xs">No operators assigned. Add oil companies first.</p>
          )}
          {operators.map(op => {
            const status = getTemplateStatus(op);
            return (
              <div
                key={op}
                className="flex items-center justify-between px-3 py-2 bg-gray-700/30 rounded text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-gray-300 truncate">{op}</span>
                  {statusLabel(status)}
                </div>
                <button
                  onClick={() => openEditor(op)}
                  className="px-2 py-0.5 text-xs rounded bg-purple-700 hover:bg-purple-600 text-white shrink-0 ml-2"
                >
                  {status === 'custom' ? 'Edit' : '+ Configure'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Editor Modal */}
      {editTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-5xl w-full mx-4 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-white font-medium">Ticket Template</h3>
              <span className="text-gray-500 text-xs">{enabledCount}/{totalCount} fields</span>
            </div>
            <p className="text-gray-400 text-xs mb-4">
              {editTarget === '_default'
                ? `${company.name} — Company Default`
                : `${company.name} → ${editTarget}`}
            </p>

            <div className="flex gap-6 flex-1 min-h-0 overflow-hidden">
              {/* Left: Checkbox Grid */}
              <div className="flex-[3] overflow-y-auto pr-2 space-y-3">
                {TEMPLATE_FIELD_GROUPS.map(group => {
                  const allChecked = group.fields.every(f => template[f.key]);
                  const noneChecked = group.fields.every(f => f.required || !template[f.key]);
                  return (
                    <div key={group.id} className="rounded overflow-hidden">
                      <div className={`px-3 py-1.5 border-l-2 flex items-center justify-between ${GROUP_COLORS[group.color] || GROUP_COLORS.gray}`}>
                        <span className="text-xs font-medium">{group.label}</span>
                        <div className="flex gap-1">
                          <button
                            onClick={() => toggleGroup(group.id, true)}
                            className={`text-xs px-1.5 py-0.5 rounded ${allChecked ? 'text-gray-600' : 'text-gray-400 hover:text-white'}`}
                            disabled={allChecked}
                          >All</button>
                          <button
                            onClick={() => toggleGroup(group.id, false)}
                            className={`text-xs px-1.5 py-0.5 rounded ${noneChecked ? 'text-gray-600' : 'text-gray-400 hover:text-white'}`}
                            disabled={noneChecked}
                          >None</button>
                        </div>
                      </div>
                      <div className="bg-gray-700/20 px-3 py-2 space-y-1">
                        {group.fields.map(field => (
                          <label key={field.key} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={template[field.key]}
                              onChange={() => !field.required && toggleField(field.key)}
                              disabled={field.required}
                              className="rounded bg-gray-600 border-gray-500 text-purple-500 focus:ring-purple-500 focus:ring-offset-0 disabled:opacity-50"
                            />
                            <span className={`text-sm ${field.required ? 'text-gray-400' : 'text-gray-300'}`}>
                              {field.label}
                              {field.required && <span className="text-gray-600 text-xs ml-1">(required)</span>}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Right: Live Preview */}
              <div className="flex-[2] flex flex-col min-w-0">
                <p className="text-gray-500 text-xs mb-2">Live Preview</p>
                <div className="flex-1 bg-white rounded overflow-hidden relative">
                  <iframe
                    srcDoc={previewHtml}
                    className="absolute top-0 left-0 border-0"
                    style={{
                      width: '384px',
                      height: '720px',
                      transform: 'scale(0.48)',
                      transformOrigin: 'top left',
                    }}
                    title="Ticket preview"
                  />
                </div>
                <button
                  onClick={openPrintTest}
                  className="mt-2 px-3 py-1.5 text-xs rounded bg-gray-600 hover:bg-gray-500 text-white"
                >
                  Print Test
                </button>
              </div>
            </div>

            {/* Footer Actions */}
            <div className="flex gap-2 mt-4 pt-4 border-t border-gray-700">
              {editTarget !== '_default' && company.ticketTemplates?.['_default'] && (
                <button
                  onClick={copyFromDefault}
                  className="px-3 py-2 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
                >
                  Copy from Default
                </button>
              )}
              <button
                onClick={() => setTemplate({ ...DEFAULT_TICKET_TEMPLATE })}
                className="px-3 py-2 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
              >
                Reset All
              </button>
              <div className="flex-1" />
              <button
                onClick={save}
                disabled={saving}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Template'}
              </button>
              <button
                onClick={() => setEditTarget(null)}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
