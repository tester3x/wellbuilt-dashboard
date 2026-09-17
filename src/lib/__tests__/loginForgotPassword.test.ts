import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const login = readFileSync(new URL('../../app/login/page.tsx', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../auth.ts', import.meta.url), 'utf8');

test('login exposes a visible, keyboard-accessible "Forgot password?" control', () => {
  assert.match(login, /Forgot password\?/);
  // It is a real <button type="button"> (focusable, Enter/Space activatable) with a focus style.
  assert.match(login, /onClick=\{openReset\}[\s\S]{0,160}?focus:underline/);
});

test('the reset form prefills the email already typed on login', () => {
  assert.match(login, /const openReset = \(\) => \{\s*setResetEmail\(email\);/);
  assert.match(login, /value=\{resetEmail\}/);
});

test('repeat submission is blocked while pending and by the client cooldown', () => {
  assert.match(login, /disabled=\{resetDisabled\}/);
  assert.match(login, /canSubmitReset\(resetEmail, resetPending, resetLastSentAt/);
  assert.match(login, /cooldownRemainingMs\(resetLastSentAt, Date\.now\(\)\) > 0/);
  assert.match(login, /setResetPending\(true\)/);
});

test('every successful path shows the SAME generic acknowledgement (non-enumerating)', () => {
  assert.match(login, /setResetMessage\(GENERIC_RESET_ACK\)/);
  // The wrapper swallows user-not-found, so success copy cannot depend on existence.
  assert.match(auth, /if \(code === 'auth\/user-not-found'\) return;/);
});

test('local invalid-email is handled before any network call', () => {
  assert.match(login, /if \(!isValidEmailShape\(resetEmail\)\) \{\s*setResetError\('Enter a valid email address\.'\);\s*return;/);
});

test('sign-in error variants collapse to identical copy (no enumeration)', () => {
  assert.match(login, /setError\(loginErrorMessage\(\(err as \{ code\?: string \}\)\?\.code\)\)/);
  assert.doesNotMatch(login, /No account found with this email|Incorrect password|Invalid email or password/);
});

test('clean return to regular sign-in', () => {
  assert.match(login, /Back to sign in/);
  assert.match(login, /const backToSignIn = \(\) => \{[\s\S]*?setMode\('signin'\)/);
});

test('messages use ARIA live regions for screen readers', () => {
  assert.match(login, /role="alert"/); // errors
  assert.match(login, /role="status"/); // success ack
});

test('the wrapper never logs email / link / code / token / raw error payload', () => {
  const fn = auth.slice(auth.indexOf('export async function sendDashboardPasswordReset'), auth.indexOf('export async function sendDashboardPasswordReset') + 700);
  assert.doesNotMatch(fn, /console\.(log|warn|error|info)/, 'no logging in the reset wrapper');
  assert.match(fn, /throw \{ code \} as \{ code\?: string \}/, 'propagates only the bare error code (payload stripped)');
  // The login handlers also must not log the raw error object.
  assert.doesNotMatch(login, /console\.(log|error|warn|info)\(/, 'login page does not log errors/emails');
});

test('existing sign-in is preserved (still calls signIn + renders the Sign In control)', () => {
  assert.match(login, /await signIn\(email, password\)/, 'sign-in still calls the auth context signIn');
  assert.match(login, /router\.push\('\/'\)/, 'successful sign-in still navigates home');
  assert.match(login, /\{loading \? 'Signing in\.\.\.' : 'Sign In'\}/, 'Sign In button preserved');
  assert.match(login, /Need an account\?/, 'register link preserved');
});

test('v1 uses Firebase hosted reset (no custom landing page / backend added)', () => {
  assert.match(auth, /sendPasswordResetEmail\(auth, email\.trim\(\)\)/);
  // No custom action-code URL / continueUrl introduced for v1.
  assert.doesNotMatch(auth, /actionCodeSettings|continueUrl/);
});
