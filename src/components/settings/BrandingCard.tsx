'use client';

import { useState, useRef } from 'react';
import {
  type CompanyConfig,
  updateCompanyFields,
  extractColorPalette,
  uploadCompanyLogo,
} from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

export function BrandingCard({ company, onSave }: Props) {
  const [showModal, setShowModal] = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [extractedPalette, setExtractedPalette] = useState<string[]>([]);
  const [manualColor, setManualColor] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const logoInputRef = useRef<HTMLInputElement>(null);

  const openEditor = () => {
    setLogoFile(null);
    setLogoPreview(company.logoUrl || null);
    setManualColor(company.primaryColor || '');
    setError('');

    if (company.logoUrl) {
      extractColorPalette(company.logoUrl)
        .then(palette => setExtractedPalette(palette))
        .catch(() => setExtractedPalette([]));
    } else {
      setExtractedPalette([]);
    }

    setShowModal(true);
  };

  const handleLogoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!['image/png', 'image/jpeg', 'image/jpg'].includes(file.type)) {
      setError('Logo must be PNG or JPG');
      return;
    }

    if (file.size > 500 * 1024) {
      setError('Logo must be under 500KB');
      return;
    }

    setError('');
    setLogoFile(file);
    const previewUrl = URL.createObjectURL(file);
    setLogoPreview(previewUrl);

    try {
      const palette = await extractColorPalette(previewUrl);
      setExtractedPalette(palette);
      setManualColor(palette[0] || manualColor);
    } catch {
      setExtractedPalette([]);
    }
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const updates: Record<string, any> = {};

      if (logoFile) {
        try {
          const logoUrl = await uploadCompanyLogo(company.id, logoFile);
          updates.logoUrl = logoUrl;
        } catch (err: any) {
          setError(`Logo upload failed: ${err.message?.slice(0, 100)}`);
        }
      }

      const color = manualColor.trim();
      if (color && /^#[0-9A-Fa-f]{6}$/.test(color)) {
        updates.primaryColor = color.toUpperCase();
      }

      if (Object.keys(updates).length > 0) {
        await updateCompanyFields(company.id, updates);
        setShowModal(false);
        onSave();
      } else if (!error) {
        setError('No changes to save');
      }
    } catch (err) {
      console.error('Failed to save branding:', err);
      setError('Failed to save branding');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-purple-500/30 bg-purple-900/20">
          <h3 className="text-purple-400 font-medium text-sm">Branding</h3>
          <button
            onClick={openEditor}
            className="px-3 py-1 text-xs rounded bg-purple-600 hover:bg-purple-500 text-white"
          >
            {company.logoUrl || company.primaryColor ? 'Edit' : '+ Set Up'}
          </button>
        </div>

        <div className="p-4">
          <div className="flex items-center gap-4 text-sm">
            {company.logoUrl ? (
              <img
                src={company.logoUrl}
                alt={`${company.name} logo`}
                className="h-10 w-auto rounded bg-white/10 p-1"
              />
            ) : (
              <span className="text-gray-500 text-xs">No logo uploaded</span>
            )}
            {company.primaryColor ? (
              <div className="flex items-center gap-2">
                <div
                  className="w-6 h-6 rounded border border-gray-500"
                  style={{ backgroundColor: company.primaryColor }}
                />
                <span className="text-gray-300 font-mono text-xs">{company.primaryColor}</span>
              </div>
            ) : (
              <span className="text-gray-500 text-xs">Default gold (#FFD700)</span>
            )}
          </div>
        </div>
      </div>

      {/* Branding Editor Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-1">Company Branding</h3>
            <p className="text-gray-400 text-xs mb-4">
              Upload a logo and set your accent color. Drivers will see this on their tickets and invoices.
            </p>

            {error && (
              <div className="p-2 mb-3 bg-red-900/50 text-red-300 text-xs rounded">{error}</div>
            )}

            {/* Logo Upload */}
            <div className="mb-4">
              <label className="text-gray-400 text-sm block mb-2">Company Logo</label>
              <div className="flex items-center gap-4">
                {logoPreview ? (
                  <div className="relative">
                    <img
                      src={logoPreview}
                      alt="Logo preview"
                      className="h-16 w-auto rounded bg-white/10 p-1"
                    />
                    <button
                      onClick={() => { setLogoFile(null); setLogoPreview(null); setExtractedPalette([]); }}
                      className="absolute -top-1 -right-1 bg-red-600 text-white rounded-full w-4 h-4 text-xs flex items-center justify-center"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div className="h-16 w-16 rounded border-2 border-dashed border-gray-600 flex items-center justify-center">
                    <span className="text-gray-500 text-2xl">+</span>
                  </div>
                )}
                <div>
                  <button
                    onClick={() => logoInputRef.current?.click()}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded"
                  >
                    {logoPreview ? 'Change Logo' : 'Upload Logo'}
                  </button>
                  <p className="text-gray-500 text-xs mt-1">PNG or JPG, max 500KB</p>
                </div>
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={handleLogoSelect}
                  className="hidden"
                />
              </div>
            </div>

            {/* Color Section */}
            <div className="mb-4">
              <label className="text-gray-400 text-sm block mb-2">Accent Color</label>

              {extractedPalette.length > 0 && (
                <div className="mb-3">
                  <div className="text-gray-500 text-xs mb-1.5">Colors from your logo — click to select:</div>
                  <div className="flex gap-2">
                    {extractedPalette.map((color, i) => (
                      <button
                        key={i}
                        onClick={() => setManualColor(color)}
                        className="relative group"
                        title={color}
                      >
                        <div
                          className="w-10 h-10 rounded-lg border-2 transition-all"
                          style={{
                            backgroundColor: color,
                            borderColor: manualColor === color ? '#FFFFFF' : 'transparent',
                            boxShadow: manualColor === color ? '0 0 0 2px rgba(255,255,255,0.3)' : 'none',
                          }}
                        />
                        {manualColor === color && (
                          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-white rounded-full" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={manualColor || '#FFD700'}
                  onChange={e => setManualColor(e.target.value.toUpperCase())}
                  className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
                  title="Custom color picker"
                />
                <input
                  type="text"
                  value={manualColor}
                  onChange={e => setManualColor(e.target.value.toUpperCase())}
                  placeholder="#FFD700"
                  maxLength={7}
                  className="px-3 py-2 bg-gray-700 text-white rounded text-sm font-mono w-28"
                />
                <span className="text-gray-500 text-xs">or pick custom</span>
              </div>
            </div>

            {/* Preview Strip */}
            {manualColor && /^#[0-9A-Fa-f]{6}$/.test(manualColor) && (
              <div
                className="mb-4 p-3 rounded-lg border"
                style={{ borderColor: manualColor, backgroundColor: '#1a1a0a' }}
              >
                <div className="flex items-center gap-2 justify-center mb-1">
                  <span style={{ color: manualColor }} className="text-sm font-bold tracking-widest">EN ROUTE</span>
                </div>
                <div className="text-white text-center text-sm font-semibold">Sample Well Name</div>
                <div className="flex justify-center mt-2">
                  <div
                    className="px-6 py-2 rounded-lg text-sm font-bold text-black"
                    style={{ backgroundColor: manualColor }}
                  >
                    Arrived
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={save}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Branding'}
              </button>
              <button
                onClick={() => setShowModal(false)}
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
