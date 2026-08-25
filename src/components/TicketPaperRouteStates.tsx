'use client';

export function TicketPolicyUnavailable(input: { message: string; gap?: string; onClose: () => void }) {
  return (
    <div className="bg-[#111827] border border-yellow-700 rounded-lg p-6 text-white" data-paper-mode="policy_undefined">
      <h2 className="font-semibold text-yellow-400">Policy unavailable</h2>
      <p className="mt-2 text-sm text-gray-300">{input.message}</p>
      {input.gap && <p className="mt-1 text-xs text-gray-500">{input.gap}</p>}
      <button type="button" className="mt-4 text-sm text-gray-400" onClick={input.onClose}>Close</button>
    </div>
  );
}

export function TicketRouteFailure(input: { message: string; onClose: () => void; mode?: string }) {
  return (
    <div className="bg-[#111827] border border-red-700 rounded-lg p-6 text-white" data-paper-mode={input.mode || 'route_failure'}>
      <h2 className="font-semibold text-red-400">Document unavailable</h2>
      <p className="mt-2 text-sm text-gray-300">{input.message}</p>
      <button type="button" className="mt-4 text-sm text-gray-400" onClick={input.onClose}>Close</button>
    </div>
  );
}
