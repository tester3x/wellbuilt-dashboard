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
 *   - one explicit NAME per provider, never a global `defineSecret`
 *     parameter. vc51.9L found why: a module-scope `defineSecret` is a
 *     codebase-GLOBAL Firebase parameter, and the CLI resolves every
 *     declared parameter while analysing the source, BEFORE it applies an
 *     `--only` filter. With ANTHROPIC_API_KEY holding no version and
 *     GEMINI_API_KEY absent, that made the entire codebase undeployable —
 *     including three Auth Functions that touch neither provider.
 *     String-named bindings are validated per-Function at deploy time
 *     instead, so an unrelated selective deploy is unaffected.
 *   - the value is read ONLY during invocation, never at module load
 *   - only the Functions that genuinely consume a provider declare it
 *   - no fallback of any kind — an unset secret fails closed
 *   - the value never reaches a log, an error, or a client response
 */
import * as httpsV2 from 'firebase-functions/v2/https';

/**
 * Anthropic Console API key.
 *
 * Consumed by exactly one Function: `parseJsaPdf`. Bind it there and
 * nowhere else — see docs/SECRET-ROTATION-RUNBOOK.md.
 */
export const ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY' as const;

/**
 * Gemini / Google AI Studio API key.
 *
 * Consumed by the two photo-compliance Functions only. Both switch
 * provider at runtime via `PHOTO_COMPLIANCE_PROVIDER`, so either can
 * genuinely reach either provider and both bind both secrets — that is
 * least privilege at the Function boundary, not laziness.
 *
 * History worth keeping: the vc51.9I-SEC census concluded this key had
 * zero consumers and deliberately left it undefined. That was true of
 * the source tree at the time, but WRONG about the deployed code — the
 * photo-compliance Functions were live and absent from local source.
 * They are restored here, so the consumer is real.
 *
 * Nothing else may bind this. `parseJsaPdf` stays Anthropic-only, and
 * the well-catalog and split-family Functions bind neither.
 */
export const GEMINI_API_KEY = 'GEMINI_API_KEY' as const;

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
 * Secret Manager injects a bound secret into the runtime environment of
 * the Function that declared it, and only that Function. Reading it here,
 * during invocation, is the supported access path for a string-named
 * binding — it is NOT a plaintext fallback, and there is no fallback: an
 * absent or blank value is an operational misconfiguration and surfaces
 * as `failed-precondition` with a redacted message. The caller learns
 * which secret is unset, never any part of its value.
 *
 * A Function that did not bind the secret sees nothing here and fails
 * closed, which is exactly the least-privilege boundary the previous
 * `defineSecret` object provided — without making the parameter global.
 */
export function readSecret(name: string): string {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new MissingSecretError(name);
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
