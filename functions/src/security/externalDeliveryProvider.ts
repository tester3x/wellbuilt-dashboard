import type { ExternalDeliveryChannel } from './operational/externalAssignmentDelivery';

export type ExternalDeliveryRequest = {
  deliveryId: string;
  revision: number;
  channel: ExternalDeliveryChannel;
  phoneE164: string;
  dispatchId: string;
};

export type ExternalDeliveryProviderResult =
  | { kind: 'sent'; providerMessageId: string }
  | { kind: 'unconfigured' }
  | { kind: 'failed'; code: string };

export interface ExternalDeliveryProvider {
  readonly name: string;
  send(request: ExternalDeliveryRequest): Promise<ExternalDeliveryProviderResult>;
}

/**
 * Production-safe default. It never performs network I/O and never reports a
 * message as queued/sent. A real provider must be explicitly configured and
 * reviewed before replacing this implementation.
 */
export class UnconfiguredExternalDeliveryProvider implements ExternalDeliveryProvider {
  readonly name = 'unconfigured';

  async send(_request: ExternalDeliveryRequest): Promise<ExternalDeliveryProviderResult> {
    return { kind: 'unconfigured' };
  }
}

export function externalDeliveryProvider(): ExternalDeliveryProvider {
  return new UnconfiguredExternalDeliveryProvider();
}
