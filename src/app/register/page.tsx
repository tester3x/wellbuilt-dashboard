'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { registerWithEmail } from '@/lib/auth';
import {
  decodeDemoBridgeQuery,
  DEMO_BRIDGE_STORAGE_KEY,
  type DemoBridgePayload,
} from '@/lib/demoBridge';

export default function RegisterPage() {
  // Next.js 16 app-router requires Suspense around any client component
  // that calls useSearchParams when using `output: 'export'`. Keep the
  // inner form in a child so the outer page has a clean fallback.
  return (
    <Suspense fallback={<RegisterFallback />}>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterFallback(): React.ReactElement {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <div className="text-gray-400 text-sm">Loading…</div>
    </div>
  );
}

function RegisterForm(): React.ReactElement {
  const searchParams = useSearchParams();

  // Phase 25 — read the demo bridge payload on mount. Null on any
  // parse / shape error; the form renders identically to the pre-
  // Phase-25 page in that case.
  const demoPayload = useMemo<DemoBridgePayload | null>(
    () => decodeDemoBridgeQuery(searchParams),
    [searchParams]
  );

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [company, setCompany] = useState<string>(
    () => demoPayload?.company ?? ''
  );
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  // Mirror the demo payload into sessionStorage so a future post-
  // registration onboarding flow can resume where the demo left off.
  // Nothing is written to Firebase here — strictly client-side state.
  useEffect(() => {
    if (!demoPayload) return;
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(
        DEMO_BRIDGE_STORAGE_KEY,
        JSON.stringify(demoPayload)
      );
    } catch {
      // Session storage may be unavailable (private mode, quota). The
      // banner still shows, so the flow remains visually continuous.
    }
  }, [demoPayload]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    try {
      await registerWithEmail(email, password);
      // createUserWithEmailAndPassword auto-signs the user in; onAuthStateChanged
      // in AuthContext will populate user shortly after routing.
      router.push('/');
    } catch (err) {
      console.error('Register error:', err);
      const code = (err as { code?: string })?.code;
      const message = (err as { message?: string })?.message;
      if (code === 'auth/email-already-in-use') {
        setError(
          'An account with this email already exists. Use Sign In instead.'
        );
      } else if (code === 'auth/invalid-email') {
        setError('That email address is invalid.');
      } else if (code === 'auth/weak-password') {
        setError('Password is too weak. Use at least 6 characters.');
      } else if (code === 'auth/operation-not-allowed') {
        setError(
          'Email/Password sign-in is not enabled in Firebase. Enable it in Firebase Console → Authentication → Sign-in method.'
        );
      } else if (code === 'auth/network-request-failed') {
        setError('Network error reaching Firebase. Check connection and retry.');
      } else {
        setError(
          code
            ? `Failed to create account (${code}). ${message ?? ''}`.trim()
            : `Failed to create account. ${message ?? 'Please try again.'}`.trim()
        );
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 py-10">
      <div className="bg-gray-800 p-8 rounded-lg shadow-xl w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-white">WellBuilt</h1>
          <p className="text-gray-400 mt-2">Create Dashboard Account</p>
        </div>

        {demoPayload && (
          <div className="mb-6 bg-blue-900/30 border border-blue-700/60 rounded-lg p-4">
            <div className="text-[11px] uppercase tracking-wide text-blue-300 mb-1">
              Continuing from demo setup
            </div>
            <p className="text-sm text-gray-200">
              We'll use your demo setup to get you started.
            </p>
            {demoPayload.locations.length > 0 && (
              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">
                  We detected your demo setup:
                </div>
                <ul className="list-disc list-inside text-xs text-gray-300 space-y-0.5">
                  {demoPayload.locations.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
                <p className="text-[11px] text-gray-500 mt-2">
                  These will be saved to your account after you finish
                  signing up — nothing has been written yet.
                </p>
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-3 rounded text-sm">
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="company"
              className="block text-sm font-medium text-gray-300 mb-2"
            >
              Company name{' '}
              <span className="text-xs text-gray-500 font-normal">
                (optional — you can set this after sign-up)
              </span>
            </label>
            <input
              id="company"
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              autoComplete="organization"
              className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Acme Hauling Co."
            />
          </div>

          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-gray-300 mb-2"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-gray-300 mb-2"
            >
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                minLength={6}
                className="w-full px-4 py-3 pr-14 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                tabIndex={-1}
                className="absolute inset-y-0 right-0 px-3 text-gray-400 hover:text-gray-200 text-xs uppercase tracking-wide"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor="confirm"
              className="block text-sm font-medium text-gray-300 mb-2"
            >
              Confirm password
            </label>
            <div className="relative">
              <input
                id="confirm"
                type={showConfirm ? 'text' : 'password'}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
                minLength={6}
                className="w-full px-4 py-3 pr-14 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowConfirm((v) => !v)}
                aria-label={showConfirm ? 'Hide password' : 'Show password'}
                tabIndex={-1}
                className="absolute inset-y-0 right-0 px-3 text-gray-400 hover:text-gray-200 text-xs uppercase tracking-wide"
              >
                {showConfirm ? 'Hide' : 'Show'}
              </button>
            </div>
            {confirm.length > 0 && password.length > 0 && (
              <p
                className={`mt-1 text-xs ${
                  password === confirm ? 'text-green-400' : 'text-amber-400'
                }`}
              >
                {password === confirm ? 'Passwords match' : 'Passwords do not match'}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-800"
          >
            {loading ? 'Creating account…' : 'Create Account'}
          </button>

          <div className="text-center text-sm text-gray-400">
            Already have an account?{' '}
            <Link
              href="/login"
              className="text-blue-400 hover:text-blue-300 font-medium"
            >
              Sign in
            </Link>
          </div>

          <div className="text-center text-xs text-gray-500 border-t border-gray-700 pt-4">
            New accounts start with viewer-level access. A WellBuilt admin must
            promote your role in RTDB (<span className="font-mono">users/{'{uid}'}.role</span>) to grant
            admin or IT page access.
          </div>
        </form>
      </div>
    </div>
  );
}
