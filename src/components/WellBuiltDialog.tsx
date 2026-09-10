'use client';

import { ReactNode } from 'react';

export function WellBuiltDialog(props: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  primaryLabel?: string;
  primaryTone?: 'gold' | 'danger' | 'neutral';
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  secondaryLabel?: string;
}) {
  if (!props.open) return null;
  const tone = props.primaryTone || 'gold';
  const primaryClass =
    tone === 'danger'
      ? 'bg-red-600 hover:bg-red-500 text-white'
      : tone === 'neutral'
        ? 'bg-gray-600 hover:bg-gray-500 text-white'
        : 'bg-yellow-500 hover:bg-yellow-400 text-black';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-xl border border-yellow-500/40 bg-gray-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-700 px-5 py-3">
          <h2 className="text-lg font-bold text-white">{props.title}</h2>
          <button type="button" onClick={props.onClose} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="px-5 py-4 text-sm text-gray-200">{props.children}</div>
        <div className="flex justify-end gap-2 border-t border-gray-700 px-5 py-3">
          <button
            type="button"
            onClick={props.onClose}
            className="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm"
          >
            {props.secondaryLabel || 'Cancel'}
          </button>
          {props.onPrimary && (
            <button
              type="button"
              disabled={props.primaryDisabled}
              onClick={props.onPrimary}
              className={`px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 ${primaryClass}`}
            >
              {props.primaryLabel || 'Continue'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
