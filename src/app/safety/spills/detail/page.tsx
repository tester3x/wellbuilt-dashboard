'use client';

import { Suspense } from 'react';
import { SpillIncidentDetailClient } from '@/components/safety/SpillIncidentDetailClient';

function SpillDetailFallback() {
  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <div className="text-white text-xl">Loading...</div>
    </div>
  );
}

export default function SpillIncidentDetailPage() {
  return (
    <Suspense fallback={<SpillDetailFallback />}>
      <SpillIncidentDetailClient />
    </Suspense>
  );
}
