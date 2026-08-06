/**
 * Version handshake — an app must never silently consume an unknown future
 * contract. Consumers call this once at startup (or before first resolve)
 * so a mismatched deployment fails loudly and early instead of behaving
 * subtly differently between apps.
 */
import { CONTRACT_VERSION } from './types.js';
export const SUPPORTED_CONTRACT_VERSIONS = Object.freeze([CONTRACT_VERSION]);
export function assertContractCompatible(documentContractVersion, consumerName) {
    if (!SUPPORTED_CONTRACT_VERSIONS.includes(documentContractVersion)) {
        throw new Error(`[@tester3x/wellbuilt-contracts] ${consumerName} cannot consume contractVersion ` +
            `${documentContractVersion}; supported: ${SUPPORTED_CONTRACT_VERSIONS.join(', ')}`);
    }
}
//# sourceMappingURL=handshake.js.map