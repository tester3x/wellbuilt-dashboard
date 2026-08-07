/**
 * vc51.9I-SEC — Anthropic client construction, isolated for injection.
 *
 * The key is read from Secret Manager at invocation time only. This module
 * exists so the read and the client construction can be unit-tested with a
 * fake secret and a fake constructor — no live credential ever enters a
 * test, and no test needs a real network client.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, readSecret } from '../secrets';

/** The narrow slice of the Anthropic SDK this codebase actually uses. */
export interface AnthropicLike {
  messages: {
    create(body: unknown): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

type AnthropicCtor = new (opts: { apiKey: string }) => AnthropicLike;

/**
 * Build a provider client.
 *
 * Both seams default to production behavior and are overridden only by
 * tests. `readSecret` throws `MissingSecretError` when the secret is unset
 * or blank, so an unconfigured deployment fails closed here rather than
 * reaching the provider with an empty key.
 */
export function createAnthropicClient(
  readKey: () => string = () => readSecret(ANTHROPIC_API_KEY),
  Ctor: AnthropicCtor = Anthropic as unknown as AnthropicCtor,
): AnthropicLike {
  return new Ctor({ apiKey: readKey() });
}
