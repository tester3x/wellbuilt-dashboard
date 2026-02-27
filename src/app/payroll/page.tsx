'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';

export default function PayrollPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-gray-900">
      <AppHeader />

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-12 text-center">
          <h2 className="text-2xl font-bold text-white mb-4">WB Payroll</h2>
          <p className="text-gray-400 text-lg mb-2">Employee Timesheets &amp; Payroll</p>
          <p className="text-gray-500">Coming Soon</p>
        </div>
      </main>
    </div>
  );
}
