import { Suspense, type ReactNode } from 'react';

export function generateStaticParams() {
  return [{ incidentId: 'placeholder' }];
}

export default function SpillIncidentLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <Suspense fallback={null}>{children}</Suspense>;
}
