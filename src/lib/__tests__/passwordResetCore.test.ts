import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERIC_RESET_ACK,
  GENERIC_LOGIN_ERROR,
  RESET_COOLDOWN_MS,
  isValidEmailShape,
  loginErrorMessage,
  resetErrorMessage,
  cooldownRemainingMs,
  canSubmitReset,
} from '../passwordResetCore.ts';

test('email shape validation is local and basic', () => {
  assert.equal(isValidEmailShape('you@example.com'), true);
  assert.equal(isValidEmailShape('  you@example.com  '), true);
  assert.equal(isValidEmailShape('nope'), false);
  assert.equal(isValidEmailShape('a@b'), false);
  assert.equal(isValidEmailShape('a b@c.com'), false);
  assert.equal(isValidEmailShape(''), false);
});

test('sign-in errors collapse enumerating codes to ONE generic message', () => {
  for (const code of ['auth/user-not-found', 'auth/wrong-password', 'auth/invalid-credential', undefined, 'auth/internal-error']) {
    assert.equal(loginErrorMessage(code), GENERIC_LOGIN_ERROR, `${code} → generic`);
  }
});

test('sign-in keeps only non-enumerating distinct states', () => {
  assert.match(loginErrorMessage('auth/invalid-email'), /valid email/i);
  assert.match(loginErrorMessage('auth/network-request-failed'), /network/i);
  assert.match(loginErrorMessage('auth/too-many-requests'), /too many/i);
});

test('reset errors: unknown/absent codes fall back to the generic ack (non-enumerating)', () => {
  assert.equal(resetErrorMessage(undefined), GENERIC_RESET_ACK);
  assert.equal(resetErrorMessage('auth/internal-error'), GENERIC_RESET_ACK);
  // user-not-found never reaches here, but if it did it would NOT reveal existence:
  assert.equal(resetErrorMessage('auth/user-not-found'), GENERIC_RESET_ACK);
  // distinct, non-enumerating states still differ:
  assert.match(resetErrorMessage('auth/invalid-email'), /valid email/i);
  assert.match(resetErrorMessage('auth/network-request-failed'), /network/i);
  assert.match(resetErrorMessage('auth/too-many-requests'), /too many/i);
});

test('the generic ack never states whether an account exists', () => {
  assert.match(GENERIC_RESET_ACK, /if an account exists/i);
  assert.doesNotMatch(GENERIC_RESET_ACK, /no account|not found|doesn't exist|sent to/i);
});

test('client cooldown blocks rapid repeats', () => {
  const t0 = 1_000_000;
  assert.equal(cooldownRemainingMs(null, t0), 0, 'never sent → ready');
  assert.equal(cooldownRemainingMs(t0, t0), RESET_COOLDOWN_MS, 'just sent → full cooldown');
  assert.equal(cooldownRemainingMs(t0, t0 + RESET_COOLDOWN_MS), 0, 'after cooldown → ready');
  assert.equal(cooldownRemainingMs(t0, t0 + 5000), RESET_COOLDOWN_MS - 5000);
});

test('canSubmitReset gates on validity, pending, and cooldown', () => {
  const t0 = 1_000_000;
  assert.equal(canSubmitReset('you@example.com', false, null, t0), true, 'valid + idle + no cooldown');
  assert.equal(canSubmitReset('you@example.com', true, null, t0), false, 'pending blocks');
  assert.equal(canSubmitReset('bad', false, null, t0), false, 'invalid email blocks');
  assert.equal(canSubmitReset('you@example.com', false, t0, t0 + 1000), false, 'within cooldown blocks');
  assert.equal(canSubmitReset('you@example.com', false, t0, t0 + RESET_COOLDOWN_MS), true, 'after cooldown ok');
});
