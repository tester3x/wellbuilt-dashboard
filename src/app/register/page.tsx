'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { registerWithEmail } from '@/lib/auth';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

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
        // Most likely first-time cause: Email/Password sign-in method isn't
        // enabled. Firebase Console → Authentication → Sign-in method.
        setError(
          'Email/Password sign-in is not enabled in Firebase. Enable it in Firebase Console → Authentication → Sign-in method.'
        );
      } else if (code === 'auth/network-request-failed') {
        setError('Network error reaching Firebase. Check connection and retry.');
      } else {
        // Surface the raw code + message so we can see exactly what happened
        // instead of hiding it behind a generic fallback.
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
    <div className="min-h-screen flex items-center justify-center bg-gray-900">
      <div className="bg-gray-800 p-8 rounded-lg shadow-xl w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">WellBuilt</h1>
          <p className="text-gray-400 mt-2">Create Dashboard Account</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-3 rounded text-sm">
              {error}
            </div>
          )}

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
