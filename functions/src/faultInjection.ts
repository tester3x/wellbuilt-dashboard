// faultInjection.ts — emulator-only fault points for the canonical coordinator.
//
// FAIL CLOSED. Faults can activate ONLY when ALL of these hold:
//   1. FUNCTIONS_EMULATOR === 'true'        (set by the Functions emulator)
//   2. FIREBASE_DATABASE_EMULATOR_HOST set  (the RTDB emulator is the target)
//   3. WB_FAULT_SPEC set at process launch  (explicit operator intent)
// A production deployment satisfies none of them; neither packet contents nor
// RTDB data can activate a fault — the spec comes exclusively from process
// environment fixed at emulator launch. RTDB is used only to RELEASE a pause
// that the environment already activated, and to record one-shot consumption.
//
// Spec grammar:  point:operationId[;point:operationId...]
// Points:
//   crash_during_planning   — throw after the planning lock is acquired
//   crash_before_commit     — throw after planning→committing, before the update
//   crash_after_commit      — throw after the atomic update, before release
//   pause_before_transition — wait (poll test_faults/release/<op>) before the
//                             planning→committing CAS — the TOCTOU probe
// Every fault fires ONCE per operationId (recorded under test_faults/fired).

export type FaultPoint =
  | 'crash_during_planning'
  | 'crash_before_commit'
  | 'crash_after_commit'
  | 'pause_before_transition';

export interface FaultDb {
  ref(path: string): {
    once(evt: 'value'): Promise<{ val(): unknown }>;
    transaction(update: (cur: unknown) => unknown): Promise<{ committed: boolean; snapshot: { val(): unknown } }>;
  };
}

export function faultInjectionArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FUNCTIONS_EMULATOR === 'true'
    && !!env.FIREBASE_DATABASE_EMULATOR_HOST
    && !!env.WB_FAULT_SPEC;
}

export function parseFaultSpec(raw: string | undefined): Map<string, FaultPoint> {
  const out = new Map<string, FaultPoint>();
  for (const entry of String(raw ?? '').split(';')) {
    const [point, op] = entry.split(':').map((x) => x?.trim());
    if (!point || !op) continue;
    if (['crash_during_planning', 'crash_before_commit', 'crash_after_commit', 'pause_before_transition'].includes(point)) {
      out.set(op, point as FaultPoint);
    }
  }
  return out;
}

/**
 * Build the coordinator's optional fault hook. Returns undefined (no hook at
 * all) unless the emulator gate passes — exported production handlers carry
 * no reachable injection surface.
 */
export function makeFaultHook(
  db: FaultDb,
  env: NodeJS.ProcessEnv = process.env,
): ((point: FaultPoint, operationId: string) => Promise<void>) | undefined {
  if (!faultInjectionArmed(env)) return undefined;
  const spec = parseFaultSpec(env.WB_FAULT_SPEC);
  if (spec.size === 0) return undefined;

  return async (point: FaultPoint, operationId: string): Promise<void> => {
    if (spec.get(operationId) !== point) return;
    // One-shot: first arrival claims the fault; retries pass through clean.
    const claim = await db.ref(`test_faults/fired/${operationId}`).transaction((cur) => {
      if (cur) return; // already fired → abort (no re-fire)
      return { point, at: Date.now() };
    });
    if (!claim.committed) return;

    if (point === 'pause_before_transition') {
      // Hold until the harness releases us (bounded so a broken test cannot
      // hang the emulator invocation forever).
      const deadline = Date.now() + 60_000;
      for (;;) {
        const released = (await db.ref(`test_faults/release/${operationId}`).once('value')).val();
        if (released === true || Date.now() > deadline) return;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error(`FAULT_INJECTED:${point}:${operationId}`);
  };
}
