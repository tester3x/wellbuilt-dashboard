'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '@/lib/firebase';
import { FRESH_WATER_ACCOUNTS, freshWaterAccount, type FreshWaterAccount } from '@/lib/freshWater';

const statusLabels = {
  awaiting_bill: 'Awaiting depot bill',
  ready_to_rebill: 'Ready to bill back',
  billed_back: 'Billed back',
  not_reimbursable: 'Company expense',
  customer_billed: 'Depot bills customer',
} as const;

type Status = keyof typeof statusLabels;
type Purchase = {
  id: string;
  receipt: string;
  account: FreshWaterAccount;
  amountCents: number | null;
  status: Status;
  invoiceRef: string;
  revision: number;
};

export function FreshWaterPurchases({ ticketId, canEdit }: { ticketId: string; canEdit: boolean }) {
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [plannedAccount, setPlannedAccount] = useState<FreshWaterAccount>();
  const [customerDefault, setCustomerDefault] = useState<FreshWaterAccount>();
  const [editing, setEditing] = useState<Purchase>();
  const [receipt, setReceipt] = useState('');
  const [account, setAccount] = useState<FreshWaterAccount | ''>('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<Status>('awaiting_bill');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = httpsCallable<{ op: 'list'; ticketId: string }, {
      purchases: Purchase[]; plannedAccount: unknown; customerDefault: unknown;
    }>(
      getFirebaseFunctions(), 'staffFreshWaterPurchases',
    );
    load({ op: 'list', ticketId }).then(({ data }) => {
      if (cancelled) return;
      const planned = freshWaterAccount(data.plannedAccount);
      const customerAccount = freshWaterAccount(data.customerDefault);
      setPurchases(data.purchases);
      setPlannedAccount(planned);
      setCustomerDefault(customerAccount);
      setAccount(previous => previous || planned || customerAccount || '');
    }).catch(() => {
      if (!cancelled) setError('Could not load depot receipts.');
    });
    return () => { cancelled = true; };
  }, [ticketId, loadAttempt]);

  function edit(purchase?: Purchase) {
    setEditing(purchase);
    setReceipt(purchase?.receipt ?? '');
    setAccount(purchase?.account ?? plannedAccount ?? customerDefault ?? '');
    setAmount(purchase?.amountCents == null ? '' : (purchase.amountCents / 100).toFixed(2));
    setStatus(purchase?.status === 'customer_billed' ? 'awaiting_bill' : purchase?.status ?? 'awaiting_bill');
    setInvoiceRef(purchase?.invoiceRef ?? '');
    setError('');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canEdit || !account || saving) return;
    const dollars = amount.trim();
    if (account === 'company' && dollars && !/^\d+(?:\.\d{1,2})?$/.test(dollars)) {
      setError('Enter the depot charge in dollars and cents.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const submit = httpsCallable<unknown, { purchase: Purchase }>(getFirebaseFunctions(), 'staffFreshWaterPurchases');
      const { data: { purchase } } = await submit({
        op: 'save',
        ticketId,
        ...(editing ? { id: editing.id } : {}),
        receipt,
        account,
        amountCents: account === 'company' && dollars ? Math.round(Number(dollars) * 100) : null,
        status: account === 'customer' ? 'customer_billed' : status,
        invoiceRef: account === 'company' && status === 'billed_back' ? invoiceRef : '',
        revision: editing?.revision ?? 0,
      });
      setPurchases(current => [...(current ?? []).filter(row => row.id !== purchase.id), purchase]);
      edit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the depot receipt.');
    } finally {
      setSaving(false);
    }
  }

  const field = 'mt-1 block w-full rounded border border-gray-600 bg-gray-900 p-2 text-white';
  return (
    <section className="my-3 space-y-3 rounded-lg bg-gray-800 p-4 text-sm text-gray-200">
      <h3 className="font-semibold text-white">Fresh Water purchases</h3>
      {plannedAccount && (
        <p>Account on the assignment · {FRESH_WATER_ACCOUNTS.find(option => option.value === plannedAccount)?.label}</p>
      )}
      {customerDefault && (
        <p>Current customer default · {FRESH_WATER_ACCOUNTS.find(option => option.value === customerDefault)?.label}</p>
      )}
      {!purchases && !error && <p>Loading depot receipts…</p>}
      {error && <p role="alert" className="text-red-300">{error}</p>}
      {error && (
        <button type="button" className="text-blue-300 underline" disabled={saving} onClick={() => {
          edit();
          setLoadAttempt(attempt => attempt + 1);
        }}>Reload receipts</button>
      )}
      {purchases?.length === 0 && <p>No depot receipts recorded.</p>}
      {purchases?.map(purchase => (
        <div key={purchase.id} className="flex items-start justify-between gap-3 rounded bg-gray-900 p-2">
          <div>
            <div className="font-medium">{purchase.receipt}</div>
            <div className="text-gray-400">
              {statusLabels[purchase.status]}
              {purchase.amountCents == null ? '' : ' · $' + (purchase.amountCents / 100).toFixed(2)}
              {purchase.invoiceRef ? ' · Invoice ' + purchase.invoiceRef : ''}
            </div>
          </div>
          {canEdit && <button type="button" className="text-blue-300" disabled={saving} onClick={() => edit(purchase)}>Edit</button>}
        </div>
      ))}
      {purchases && canEdit && (
        <form onSubmit={save} className="space-y-3 border-t border-gray-600 pt-3">
          <fieldset disabled={saving} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label>Depot receipt number
              <input className={field} value={receipt} onChange={e => setReceipt(e.target.value)}
                required maxLength={120} readOnly={!!editing} />
            </label>
            <label>Account the depot billed
              <select className={field} value={account} required onChange={e => setAccount(freshWaterAccount(e.target.value) ?? '')}>
                <option value="">Choose account</option>
                {FRESH_WATER_ACCOUNTS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            {account === 'company' && <>
              <label>Depot charge ($)
                <input className={field} value={amount} onChange={e => setAmount(e.target.value)}
                  inputMode="decimal" required={status !== 'awaiting_bill'} />
              </label>
              <label>Recovery status
                <select className={field} value={status} onChange={e => setStatus(e.target.value as Status)}>
                  <option value="awaiting_bill">{statusLabels.awaiting_bill}</option>
                  <option value="ready_to_rebill">{statusLabels.ready_to_rebill}</option>
                  <option value="billed_back">{statusLabels.billed_back}</option>
                  <option value="not_reimbursable">{statusLabels.not_reimbursable}</option>
                </select>
              </label>
              {status === 'billed_back' && (
                <label>Invoice reference
                  <input className={field} value={invoiceRef} onChange={e => setInvoiceRef(e.target.value)} maxLength={120} required />
                </label>
              )}
            </>}
          </fieldset>
          <div className="flex gap-3">
            <button type="submit" disabled={saving} className="rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-50">
              {saving ? 'Saving…' : editing ? 'Update receipt' : 'Add receipt'}
            </button>
            {editing && <button type="button" disabled={saving} onClick={() => edit()}>Cancel</button>}
          </div>
        </form>
      )}
    </section>
  );
}
