import * as httpsV2 from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  buildSwdReferenceSet,
  isOfficialSwd,
} from '../truth-layer';
import { loadSwdReferenceRuntime } from './loadSwdReferenceRuntime';

/**
 * Phase 24 — public, read-only demo classifier callable.
 *
 * Exposes the SAME SWD match path the real truth layer uses (Phase 18
 * static seed merged with Phase 21 RTDB runtime catalog via
 * `buildSwdReferenceSet` + `isOfficialSwd`). Consumed by the public
 * `/demo` route so demo classifications match what the live system
 * would produce for the same names.
 *
 * First public truth callable — deliberately no `requireAdminRole`
 * gate. Safety comes from strict input shape locks and a zero-write
 * surface:
 *   - input is exactly { locations: string[] }
 *   - max 10 locations per call
 *   - each name trimmed + capped at 200 chars
 *   - empty / non-string entries dropped silently
 *   - body is stateless (no user state, no session state)
 *   - zero writes to Firebase (admin SDK read of
 *     truth_reference/swd_catalog only)
 *   - does NOT call or reference any admin callable
 *     (approveTruthLocation / revokeTruthLocationApproval /
 *     addTruthSwdReference / deactivateTruthSwdReference)
 *
 * NDIC classification is a demo heuristic — the real system matches
 * NDIC via the well_config catalog which needs company context we
 * don't have in demo. The heuristic is deliberately conservative so
 * it approximates the real outcome for common well naming but won't
 * misclassify random strings as wells.
 */

const MAX_LOCATIONS = 10;
const MAX_NAME_LEN = 200;

/**
 * NDIC-style well name heuristic — matches trailing number-block
 * patterns ("1-36-25H", "9-18-17TFH", "#1-16-21H"). Same regex as
 * the Phase 23 local classifier so /demo's live + fallback paths
 * agree on this branch. Kept local to this callable to avoid
 * contaminating shared/truth-layer with a demo-only heuristic.
 */
const NDIC_STYLE_PATTERN = /\b#?\d+-\d+-\d+[A-Z]{0,4}\b/i;

interface RawRequest {
  locations?: unknown;
}

interface DemoClassification {
  name: string;
  resolvedType: 'well' | 'disposal' | 'custom';
  confidence: 'strong' | 'weak';
  explanation:
    | 'Matched NDIC pattern'
    | 'Matched SWD reference'
    | 'Custom operational name';
}

function parseRequest(data: unknown): string[] {
  const req = (data ?? {}) as RawRequest;
  const raw = req.locations;
  if (!Array.isArray(raw)) {
    throw new HttpsError(
      'invalid-argument',
      '`locations` must be an array of strings.'
    );
  }
  if (raw.length > MAX_LOCATIONS) {
    throw new HttpsError(
      'invalid-argument',
      `Too many locations — max ${MAX_LOCATIONS} per call.`
    );
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().slice(0, MAX_NAME_LEN);
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

function classifyOne(
  name: string,
  swdSet: ReadonlySet<string>
): DemoClassification {
  // Priority: SWD reference match wins (real system behavior — an SWD
  // name that also happens to contain a number block is still an SWD).
  if (isOfficialSwd(name, swdSet)) {
    return {
      name,
      resolvedType: 'disposal',
      confidence: 'strong',
      explanation: 'Matched SWD reference',
    };
  }
  if (NDIC_STYLE_PATTERN.test(name)) {
    return {
      name,
      resolvedType: 'well',
      confidence: 'strong',
      explanation: 'Matched NDIC pattern',
    };
  }
  return {
    name,
    resolvedType: 'custom',
    confidence: 'weak',
    explanation: 'Custom operational name',
  };
}

export const demoClassifyLocations = httpsV2.onCall(
  {
    timeoutSeconds: 30,
    memory: '256MiB',
    // Callable functions are public-by-default when no auth is checked
    // inside the handler. Keep the generous concurrency + CORS defaults.
  },
  async (request) => {
    // Intentionally NO requireAdminRole call — this is the first
    // public truth callable. Safety guarantees come from input shape
    // + read-only body.
    const names = parseRequest(request.data);

    // Empty input after sanitization is a valid no-op — returns an
    // empty result array rather than an error.
    if (names.length === 0) {
      return {
        results: [] as DemoClassification[],
        engine: 'truth-layer' as const,
        swdRuntimeCount: 0,
        swdRuntimeInactiveCount: 0,
      };
    }

    // Best-effort runtime SWD catalog load. On failure, fall through
    // to static-seed-only match (matches the real-system behavior when
    // the RTDB loader errors — see truthLocationHealth.ts).
    const swdRuntime = await loadSwdReferenceRuntime();
    const swdSet = buildSwdReferenceSet(swdRuntime.entries);

    const results = names.map((n) => classifyOne(n, swdSet));

    return {
      results,
      engine: 'truth-layer' as const,
      swdRuntimeCount: swdRuntime.count,
      swdRuntimeInactiveCount: swdRuntime.inactiveCount,
    };
  }
);
