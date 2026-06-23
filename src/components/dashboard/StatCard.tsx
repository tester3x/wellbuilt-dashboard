// Small presentational stat tile for Dashboard V1. Matches the existing
// home-page card styling (bg-gray-800 / border-gray-700 / font-mono numbers).

interface StatCardProps {
  label: string;
  value: string | number;
  /** Optional secondary line under the value (e.g. units or a sublabel). */
  sub?: string;
  /** Optional accent color class for the value (e.g. 'text-yellow-400'). */
  valueClass?: string;
}

export function StatCard({ label, value, sub, valueClass }: StatCardProps) {
  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-5">
      <div className="text-gray-400 text-xs uppercase tracking-wide mb-2">{label}</div>
      <div className={`text-3xl font-mono font-semibold ${valueClass || 'text-white'}`}>
        {value}
      </div>
      {sub && <div className="text-gray-500 text-xs mt-1">{sub}</div>}
    </div>
  );
}
