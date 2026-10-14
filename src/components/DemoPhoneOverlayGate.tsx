'use client';

import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { DemoPhoneOverlay } from '@/components/DemoPhoneOverlay';

/** Keep the same live phone feed visible while a demo viewer changes Dashboard pages. */
export function DemoPhoneOverlayGate() {
  const { user } = useAuth();
  const pathname = usePathname();
  if (user?.uid !== 'wellbuilt-demo-shared-viewer' || pathname === '/live-demo' || pathname === '/login') return null;
  return <DemoPhoneOverlay />;
}
