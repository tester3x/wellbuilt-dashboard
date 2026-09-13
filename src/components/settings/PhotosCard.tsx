'use client';

import { useState } from 'react';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';
import { buildRequirePhotos, buildMinPhotoCount, buildPhotoRetentionDays, parsePositivePhotoInt } from '@/lib/companySettingsCore';
import { RequiredPhotoSpecs } from './RequiredPhotoSpecs';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
  /** Whether the current user may edit company photo settings (manageCompany). */
  canEdit: boolean;
}

export function PhotosCard({ company, onSave, canEdit }: Props) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minCount, setMinCount] = useState(String(company.minPhotoCount || 1));
  const [retentionDays, setRetentionDays] = useState(String(company.photoRetentionDays || 30));

  const toggleRequire = async () => {
    if (!canEdit) return;
    setSaving('requirePhotos');
    setError(null);
    try {
      await updateCompanyFields(company.id, buildRequirePhotos(company.requirePhotos || false));
      onSave();
    } catch (err) {
      console.error('Failed to toggle requirePhotos:', err);
      setError('Could not save that change — it was not applied. Please try again.');
    } finally {
      setSaving(null);
    }
  };

  const saveMinCount = async () => {
    if (!canEdit) return;
    const val = parsePositivePhotoInt(minCount);
    if (val === null) return;
    setSaving('minPhotoCount');
    setError(null);
    try {
      await updateCompanyFields(company.id, buildMinPhotoCount(val));
      onSave();
    } catch (err) {
      console.error('Failed to save minPhotoCount:', err);
      setError('Could not save the minimum photo count — it was not applied. Please try again.');
    } finally {
      setSaving(null);
    }
  };

  const saveRetention = async () => {
    if (!canEdit) return;
    const val = parsePositivePhotoInt(retentionDays);
    if (val === null) return;
    setSaving('photoRetentionDays');
    setError(null);
    try {
      await updateCompanyFields(company.id, buildPhotoRetentionDays(val));
      onSave();
    } catch (err) {
      console.error('Failed to save photoRetentionDays:', err);
      setError('Could not save the retention setting — it was not applied. Please try again.');
    } finally {
      setSaving(null);
    }
  };

  const locked = !canEdit;

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-orange-500/30 bg-orange-900/20">
        <h3 className="text-orange-400 font-medium text-sm">Photo Capture</h3>
      </div>

      {locked && (
        <div className="px-4 pt-3 text-gray-400 text-xs">View-only — you do not have permission to change photo settings.</div>
      )}
      {error && (
        <div className="px-4 pt-3 text-red-400 text-xs" role="alert">{error}</div>
      )}

      <div className="p-4 space-y-3">
        {/* Require Photos toggle */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-white text-sm">Require Photos</div>
            <div className="text-gray-500 text-xs">Drivers must take CYA photos before closing a job</div>
          </div>
          <button
            onClick={toggleRequire}
            disabled={locked || saving === 'requirePhotos'}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              company.requirePhotos ? 'bg-orange-500' : 'bg-gray-600'
            } ${saving === 'requirePhotos' ? 'opacity-50' : ''} ${locked ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                disabled={locked || saving === 'minPhotoCount'}
                onChange={(e) => setMinCount(e.target.value)}
                onBlur={saveMinCount}
                className="w-16 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm text-center disabled:opacity-50"
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
              disabled={locked || saving === 'photoRetentionDays'}
              onChange={(e) => setRetentionDays(e.target.value)}
              onBlur={saveRetention}
              className="w-16 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm text-center disabled:opacity-50"
            />
            <span className="text-gray-500 text-xs">days</span>
          </div>
        </div>

        {/* Required Photo Specs — AI-checked per-customer required photos */}
        <RequiredPhotoSpecs company={company} />
      </div>
    </div>
  );
}
