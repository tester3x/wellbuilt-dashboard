'use client';

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  type CompanyConfig,
  type TicketTemplate,
  type FieldSize,
  DEFAULT_TICKET_TEMPLATE,
  DEFAULT_GROUP_ORDER,
  DEFAULT_FIELD_SIZES,
  TEMPLATE_FIELD_GROUPS,
  updateCompanyFields,
} from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

// Groups that have separate "legal" sub-fields with their own size control
const LEGAL_SUBGROUPS: Record<string, string[]> = {
  pickup: ['pickupApiNo', 'pickupGps', 'pickupLegalDesc', 'pickupCounty'],
  dropoff: ['dropoffApiNo', 'dropoffGps', 'dropoffCounty', 'dropoffLegalDesc'],
};

const LEGAL_PRIMARY: Record<string, string[]> = {
  pickup: ['pickupCompany', 'pickupLocation'],
  dropoff: ['dropoffLocation'],
};

// ── Preview HTML builder ─────────────────────────────────────────────────────

function buildPreviewHtml(T: TicketTemplate): string {
  const sizes = { ...DEFAULT_FIELD_SIZES, ...(T.fieldSizes || {}) };
  const order = T.groupOrder || DEFAULT_GROUP_ORDER;

  const sizeCSS = (groupId: string) => {
    const s = sizes[groupId] || 'normal';
    if (s === 'small') return 'font-size:10px;color:#333;';
    if (s === 'tiny') return 'font-size:8px;color:#555;';
    return '';
  };

  const rowStyle = (groupId: string) => {
    const s = sizes[groupId] || 'normal';
    if (s === 'small') return ' style="font-size:10px;color:#333;"';
    if (s === 'tiny') return ' style="font-size:8px;color:#555;"';
    return '';
  };

  const sectionBuilders: Record<string, () => string> = {
    header: () => {
      let h = '';
      if (T.companyLogo) h += '<div class="logo-row"><div style="width:60px;height:40px;background:#ddd;display:inline-flex;align-items:center;justify-content:center;font-size:8px;color:#666;border-radius:4px;">LOGO</div></div>';
      if (T.companyName) h += '<div class="company-name">SAMPLE TRUCKING LLC</div>';
      if (T.companyAddress) h += '<div class="addr-row">P.O. Box 4447 · Williston, ND 58801 · (701) 555-0123</div>';
      if (T.companyLogo || T.companyName || T.companyAddress) h += '<div class="company-divider"></div>';
      return h;
    },

    identity: () => `
      <div class="ticket-title">WATER TICKET</div>
      <div class="ticket-meta">
        ${T.ticketNumber ? '<span># 11305</span>' : '<span></span>'}
        <span>${T.ticketDate ? '03/03/2026' : ''}${T.timeGauged ? '  12:17 PM' : ''}</span>
      </div>`,

    pickup: () => {
      let h = '<div class="section-hdr">PICKUP</div>';
      if (T.tlPickupArrival) h += '<div class="row"><span class="row-label">Arrival</span><span class="row-value">12:42 PM</span></div>';
      const ps = rowStyle('pickup');
      if (T.pickupCompany) h += `<div class="row"${ps}><span class="row-label">Company</span><span class="row-value">Slawson Exploration</span></div>`;
      if (T.pickupLocation) h += `<div class="row"${ps}><span class="row-label">Location</span><span class="row-value">ATLAS 1-16-21H</span></div>`;
      const ls = rowStyle('pickup_legal');
      if (T.pickupApiNo) h += `<div class="row"${ls}><span class="row-label">API #</span><span class="row-value">33-105-03422</span></div>`;
      if (T.pickupGps) h += `<div class="row"${ls}><span class="row-label">GPS</span><span class="row-value">48.1234, -103.5678</span></div>`;
      if (T.pickupLegalDesc) h += `<div class="row"${ls}><span class="row-label">Legal</span><span class="row-value">NWSW 16-152N-99W</span></div>`;
      if (T.pickupCounty) h += `<div class="row"${ls}><span class="row-label">County</span><span class="row-value">Williams</span></div>`;
      // Pulled-volume row sits inside Pickup section (matches the receipt).
      // Sample shows mirrored 130/130 for non-split; for s_t split chains
      // ticket A would render 130/0 here.
      if (T.quantity) h += '<div class="row"><span class="row-label">BBLs</span><span class="row-value">130</span></div>';
      if (T.tlLoadedDeparture) h += '<div class="row"><span class="row-label">Loaded / Departure</span><span class="row-value">1:21 PM</span></div>';
      return h;
    },

    dropoff: () => {
      let h = '<div class="section-hdr">DROP-OFF</div>';
      if (T.tlDropoffArrival) h += '<div class="row"><span class="row-label">Arrival</span><span class="row-value">1:55 PM</span></div>';
      const ps = rowStyle('dropoff');
      if (T.dropoffLocation) h += `<div class="row"${ps}><span class="row-label">Location</span><span class="row-value">HYDRO CLEAR SWD</span></div>`;
      const ls = rowStyle('dropoff_legal');
      if (T.dropoffApiNo) h += `<div class="row"${ls}><span class="row-label">API #</span><span class="row-value">33-053-05201</span></div>`;
      if (T.dropoffGps) h += `<div class="row"${ls}><span class="row-label">GPS</span><span class="row-value">47.9501, -103.3366</span></div>`;
      if (T.dropoffCounty) h += `<div class="row"${ls}><span class="row-label">County</span><span class="row-value">McKenzie</span></div>`;
      if (T.dropoffLegalDesc) h += `<div class="row"${ls}><span class="row-label">Legal</span><span class="row-value">NENE 30-151N-99W</span></div>`;
      // Delivered-volume row sits inside Drop-off section (matches receipt).
      if (T.quantity) h += '<div class="row"><span class="row-label">BBLs</span><span class="row-value">130</span></div>';
      if (T.tlUnloadedStop) h += '<div class="row"><span class="row-label">Unloaded / Stop</span><span class="row-value">2:18 PM</span></div>';
      return h;
    },

    invoice: () => T.invoiceNumber ? '<div class="row"><span class="row-label">Invoice #</span><span class="row-value">LG-1042</span></div>' : '',

    measurements: () => {
      let h = '<div class="section-divider"></div>';
      if (T.jobType) h += '<div class="row"><span class="row-label">Type</span><span class="row-value">PW</span></div>';
      // BBLs row moved out of Measurements — pulled-volume now in Pickup,
      // delivered-volume in Drop-off. T.quantity gates BOTH from there.
      if (T.tankTop) h += '<div class="row"><span class="row-label">Tank Top</span><span class="row-value">10\' 4"</span></div>';
      if (T.tankBottom) h += '<div class="row"><span class="row-label">Tank Bottom</span><span class="row-value">3\' 8"</span></div>';
      return h;
    },

    notes: () => T.notes ? '<div class="notes-section"><div class="notes-label">NOTES</div>Frac tank fill — load 2 of 3</div>' : '',

    time: () => {
      let h = '<div class="section-divider"></div>';
      if (T.startTime) h += '<div class="row"><span class="row-label">Start</span><span class="row-value">12:17</span></div>';
      if (T.stopTime) h += '<div class="row"><span class="row-label">Stop</span><span class="row-value">14:18</span></div>';
      if (T.hours) h += '<div class="row"><span class="row-label">Hours</span><span class="row-value">2.0</span></div>';
      return h;
    },

    timeline: () => {
      // Start time already shown in time section (Start/Stop/Hours) — no longer duplicated here
      return '';
    },

    driver: () => {
      let h = '<div class="section-divider"></div>';
      const ds = rowStyle('driver');
      if (T.driverName) h += `<div class="row"${ds}><span class="row-label">Driver</span><span class="row-value">John Smith</span></div>`;
      if (T.truckNumber) h += `<div class="row"${ds}><span class="row-label">Truck #</span><span class="row-value">LG-134</span></div>`;
      if (T.trailerNumber) h += `<div class="row"${ds}><span class="row-label">Trailer #</span><span class="row-value">T-22</span></div>`;
      return h;
    },

    signatures: () => {
      if (!T.driverSignature && !T.receiverSignature) return '';
      return `<div class="footer">
        ${T.driverSignature ? '<div class="sig-block"><div class="sig-line-blank">Driver Signature</div></div>' : ''}
        ${T.receiverSignature ? '<div class="sig-block"><div class="sig-line-blank">Receiver Signature</div></div>' : ''}
      </div>`;
    },
  };

  const bodyHtml = order
    .map(id => sectionBuilders[id]?.() || '')
    .join('\n');

  return `<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; width: 384px; padding: 16px 12px; font-size: 14px; color: #000; }
    .logo-row { text-align: center; margin-bottom: 4px; }
    .logo-row img { width: 60px; height: auto; }
    .addr-row { text-align: center; font-size: 11px; line-height: 1.3; margin-bottom: 4px; }
    .company-name { font-family: 'Arial Black', Arial, sans-serif; font-size: 18px; font-weight: 900; text-align: center; line-height: 1.2; margin-bottom: 8px; }
    .company-divider { border-bottom: 2px solid #000; margin-bottom: 8px; }
    .ticket-title { font-size: 22px; font-weight: bold; text-align: center; margin: 8px 0; letter-spacing: 3px; }
    .ticket-meta { display: flex; justify-content: space-between; border-bottom: 2px dashed #000; padding-bottom: 6px; margin-bottom: 8px; font-weight: bold; font-size: 16px; }
    .row { display: flex; justify-content: space-between; border-bottom: 1px dotted #666; padding: 4px 0; }
    .row-label { font-weight: bold; font-size: 13px; min-width: 90px; }
    .row-value { text-align: right; font-size: 14px; flex: 1; }
    .section-hdr { font-size: 12px; font-weight: 900; text-align: center; padding: 4px 0 2px; margin-top: 6px; border-top: 1px solid #000; letter-spacing: 1px; }
    .section-divider { border-top: 1px solid #999; margin: 6px 0 4px 0; }
    .notes-section { border: 1px solid #666; padding: 6px 8px; margin: 8px 0; min-height: 24px; font-size: 13px; }
    .notes-label { font-size: 9px; font-weight: bold; color: #444; }
    .footer { border-top: 2px solid #000; margin-top: 14px; padding-top: 6px; display: flex; justify-content: space-between; align-items: flex-end; }
    .sig-block { width: 48%; text-align: center; }
    .sig-line-blank { border-top: 1px solid #000; margin-top: 32px; padding-top: 3px; font-size: 10px; text-align: center; }
  </style>
</head>
<body>
  ${bodyHtml}
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

const GROUP_BORDER_COLORS: Record<string, string> = {
  yellow: 'border-l-yellow-500',
  green: 'border-l-green-500',
  blue: 'border-l-blue-500',
  purple: 'border-l-purple-500',
  orange: 'border-l-orange-500',
  gray: 'border-l-gray-500',
  cyan: 'border-l-cyan-500',
  indigo: 'border-l-indigo-500',
  red: 'border-l-red-500',
};

// ── Size picker component ────────────────────────────────────────────────────

function SizePicker({ value, onChange, label }: { value: FieldSize; onChange: (s: FieldSize) => void; label?: string }) {
  const opts: { key: FieldSize; lbl: string }[] = [
    { key: 'normal', lbl: 'N' },
    { key: 'small', lbl: 'S' },
    { key: 'tiny', lbl: 'T' },
  ];
  return (
    <div className="flex items-center gap-1">
      {label && <span className="text-[10px] text-gray-500 mr-0.5">{label}</span>}
      <div className="flex gap-0.5">
        {opts.map(o => (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              value === o.key
                ? 'bg-purple-600 text-white'
                : 'bg-gray-600 text-gray-400 hover:text-white'
            }`}
            title={o.key === 'normal' ? 'Normal' : o.key === 'small' ? 'Small' : 'Tiny'}
          >
            {o.lbl}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Auto-scaling preview pane ────────────────────────────────────────────────

function PreviewPane({ previewHtml }: { previewHtml: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  const updateScale = useCallback(() => {
    if (containerRef.current) {
      const containerWidth = containerRef.current.clientWidth;
      setScale(containerWidth / 384); // 384px = receipt paper width
    }
  }, []);

  useEffect(() => {
    updateScale();
    const ro = new ResizeObserver(updateScale);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [updateScale]);

  return (
    <div ref={containerRef} className="flex-1 bg-white rounded overflow-y-auto overflow-x-hidden relative">
      <iframe
        srcDoc={previewHtml}
        className="border-0"
        style={{
          width: '384px',
          height: '1200px',
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
        title="Ticket preview"
      />
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function TicketTemplateCard({ company, onSave }: Props) {
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [template, setTemplate] = useState<TicketTemplate>({ ...DEFAULT_TICKET_TEMPLATE });
  const [fieldSizes, setFieldSizes] = useState<Record<string, FieldSize>>({ ...DEFAULT_FIELD_SIZES });
  const [groupOrder, setGroupOrder] = useState<string[]>([...DEFAULT_GROUP_ORDER]);
  const [reorderMode, setReorderMode] = useState(false);
  const [saving, setSaving] = useState(false);

  const operators = company.assignedOperators || [];

  const openEditor = (target: string) => {
    const existing = company.ticketTemplates?.[target];
    setTemplate(existing ? { ...existing } : { ...DEFAULT_TICKET_TEMPLATE });
    setFieldSizes(existing?.fieldSizes ? { ...DEFAULT_FIELD_SIZES, ...(existing.fieldSizes as Record<string, FieldSize>) } : { ...DEFAULT_FIELD_SIZES });
    setGroupOrder(existing?.groupOrder ? [...existing.groupOrder] : [...DEFAULT_GROUP_ORDER]);
    setReorderMode(false);
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
        if (!f.required) (next as any)[f.key] = value;
      });
      return next;
    });
  };

  const setGroupSize = (groupId: string, size: FieldSize) => {
    setFieldSizes(prev => ({ ...prev, [groupId]: size }));
  };

  const moveGroup = (index: number, dir: -1 | 1) => {
    const newIdx = index + dir;
    if (newIdx < 0 || newIdx >= groupOrder.length) return;
    setGroupOrder(prev => {
      const next = [...prev];
      [next[index], next[newIdx]] = [next[newIdx], next[index]];
      return next;
    });
  };

  const copyFromDefault = () => {
    const def = company.ticketTemplates?.['_default'];
    if (def) {
      setTemplate({ ...def });
      setFieldSizes(def.fieldSizes ? { ...DEFAULT_FIELD_SIZES, ...(def.fieldSizes as Record<string, FieldSize>) } : { ...DEFAULT_FIELD_SIZES });
      setGroupOrder(def.groupOrder ? [...def.groupOrder] : [...DEFAULT_GROUP_ORDER]);
    }
  };

  const save = async () => {
    if (!editTarget) return;
    setSaving(true);
    try {
      const updated = { ...(company.ticketTemplates || {}) };
      updated[editTarget] = { ...template, fieldSizes, groupOrder };
      await updateCompanyFields(company.id, { ticketTemplates: updated });
      setEditTarget(null);
      onSave();
    } catch (err) {
      console.error('Failed to save ticket template:', err);
    } finally {
      setSaving(false);
    }
  };

  // Build template with layout for preview
  const templateWithLayout = useMemo(
    () => ({ ...template, fieldSizes, groupOrder }),
    [template, fieldSizes, groupOrder]
  );

  const openPrintTest = () => {
    const html = buildPreviewHtml(templateWithLayout);
    const win = window.open('', '_blank');
    if (win) { win.document.write(html); win.document.close(); }
  };

  const previewHtml = useMemo(() => buildPreviewHtml(templateWithLayout), [templateWithLayout]);

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

  // Count only fields that appear in the UI (exclude legacy fields like timelineStamps)
  const uiFieldKeys = new Set(TEMPLATE_FIELD_GROUPS.flatMap(g => g.fields.map(f => f.key)));
  const enabledCount = Object.entries(template).filter(([k, v]) => typeof v === 'boolean' && v && uiFieldKeys.has(k as any)).length;
  const totalBooleans = uiFieldKeys.size;

  // Ordered groups for both checkbox grid and reorder view
  const orderedGroups = useMemo(() => {
    return groupOrder
      .map(id => TEMPLATE_FIELD_GROUPS.find(g => g.id === id))
      .filter(Boolean) as typeof TEMPLATE_FIELD_GROUPS;
  }, [groupOrder]);

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
              <div key={op} className="flex items-center justify-between px-3 py-2 bg-gray-700/30 rounded text-sm">
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
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setReorderMode(!reorderMode)}
                  className={`px-2 py-0.5 text-xs rounded ${
                    reorderMode
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-700 text-gray-400 hover:text-white'
                  }`}
                >
                  {reorderMode ? 'Done Reordering' : 'Edit Order'}
                </button>
                <span className="text-gray-500 text-xs">{enabledCount}/{totalBooleans} fields</span>
              </div>
            </div>
            <p className="text-gray-400 text-xs mb-4">
              {editTarget === '_default'
                ? `${company.name} — Company Default`
                : `${company.name} → ${editTarget}`}
            </p>

            <div className="flex gap-6 flex-1 min-h-0 overflow-hidden">
              {/* Left: Checkbox Grid or Reorder List */}
              <div className="flex-[3] overflow-y-auto pr-2 space-y-3">
                {reorderMode ? (
                  /* ── Reorder Mode ── */
                  <>
                    <p className="text-gray-500 text-xs mb-2">Drag sections up or down to change print order:</p>
                    {orderedGroups.map((group, idx) => (
                      <div
                        key={group.id}
                        className={`flex items-center gap-2 px-3 py-2 bg-gray-700/30 rounded border-l-2 ${GROUP_BORDER_COLORS[group.color] || 'border-l-gray-500'}`}
                      >
                        <span className="text-sm text-gray-300 flex-1">{group.label}</span>
                        <button
                          onClick={() => moveGroup(idx, -1)}
                          disabled={idx === 0}
                          className="text-gray-400 hover:text-white disabled:text-gray-700 px-1"
                          title="Move up"
                        >
                          ▲
                        </button>
                        <button
                          onClick={() => moveGroup(idx, 1)}
                          disabled={idx === orderedGroups.length - 1}
                          className="text-gray-400 hover:text-white disabled:text-gray-700 px-1"
                          title="Move down"
                        >
                          ▼
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => setGroupOrder([...DEFAULT_GROUP_ORDER])}
                      className="text-xs text-gray-500 hover:text-gray-300 mt-2"
                    >
                      Reset to default order
                    </button>
                  </>
                ) : (
                  /* ── Checkbox Grid ── */
                  orderedGroups.map(group => {
                    const allChecked = group.fields.every(f => (template as any)[f.key]);
                    const noneChecked = group.fields.every(f => f.required || !(template as any)[f.key]);
                    const hasLegal = LEGAL_SUBGROUPS[group.id];
                    const legalKey = `${group.id}_legal`;

                    return (
                      <div key={group.id} className="rounded overflow-hidden">
                        <div className={`px-3 py-1.5 border-l-2 flex items-center justify-between ${GROUP_COLORS[group.color] || GROUP_COLORS.gray}`}>
                          <span className="text-xs font-medium">{group.label}</span>
                          <div className="flex items-center gap-2">
                            {/* Size picker(s) */}
                            {hasLegal ? (
                              <>
                                <SizePicker
                                  value={fieldSizes[group.id] || 'normal'}
                                  onChange={s => setGroupSize(group.id, s)}
                                  label="Primary"
                                />
                                <SizePicker
                                  value={fieldSizes[legalKey] || 'small'}
                                  onChange={s => setGroupSize(legalKey, s)}
                                  label="Legal"
                                />
                              </>
                            ) : (
                              <SizePicker
                                value={fieldSizes[group.id] || 'normal'}
                                onChange={s => setGroupSize(group.id, s)}
                              />
                            )}
                            <div className="flex gap-1 ml-1">
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
                        </div>
                        <div className="bg-gray-700/20 px-3 py-2 space-y-1">
                          {group.fields.map(field => (
                            <label key={field.key} className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={(template as any)[field.key]}
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
                  })
                )}
              </div>

              {/* Right: Live Preview */}
              <div className="flex-[2] flex flex-col min-w-0">
                <p className="text-gray-500 text-xs mb-2">Live Preview</p>
                <PreviewPane previewHtml={previewHtml} />
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
                <button onClick={copyFromDefault} className="px-3 py-2 text-xs rounded bg-gray-700 hover:bg-gray-600 text-gray-300">
                  Copy from Default
                </button>
              )}
              <button
                onClick={() => {
                  setTemplate({ ...DEFAULT_TICKET_TEMPLATE });
                  setFieldSizes({ ...DEFAULT_FIELD_SIZES });
                  setGroupOrder([...DEFAULT_GROUP_ORDER]);
                }}
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
