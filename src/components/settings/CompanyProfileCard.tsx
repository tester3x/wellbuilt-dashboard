'use client';

import { useState } from 'react';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

export function CompanyProfileCard({ company, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(company.name || '');
  const [address, setAddress] = useState(company.address || '');
  const [city, setCity] = useState(company.city || '');
  const [state, setState] = useState(company.state || 'ND');
  const [zip, setZip] = useState(company.zip || '');
  const [phone, setPhone] = useState(company.phone || '');

  const startEdit = () => {
    setName(company.name || '');
    setAddress(company.address || '');
    setCity(company.city || '');
    setState(company.state || 'ND');
    setZip(company.zip || '');
    setPhone(company.phone || '');
    setEditing(true);
  };

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await updateCompanyFields(company.id, {
        name: name.trim(),
        address: address.trim() || null,
        city: city.trim() || null,
        state: state.trim() || null,
        zip: zip.trim() || null,
        phone: phone.trim() || null,
      });
      setEditing(false);
      onSave();
    } catch (err) {
      console.error('Failed to save profile:', err);
    } finally {
      setSaving(false);
    }
  };

  const formatPhone = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 10);
    if (digits.length <= 3) return digits.length ? `(${digits}` : '';
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  };

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-blue-500/30 bg-blue-900/20">
        <h3 className="text-blue-400 font-medium text-sm">Company Profile</h3>
        {!editing && (
          <button
            onClick={startEdit}
            className="px-3 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white"
          >
            Edit
          </button>
        )}
      </div>

      <div className="p-4">
        {editing ? (
          <div className="space-y-3">
            <div>
              <label className="text-gray-400 text-xs block mb-1">Company Name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                autoFocus
              />
            </div>
            <div>
              <label className="text-gray-400 text-xs block mb-1">Address</label>
              <input
                type="text"
                value={address}
                onChange={e => setAddress(e.target.value)}
                placeholder="Street address"
                className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-gray-400 text-xs block mb-1">City</label>
                <input
                  type="text"
                  value={city}
                  onChange={e => setCity(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                />
              </div>
              <div>
                <label className="text-gray-400 text-xs block mb-1">State</label>
                <input
                  type="text"
                  value={state}
                  onChange={e => setState(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                  maxLength={2}
                />
              </div>
              <div>
                <label className="text-gray-400 text-xs block mb-1">ZIP</label>
                <input
                  type="text"
                  value={zip}
                  onChange={e => setZip(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                />
              </div>
            </div>
            <div>
              <label className="text-gray-400 text-xs block mb-1">Phone</label>
              <input
                type="text"
                value={phone}
                onChange={e => setPhone(formatPhone(e.target.value))}
                placeholder="(xxx) xxx-xxxx"
                className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={save}
                disabled={saving || !name.trim()}
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
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-gray-400">Name:</span>
              <span className="text-white ml-2">{company.name || '—'}</span>
            </div>
            <div>
              <span className="text-gray-400">Address:</span>
              <span className="text-white ml-2">{company.address || '—'}</span>
            </div>
            <div>
              <span className="text-gray-400">City/State/ZIP:</span>
              <span className="text-white ml-2">
                {[company.city, company.state, company.zip].filter(Boolean).join(', ') || '—'}
              </span>
            </div>
            <div>
              <span className="text-gray-400">Phone:</span>
              <span className="text-white ml-2">{company.phone || '—'}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
