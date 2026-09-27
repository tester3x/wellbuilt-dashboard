'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { sendDashboardPasswordReset } from '@/lib/auth';
import {
  GENERIC_RESET_ACK,
  RESET_COOLDOWN_MS,
  canSubmitReset,
  cooldownRemainingMs,
  isValidEmailShape,
  loginErrorMessage,
  resetErrorMessage,
} from '@/lib/passwordResetCore';

export default function LoginPage() {
  const [mode, setMode] = useState<'signin' | 'reset'>('signin');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { signIn } = useAuth();
  const router = useRouter();

  // Forgot-password state (prefilled from the login email when opened).
  const [resetEmail, setResetEmail] = useState('');
  const [resetPending, setResetPending] = useState(false);
  const [resetMessage, setResetMessage] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetLastSentAt, setResetLastSentAt] = useState<number | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signIn(email, password);
      router.push('/');
    } catch (err) {
      // Never log the raw payload (may carry sensitive fields); collapse to copy.
      setError(loginErrorMessage((err as { code?: string })?.code));
    } finally {
      setLoading(false);
    }
  };

  const openReset = () => {
    setResetEmail(email);
    setResetMessage('');
    setResetError('');
    setMode('reset');
  };

  const backToSignIn = () => {
    setResetError('');
    setResetMessage('');
    setMode('signin');
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError('');
    setResetMessage('');

    if (!isValidEmailShape(resetEmail)) {
      setResetError('Enter a valid email address.');
      return;
    }
    // Restrained client cooldown against rapid repeats.
    if (cooldownRemainingMs(resetLastSentAt, Date.now()) > 0) {
      setResetError('Please wait a moment before requesting another link.');
      return;
    }

    setResetPending(true);
    try {
      await sendDashboardPasswordReset(resetEmail);
      // Always the same generic acknowledgement — existence is never revealed.
      setResetMessage(GENERIC_RESET_ACK);
      setResetLastSentAt(Date.now());
    } catch (err) {
      const msg = resetErrorMessage((err as { code?: string })?.code);
      // resetErrorMessage falls back to the generic ack for unknown codes, so an
      // unexpected error stays non-enumerating; distinct codes get distinct copy.
      if (msg === GENERIC_RESET_ACK) {
        setResetMessage(msg);
        setResetLastSentAt(Date.now());
      } else {
        setResetError(msg);
      }
    } finally {
      setResetPending(false);
    }
  };

  const resetDisabled =
    !canSubmitReset(resetEmail, resetPending, resetLastSentAt, Date.now(), RESET_COOLDOWN_MS);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <div className="bg-gray-800 p-8 rounded-lg shadow-xl w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">WellBuilt</h1>
          <p className="text-gray-400 mt-2">
            {mode === 'signin' ? 'Dashboard Login' : 'Reset your password'}
          </p>
        </div>

        {mode === 'signin' ? (
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div role="alert" className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-3 rounded">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-2">
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
              <div className="flex items-center justify-between mb-2">
                <label htmlFor="password" className="block text-sm font-medium text-gray-300">
                  Password
                </label>
                <button
                  type="button"
                  onClick={openReset}
                  className="text-sm font-medium text-blue-400 hover:text-blue-300 focus:outline-none focus:underline"
                >
                  Forgot password?
                </button>
              </div>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-800"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>

            <div className="text-center text-sm text-gray-400">
              Need an account?{' '}
              <Link href="/register" className="text-blue-400 hover:text-blue-300 font-medium">
                Create one
              </Link>
            </div>
          </form>
        ) : (
          <form onSubmit={handleReset} className="space-y-6" aria-label="Reset password">
            <p className="text-sm text-gray-400">
              Enter your account email and we'll send a password-reset link.
            </p>

            {resetError && (
              <div role="alert" className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-3 rounded">
                {resetError}
              </div>
            )}
            {resetMessage && (
              <div role="status" className="bg-green-900/40 border border-green-600 text-green-200 px-4 py-3 rounded">
                {resetMessage}
              </div>
            )}

            <div>
              <label htmlFor="reset-email" className="block text-sm font-medium text-gray-300 mb-2">
                Email
              </label>
              <input
                id="reset-email"
                type="email"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                required
                autoFocus
                autoComplete="email"
                className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="you@example.com"
              />
            </div>

            <button
              type="submit"
              disabled={resetDisabled}
              className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-800"
            >
              {resetPending ? 'Sending…' : 'Send reset link'}
            </button>

            <div className="text-center text-sm text-gray-400">
              <button
                type="button"
                onClick={backToSignIn}
                className="text-blue-400 hover:text-blue-300 font-medium focus:outline-none focus:underline"
              >
                Back to sign in
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
