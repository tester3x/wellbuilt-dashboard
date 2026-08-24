'use client';

import { useMemo, useState } from 'react';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';
import {
  SPILL_RECIPIENT_ROLES,
  bumpPolicyVersion,
  parseSpillPolicy,
  validateSpillPolicy,
  type SpillNotifyChannelPref,
  type SpillRecipient,
} from '@/lib/spill/spillNotifyPolicy';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
  canEdit: boolean;
  actorUid: string;
}

export function SpillNotificationCard({ company, onSave, canEdit, actorUid }: Props) {
  const initial = useMemo(() => parseSpillPolicy(company.spillReporting?.notifyPolicy), [company.id]);
  const [policy, setPolicy] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [extName, setExtName] = useState('');
  const [extPhone, setExtPhone] = useState('');
  const [extEmail, setExtEmail] = useState('');
  const [extChan, setExtChan] = useState<SpillNotifyChannelPref>('email');
  const [empId, setEmpId] = useState('');

  const validation = validateSpillPolicy(policy);

  const setRecipients = (recipients: SpillRecipient[]) => setPolicy((p) => ({ ...p, recipients }));

  const toggleRole = (role: string) => {
    const exists = policy.recipients.some((r) => r.kind === 'role' && r.role === role);
    if (exists) setRecipients(policy.recipients.filter((r) => !(r.kind === 'role' && r.role === role)));
    else setRecipients([...policy.recipients, { kind: 'role', role, channels: 'both', active: true }]);
  };

  const save = async () => {
    if (!canEdit) return;
    const checked = validateSpillPolicy(policy);
    if (!checked.ok) { setMsg(checked.errors.join('; ')); return; }
    setSaving(true);
    setMsg('');
    try {
      const next = bumpPolicyVersion(policy, new Date().toISOString(), actorUid);
      await updateCompanyFields(company.id, { 'spillReporting.notifyPolicy': next });
      setPolicy(next);
      setMsg('Saved policy version ' + next.version);
      onSave();
    } catch (e: any) {
      setMsg(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <h3 className="text-white font-medium mb-1">Spill Notification Policy</h3>
      <p className="text-gray-500 text-xs mb-4">
        Recipients are company-configured. No default people or job titles. SMS/email are not sent until the notification worker and providers are deployed.
      </p>

      <label className="flex items-center gap-2 text-gray-300 text-sm mb-4">
        <input
          type="checkbox"
          checked={policy.enabled}
          disabled={!canEdit}
          onChange={(e) => setPolicy((p) => ({ ...p, enabled: e.target.checked }))}
        />
        Policy enabled
      </label>

      <div className="mb-4">
        <div className="text-gray-400 text-xs uppercase mb-2">Recipient roles</div>
        <div className="flex flex-wrap gap-2">
          {SPILL_RECIPIENT_ROLES.map((role) => {
            const on = policy.recipients.some((r) => r.kind === 'role' && r.role === role);
            return (
              <button
                key={role}
                type="button"
                disabled={!canEdit}
                onClick={() => toggleRole(role)}
                className={`px-2 py-1 rounded text-xs capitalize ${on ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
              >
                {role}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mb-4">
        <div className="text-gray-400 text-xs uppercase mb-2">Specific employees</div>
        <div className="flex gap-2 mb-2">
          <input
            value={empId}
            disabled={!canEdit}
            onChange={(e) => setEmpId(e.target.value)}
            placeholder="Employee ID"
            className="px-2 py-1 bg-gray-700 text-white rounded text-sm flex-1"
          />
          <button
            type="button"
            disabled={!canEdit || !empId.trim()}
            onClick={() => {
              setRecipients([...policy.recipients, { kind: 'employee', employeeId: empId.trim(), channels: 'both', active: true }]);
              setEmpId('');
            }}
            className="px-2 py-1 bg-gray-600 text-white rounded text-sm"
          >
            Add
          </button>
        </div>
        <ul className="text-gray-300 text-xs space-y-1">
          {policy.recipients.filter((r) => r.kind === 'employee').map((r) => (
            <li key={r.employeeId} className="flex justify-between">
              <span>{r.employeeId} · {r.channels}</span>
              {canEdit && (
                <button type="button" className="text-red-400" onClick={() => setRecipients(policy.recipients.filter((x) => x !== r))}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="mb-4">
        <div className="text-gray-400 text-xs uppercase mb-2">External contacts</div>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <input value={extName} disabled={!canEdit} onChange={(e) => setExtName(e.target.value)} placeholder="Name" className="px-2 py-1 bg-gray-700 text-white rounded text-sm" />
          <select value={extChan} disabled={!canEdit} onChange={(e) => setExtChan(e.target.value as SpillNotifyChannelPref)} className="px-2 py-1 bg-gray-700 text-white rounded text-sm">
            <option value="sms">SMS</option>
            <option value="email">Email</option>
            <option value="both">SMS + email</option>
          </select>
          <input value={extPhone} disabled={!canEdit} onChange={(e) => setExtPhone(e.target.value)} placeholder="Phone" className="px-2 py-1 bg-gray-700 text-white rounded text-sm" />
          <input value={extEmail} disabled={!canEdit} onChange={(e) => setExtEmail(e.target.value)} placeholder="Email" className="px-2 py-1 bg-gray-700 text-white rounded text-sm" />
        </div>
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => {
            const id = 'ext-' + Math.random().toString(36).slice(2, 8);
            setRecipients([...policy.recipients, {
              kind: 'external', externalId: id, name: extName || null, phone: extPhone || null, email: extEmail || null, channels: extChan, active: true,
            }]);
            setExtName(''); setExtPhone(''); setExtEmail('');
          }}
          className="px-2 py-1 bg-gray-600 text-white rounded text-sm"
        >
          Add external contact
        </button>
        <ul className="text-gray-300 text-xs space-y-1 mt-2">
          {policy.recipients.filter((r) => r.kind === 'external').map((r) => (
            <li key={r.externalId} className="flex justify-between">
              <span>{r.name || r.externalId} · {r.channels}</span>
              {canEdit && (
                <button type="button" className="text-red-400" onClick={() => setRecipients(policy.recipients.filter((x) => x !== r))}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <label className="flex items-center gap-2 text-gray-300 text-sm mb-2">
        <input
          type="checkbox"
          checked={!!policy.externalAccessEnabled}
          disabled={!canEdit}
          onChange={(e) => setPolicy((p) => ({ ...p, externalAccessEnabled: e.target.checked }))}
        />
        Allow external incident links
      </label>
      {policy.externalAccessEnabled && (
        <label className="block text-gray-400 text-xs mb-4">
          Expiration (hours)
          <input
            type="number"
            min={1}
            max={168}
            disabled={!canEdit}
            value={policy.externalAccessExpiresHours ?? 24}
            onChange={(e) => setPolicy((p) => ({ ...p, externalAccessExpiresHours: Number(e.target.value) }))}
            className="ml-2 px-2 py-1 bg-gray-700 text-white rounded w-20"
          />
        </label>
      )}

      <p className="text-gray-500 text-xs mb-3">Policy version: {policy.version}</p>
      {!validation.ok && <p className="text-red-400 text-xs mb-2">{validation.errors.join('; ')}</p>}
      {msg && <p className="text-gray-300 text-xs mb-2">{msg}</p>}
      {canEdit && (
        <button
          type="button"
          disabled={saving || !validation.ok}
          onClick={() => void save()}
          className="px-3 py-1.5 bg-blue-600 disabled:bg-gray-600 text-white rounded text-sm"
        >
          {saving ? 'Saving…' : 'Save policy'}
        </button>
      )}
    </div>
  );
}
