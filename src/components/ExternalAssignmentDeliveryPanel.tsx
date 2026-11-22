'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listExternalDeliveries,
  listExternalDrivers,
  saveExternalDriver,
  writeExternalDelivery,
  type ExternalDelivery,
  type ExternalDeliveryChannel,
  type ExternalDriver,
} from '@/lib/externalAssignmentDelivery';

export type ExternalDispatchOption = {
  id: string;
  wellName: string;
  driverName?: string;
  status: string;
};

function requestKey(prefix: string): string {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${id}`;
}

function rosterId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'driver';
  return `${base}-${requestKey('r').split(':')[1].slice(0, 8)}`;
}

export function ExternalAssignmentDeliveryPanel({
  jobs,
  canManage,
  rosterOnly = false,
  onRosterChange,
}: {
  jobs: ExternalDispatchOption[];
  canManage: boolean;
  rosterOnly?: boolean;
  onRosterChange?: () => Promise<void>;
}) {
  const [drivers, setDrivers] = useState<ExternalDriver[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [deliveries, setDeliveries] = useState<ExternalDelivery[]>([]);
  const [dispatchId, setDispatchId] = useState('');
  const [externalDriverId, setExternalDriverId] = useState('');
  const [channel, setChannel] = useState<ExternalDeliveryChannel>('sms');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [newChannels, setNewChannels] = useState<ExternalDeliveryChannel[]>(['sms']);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reassignTargets, setReassignTargets] = useState<Record<string, string>>({});

  const activeDrivers = useMemo(() => drivers.filter(driver => driver.active), [drivers]);
  const availableChannels = useMemo(
    () => activeDrivers.find(driver => driver.externalDriverId === externalDriverId)?.channels || [],
    [activeDrivers, externalDriverId],
  );

  const refresh = useCallback(async () => {
    if (!canManage) return;
    const [nextDrivers, nextDeliveries] = await Promise.all([
      listExternalDrivers(),
      rosterOnly ? Promise.resolve([]) : listExternalDeliveries(),
    ]);
    setDrivers(nextDrivers);
    setDeliveries(nextDeliveries);
    setExternalDriverId(current => current || nextDrivers.find(driver => driver.active)?.externalDriverId || '');
  }, [canManage, rosterOnly]);

  useEffect(() => {
    refresh().catch(error => setMessage(`External delivery unavailable: ${error instanceof Error ? error.message : String(error)}`));
  }, [refresh]);

  useEffect(() => {
    if (availableChannels.length && !availableChannels.includes(channel)) setChannel(availableChannels[0]);
  }, [availableChannels, channel]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage('');
    try {
      await action();
      await refresh();
      await onRosterChange?.();
      setMessage(success);
    } catch (error) {
      setMessage(`External delivery error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) return null;

  return (
    <section className="mb-4 rounded-lg border border-amber-600/40 bg-gray-800 p-4" aria-labelledby="external-delivery-heading">
      <button type="button" aria-expanded={expanded} aria-controls="external-drivers-details"
        onClick={() => setExpanded(value => !value)}
        className="w-full flex items-center justify-between gap-3 text-left">
        <span>
          <span id="external-delivery-heading" className="block font-semibold text-amber-300">Drivers Without WellBuilt Accounts ({drivers.length})</span>
          <span className="text-xs text-gray-400">Outside / temporary drivers · expand to manage assignments</span>
        </span>
        <span aria-hidden="true" className="text-amber-300">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && <div id="external-drivers-details" className="mt-3">
      <p className="mb-2 text-xs text-amber-200">{rosterOnly ? 'Save outside-driver contacts here, then assign them on the job below. No SMS or WhatsApp messages are sent.' : 'Messaging provider not configured — no SMS or WhatsApp messages are sent.'}</p>

      {message && <div className="mt-3 rounded bg-gray-900 px-3 py-2 text-sm text-gray-200">{message}</div>}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <form className="rounded border border-gray-700 p-3" onSubmit={event => {
          event.preventDefault();
          const driver = {
            externalDriverId: rosterId(name),
            displayName: name.trim(),
            phoneE164: phone.trim(),
            channels: phone.trim() ? newChannels : [],
            active: true,
          };
          void run(async () => {
            const saved = await saveExternalDriver(driver);
            setName('');
            setPhone('');
            setExternalDriverId(saved.externalDriverId);
          }, 'External driver saved to this company roster.');
        }}>
          <h3 className="text-sm font-medium text-white">Company roster</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input required value={name} onChange={event => setName(event.target.value)} maxLength={120}
              placeholder="Driver name" className="rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white" />
            <input value={phone} onChange={event => setPhone(event.target.value)}
              aria-label="Driver phone (optional)" placeholder="Phone (optional) · +17015550123" inputMode="tel" className="rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white" />
          </div>
          <div className="mt-2 flex items-center gap-4 text-sm text-gray-300">
            {(['sms', 'whatsapp'] as const).map(option => (
              <label key={option} className="flex items-center gap-1.5">
                <input type="checkbox" disabled={!phone.trim()} checked={!!phone.trim() && newChannels.includes(option)} onChange={event => {
                  setNewChannels(current => event.target.checked
                    ? [...new Set([...current, option])]
                    : current.filter(value => value !== option));
                }} />
                {option === 'sms' ? 'SMS' : 'WhatsApp'}
              </label>
            ))}
            <button disabled={busy || (!!phone.trim() && !newChannels.length)} className="ml-auto rounded bg-amber-700 px-3 py-1.5 font-medium text-white disabled:opacity-50">
              Add driver
            </button>
          </div>
          {drivers.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-gray-400">
              {drivers.map(driver => <li key={driver.externalDriverId}>{driver.displayName} · {driver.phoneE164 || 'No phone on file'}{driver.channels.length ? ` · ${driver.channels.join('/')}` : ''}{driver.active ? '' : ' · inactive'}</li>)}
            </ul>
          )}
        </form>

        {!rosterOnly && <form className="rounded border border-gray-700 p-3" onSubmit={event => {
          event.preventDefault();
          void run(async () => {
            await writeExternalDelivery({
              op: 'queue',
              dispatchId,
              externalDriverId,
              channel,
              idempotencyKey: requestKey('assign'),
            });
          }, 'Provider unconfigured — assignment recorded as failed/not sent.');
        }}>
          <h3 className="text-sm font-medium text-white">Deliver an existing assignment</h3>
          <select required value={dispatchId} onChange={event => setDispatchId(event.target.value)}
            className="mt-2 w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white">
            <option value="">Choose active job…</option>
            {jobs.map(job => <option key={job.id} value={job.id}>{job.wellName} · {job.status}{job.driverName ? ` · ${job.driverName}` : ''}</option>)}
          </select>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <select required value={externalDriverId} onChange={event => setExternalDriverId(event.target.value)}
              className="rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white">
              <option value="">Choose external driver…</option>
              {activeDrivers.map(driver => <option key={driver.externalDriverId} value={driver.externalDriverId}>{driver.displayName}</option>)}
            </select>
            <select value={channel} onChange={event => setChannel(event.target.value as ExternalDeliveryChannel)}
              className="rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white">
              {availableChannels.map(value => <option key={value} value={value}>{value === 'sms' ? 'SMS' : 'WhatsApp'}</option>)}
            </select>
          </div>
          <button disabled={busy || !dispatchId || !externalDriverId || !availableChannels.length}
            className="mt-2 w-full rounded bg-blue-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
            Record delivery attempt (not sent)
          </button>
        </form>}
      </div>

      {deliveries.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-gray-400"><tr><th className="pb-2">Job</th><th className="pb-2">External driver</th><th className="pb-2">Channel</th><th className="pb-2">Truthful status</th><th className="pb-2">Revision</th><th className="pb-2">Actions</th></tr></thead>
            <tbody className="divide-y divide-gray-700">
              {deliveries.map(delivery => (
                <tr key={delivery.deliveryId}>
                  <td className="py-2 text-gray-200">{jobs.find(job => job.id === delivery.dispatchId)?.wellName || delivery.dispatchId}</td>
                  <td className="py-2 text-gray-200">{drivers.find(driver => driver.externalDriverId === delivery.externalDriverId)?.displayName || delivery.externalDriverId}</td>
                  <td className="py-2 uppercase text-gray-300">{delivery.channel}</td>
                  <td className="py-2 text-gray-200">{delivery.assignmentState === 'cancelled' ? 'cancelled · ' : ''}{delivery.currentStatus}{delivery.failureCode === 'provider_unconfigured' ? ' · not sent' : ''}</td>
                  <td className="py-2 text-gray-300">{delivery.currentRevision}</td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      {delivery.currentStatus === 'failed' && delivery.assignmentState === 'active' && (
                        <button disabled={busy} onClick={() => void run(() => writeExternalDelivery({
                          op: 'retry', deliveryId: delivery.deliveryId, dispatchId: delivery.dispatchId,
                          externalDriverId: delivery.externalDriverId, channel: delivery.channel, idempotencyKey: requestKey('retry'),
                        }), 'Retry recorded; provider remains unconfigured/not sent.')}
                          className="rounded bg-gray-700 px-2 py-1 text-gray-100 disabled:opacity-50">Retry</button>
                      )}
                      {delivery.assignmentState === 'active' && <>
                        <select value={reassignTargets[delivery.deliveryId] || ''} onChange={event => setReassignTargets(current => ({ ...current, [delivery.deliveryId]: event.target.value }))}
                          className="rounded border border-gray-600 bg-gray-900 px-1 py-1 text-gray-200">
                          <option value="">Reassign…</option>
                          {activeDrivers.filter(driver => driver.channels.length > 0 && driver.externalDriverId !== delivery.externalDriverId).map(driver => <option key={driver.externalDriverId} value={driver.externalDriverId}>{driver.displayName}</option>)}
                        </select>
                        <button disabled={busy || !reassignTargets[delivery.deliveryId]} onClick={() => {
                          const target = activeDrivers.find(driver => driver.externalDriverId === reassignTargets[delivery.deliveryId]);
                          if (!target) return;
                          void run(() => writeExternalDelivery({
                            op: 'reassign', deliveryId: delivery.deliveryId, dispatchId: delivery.dispatchId,
                            externalDriverId: target.externalDriverId, channel: target.channels[0], idempotencyKey: requestKey('reassign'),
                          }), 'Reassignment revision recorded; provider unconfigured/not sent.');
                        }} className="rounded bg-blue-900 px-2 py-1 text-blue-100 disabled:opacity-50">Apply</button>
                        <button disabled={busy} onClick={() => void run(() => writeExternalDelivery({
                          op: 'cancel', deliveryId: delivery.deliveryId, idempotencyKey: requestKey('cancel'),
                        }), 'External assignment cancelled. No message was sent.')}
                          className="rounded bg-red-950 px-2 py-1 text-red-200 disabled:opacity-50">Cancel</button>
                      </>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </div>}
    </section>
  );
}
