'use client';

import { useState } from 'react';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

export function PhotosCard({ company, onSave }: Props) {
  const [saving, setSaving] = useState<string | null>(null);
  const [minCount, setMinCount] = useState(String(company.minPhotoCount || 1));
  const [retentionDays, setRetentionDays] = useState(String(company.photoRetentionDays || 30));

  const toggleRequire = async () => {
    setSaving('requirePhotos');
    try {
      await updateCompanyFields(company.id, { requirePhotos: !company.requirePhotos });
      onSave();
    } catch (err) {
      console.error('Failed to toggle requirePhotos:', err);
    } finally {
      setSaving(null);
    }
  };

  const saveMinCount = async () => {
    const val = parseInt(minCount, 10);
    if (isNaN(val) || val < 1) return;
    setSaving('minPhotoCount');
    try {
      await updateCompanyFields(company.id, { minPhotoCount: val });
      onSave();
    } catch (err) {
      console.error('Failed to save minPhotoCount:', err);
    } finally {
      setSaving(null);
    }
  };

  const saveRetention = async () => {
    const val = parseInt(retentionDays, 10);
    if (isNaN(val) || val < 1) return;
    setSaving('photoRetentionDays');
    try {
      await updateCompanyFields(company.id, { photoRetentionDays: val });
      onSave();
    } catch (err) {
      console.error('Failed to save photoRetentionDays:', err);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-orange-500/30 bg-orange-900/20">
        <h3 className="text-orange-400 font-medium text-sm">Photo Capture</h3>
      </div>

      <div className="p-4 space-y-3">
        {/* Require Photos toggle */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white text-sm">Require Photos</div>
            <div className="text-gray-500 text-xs">Drivers must take CYA photos before closing a job</div>
          </div>
          <button
            onClick={toggleRequire}
            disabled={saving === 'requirePhotos'}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              company.requirePhotos ? 'bg-orange-500' : 'bg-gray-600'
            } ${saving === 'requirePhotos' ? 'opacity-50' : ''}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              company.requirePhotos ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
        </div>

        {/* Min photo count */}
        {company.requirePhotos ? (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-white text-sm">Minimum Photos</div>
              <div className="text-gray-500 text-xs">Required before job can be closed</div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                max="10"
                value={minCount}
                onChange={(e) => setMinCount(e.target.value)}
                onBlur={saveMinCount}
                className="w-16 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm text-center"
              />
            </div>
          </div>
        ) : null}

        {/* Retention days */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white text-sm">Photo Retention</div>
            <div className="text-gray-500 text-xs">Auto-delete photos after this many days</div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="7"
              max="365"
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              onBlur={saveRetention}
              className="w-16 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm text-center"
            />
            <span className="text-gray-500 text-xs">days</span>
          </div>
        </div>
      </div>
    </div>
  );
}
