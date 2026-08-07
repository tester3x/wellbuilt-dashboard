/**
 * vc51.9I-SEC — Secret Manager bindings for provider credentials.
 *
 * These were previously ordinary plaintext environment variables set on
 * 51 deployed Functions. That is how a routine `firebase functions:list
 * --json` dump came to contain live provider API keys: the dump embeds
 * each function's environmentVariables verbatim. Secret Manager keeps the
 * values out of function configuration entirely, so no inventory, deploy
 * manifest, or console listing can reproduce them.
 *
 * Rules this module exists to enforce:
 *   - one explicit definition per provider
 *   - `.value()` is read ONLY during invocation, never at module load
 *     (a module-load read runs during deployment analysis and would fail
 *     the build for every function that does not bind the secret)
 *   - only the Functions that genuinely consume a provider declare it
 *   - no `process.env` plaintext fallback — missing fails closed
 *   - the value never reaches a log, an error, or a client response
 */
import { defineSecret } from 'firebase-functions/params';
import * as httpsV2 from 'firebase-functions/v2/https';

/**
 * Anthropic Console API key.
 *
 * Consumed by exactly one Function: `parseJsaPdf`. Bind it there and
 * nowhere else — see docs/SECRET-ROTATION-RUNBOOK.md.
 */
export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

/**
 * Gemini / Google AI Studio API key.
 *
 * DELIBERATELY NOT DEFINED. The vc51.9I-SEC census found this key bound
 * to 51 deployed Functions and read by NONE of them — no source file
 * references `GEMINI_API_KEY`, and no Google AI client is a dependency.
 * Defining a secret nobody consumes would recreate the same
 * bind-everything mistake in a new mechanism.
 *
 * If a Gemini consumer is genuinely introduced later, define it here and
 * bind it to that Function alone. Until then the correct least-privilege
 * binding is: none.
 */

/** Thrown shape for a missing/blank secret — never includes the value. */
export class MissingSecretError extends Error {
  constructor(public readonly secretName: string) {
    super(`secret ${secretName} is not configured`);
    this.name = 'MissingSecretError';
  }
}

/**
 * Read a bound secret at invocation time, failing closed.
 *
 * Deliberately no `process.env` fallback: a fallback is what lets a
 * plaintext value silently keep working after migration, which is the
 * condition this packet removes. A blank/absent secret is an operational
 * misconfiguration, so it surfaces as `failed-precondition` with a
 * redacted message — the caller learns which secret is unset, never any
 * part of its value.
 */
export function readSecret(param: { name: string; value: () => string }): string {
  let raw: string;
  try {
    raw = param.value();
  } catch {
    throw new MissingSecretError(param.name);
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new MissingSecretError(param.name);
  }
  return raw;
}

/**
 * Convert any provider/secret failure into a safe client-facing error.
 *
 * Provider SDK errors are NOT forwarded verbatim. An upstream 401/403
 * body can echo request context, and forwarding it to the client was a
 * real leak path in the pre-migration code, which threw
 * `'AI analysis failed: ' + err.message` straight through the callable.
 * The full error still reaches the server log via `logRedacted`.
 */
export function toSafeProviderError(
  provider: string,
  err: unknown,
): httpsV2.HttpsError {
  if (err instanceof MissingSecretError) {
    return new httpsV2.HttpsError(
      'failed-precondition',
      `${provider} is not configured. Set the ${err.secretName} secret in Secret Manager and redeploy.`,
    );
  }
  return new httpsV2.HttpsError('internal', `${provider} request failed.`);
}

/**
 * Redact anything that looks like a credential before logging.
 *
 * Belt-and-braces: nothing here should ever receive a key, but provider
 * errors are attacker-influenced strings and this is the last hop before
 * they reach Cloud Logging.
 */
export function redact(text: string): string {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]')
    .replace(/AQ\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]')
    .replace(/AIza[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) => (/^[a-f0-9]+$/i.test(m) ? m : '[REDACTED_OPAQUE]'));
}

/** Log a provider failure with credential-shaped material stripped. */
export function logRedacted(scope: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[${scope}] ${redact(msg)}`);
}
