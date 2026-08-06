/**
 * @tester3x/wellbuilt-contracts — curated public API.
 *
 * Exports are named explicitly (never `export *`) so the published surface
 * is a deliberate decision and an API-snapshot test can pin it. Internal
 * timezone/clock implementation details (zoneOffsetMinutes,
 * zonedWallTimeToUtcMs) stay module-private: consumers must not build
 * their own period math on them — that is exactly the drift this package
 * exists to prevent.
 *
 * Conformance fixtures are NOT here. They live behind
 * `@tester3x/wellbuilt-contracts/conformance` so production bundles never ship
 * test data.
 */
// Versioning / compatibility
export { CONTRACT_VERSION } from './types.js';
export { assertContractCompatible, SUPPORTED_CONTRACT_VERSIONS } from './handshake.js';
export { requiresWorkPeriod } from './types.js';
export { isOperationallyOpen, mayBindRequestEvidence } from './types.js';
export { resolveWorkPeriod, isValidTimezone, localDateInZone } from './resolver.js';
export { bindShiftScopedRecord, verifyShiftScopedBinding } from './types.js';
//# sourceMappingURL=index.js.map