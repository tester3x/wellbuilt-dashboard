'use client';

import { useState } from 'react';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';

const DEFAULT_TEMPLATE = '{well}\n{top}\n{bottom}          {time}';
const TEMPLATE_FIELDS = ['{well}', '{top}', '{bottom}', '{time}', '{bbls}'];

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

export function LevelReportsCard({ company, onSave }: Props) {
  const [saving, setSaving] = useState<string | null>(null);
  const [template, setTemplate] = useState(company.levelReportTemplate || DEFAULT_TEMPLATE);

  const toggleSendLevel = async () => {
    setSaving('toggle');
    try {
      const updates: Record<string, any> = { sendLevelToDispatch: !company.sendLevelToDispatch };
      // Set default template when enabling for the first time
      if (!company.sendLevelToDispatch && !company.levelReportTemplate) {
        updates.levelReportTemplate = DEFAULT_TEMPLATE;
        setTemplate(DEFAULT_TEMPLATE);
      }
      await updateCompanyFields(company.id, updates);
      onSave();
    } catch (err) {
      console.error('Failed to toggle sendLevelToDispatch:', err);
    } finally {
      setSaving(null);
    }
  };

  const saveTemplate = async () => {
    if (!template.trim()) return;
    setSaving('template');
    try {
      await updateCompanyFields(company.id, { levelReportTemplate: template });
      onSave();
    } catch (err) {
      console.error('Failed to save levelReportTemplate:', err);
    } finally {
      setSaving(null);
    }
  };

  const insertField = (field: string) => {
    setTemplate(prev => prev + field);
  };

  // Preview with sample data
  const previewText = template
    .replace(/\{well\}/g, 'GABRIEL 4-36-25H')
    .replace(/\{top\}/g, "12'11\"")
    .replace(/\{bottom\}/g, "6'11\"")
    .replace(/\{time\}/g, '9:56 AM')
    .replace(/\{bbls\}/g, '120');

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-cyan-500/30 bg-cyan-900/20">
        <h3 className="text-cyan-400 font-medium text-sm">Level Reports</h3>
      </div>

      <div className="p-4 space-y-4">
        {/* Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white text-sm">Send Levels to Dispatch</div>
            <div className="text-gray-500 text-xs">Auto-send well levels via in-app chat on each load</div>
          </div>
          <button
            onClick={toggleSendLevel}
            disabled={saving === 'toggle'}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              company.sendLevelToDispatch ? 'bg-cyan-500' : 'bg-gray-600'
            } ${saving === 'toggle' ? 'opacity-50' : ''}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              company.sendLevelToDispatch ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
        </div>

        {/* Template editor — only when enabled */}
        {company.sendLevelToDispatch && (
          <>
            <div>
              <div className="text-white text-sm mb-1">Message Template</div>
              <div className="text-gray-500 text-xs mb-2">
                All drivers send levels in this format. Consistent for dispatch.
              </div>
              <textarea
                value={template}
                onChange={e => setTemplate(e.target.value)}
                onBlur={saveTemplate}
                rows={4}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded text-white text-sm font-mono resize-none focus:border-cyan-500 focus:outline-none"
                placeholder={DEFAULT_TEMPLATE}
              />

              {/* Field buttons */}
              <div className="flex flex-wrap gap-2 mt-2">
                {TEMPLATE_FIELDS.map(field => (
                  <button
                    key={field}
                    onClick={() => insertField(field)}
                    className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-cyan-300 text-xs rounded border border-gray-600 transition-colors"
                  >
                    {field}
                  </button>
                ))}
              </div>
            </div>

            {/* Preview */}
            <div>
              <div className="text-gray-500 text-xs mb-1">Preview</div>
              <div className="px-3 py-2 bg-gray-900 rounded border border-gray-700 text-gray-300 text-sm font-mono whitespace-pre-wrap">
                {previewText}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
