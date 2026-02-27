'use client';

import Link from 'next/link';

export function SubHeader({
  backHref,
  title,
  subtitle,
  actions,
}: {
  backHref: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="bg-gray-800/50 border-b border-gray-700">
      <div className="max-w-7xl mx-auto px-4 py-3 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Link href={backHref} className="text-gray-400 hover:text-white transition-colors">
            &larr; Back
          </Link>
          <div>
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            {subtitle && <p className="text-gray-400 text-sm">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex items-center gap-4">{actions}</div>}
      </div>
    </div>
  );
}
