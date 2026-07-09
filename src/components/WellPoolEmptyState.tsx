'use client';

// Empty state shown to scoped non-Liquid-Gold companies on the WB Mobile well
// surfaces (see src/lib/tenantScope.ts for the containment rule). Rendered
// inside each page's normal layout (below AppHeader/SubHeader).
export function WellPoolEmptyState(): React.ReactElement {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg py-16 px-6 text-center">
      <div className="text-white text-lg font-semibold mb-2">
        No routes configured yet
      </div>
      <p className="text-gray-400 text-sm max-w-md mx-auto">
        Well monitoring is not configured for this company. Contact WellBuilt
        to set up operators and routes.
      </p>
    </div>
  );
}
