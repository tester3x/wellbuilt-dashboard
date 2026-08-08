/**
 * vc51.9Z — `bootstrapFirstPlatformAdmin`.
 *
 * The onCall adapter over bootstrapAuthority.ts. The decision and the step
 * order live there and are proven by tools/test-firstAdminBootstrap.mjs;
 * this file only wires real dependencies and executes the plan.
 *
 * INVOCATION CONTRACT. The payload must be exactly `{}`. There is no
 * target-uid input: the subject is always `request.auth.uid`, so there is
 * nothing to spoof. Nothing about a password or a token is ever sent by
 * the client — the caller's existing Firebase session IS the proof, and
 * `email_verified` is read from the verified token, not from the request.
 *
 * TEMPORARY BY CONSTRUCTION. It refuses permanently once the completion
 * marker is written, and the endpoint itself is deleted immediately after
 * the first successful use. Both, not either.
 *
 * The allowlist comes from the BOOTSTRAP_ADMIN_ALLOWLIST environment
 * variable, set at deploy time. It is empty by default, so a deployment
 * that has not deliberately opted in refuses every caller.
 */

import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  BOOTSTRAP_MAX_ATTEMPTS,
  bootstrapPlan,
  buildBootstrapAudit,
  buildPlatformAdminRecord,
  decideBootstrap,
  parseBootstrapAllowlist,
  type BootstrapStep,
} from './bootstrapAuthority';
import { ADMIN_POLICY_VERSION, PLATFORM_ADMINS_COLLECTION, WELLBUILT_ADMIN_CLAIM } from './authority';
import { ADMIN_AUDIT_COLLECTION } from './adminAudit';

/** Server-owned bootstrap state: attempt counter + permanent completion. */
const BOOTSTRAP_STATE_DOC = 'platform_bootstrap/state';

export const bootstrapFirstPlatformAdmin = httpsV2.onCall(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60, enforceAppCheck: false },
  async (request) => {
    const db = admin.firestore();
    const auth = admin.auth();

    // ── exact-key validation: the payload carries nothing at all ──────────
    const data: unknown = request.data ?? {};
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new httpsV2.HttpsError('invalid-argument', 'payload_not_object');
    }
    const extra = Object.keys(data as Record<string, unknown>);
    if (extra.length > 0) {
      // Named explicitly so a client that tries to pass a uid learns that
      // the field does not exist, rather than that it was ignored.
      throw new httpsV2.HttpsError('invalid-argument', `unknown_fields:${extra.join(',')}`);
    }

    const uid = request.auth?.uid ?? null;
    const token = request.auth?.token as Record<string, unknown> | undefined;
    const email = typeof token?.email === 'string' ? token.email : null;
    const emailVerified = token?.email_verified === true;

    // ── read world state ──────────────────────────────────────────────────
    const stateSnap = await db.doc(BOOTSTRAP_STATE_DOC).get();
    const state = stateSnap.exists ? (stateSnap.data() as Record<string, unknown>) : {};
    const completed = state.completed === true;
    const attemptsUsed = typeof state.attempts === 'number' ? state.attempts : 0;

    // An enabled record for any OTHER uid closes bootstrap. Bounded read:
    // one enabled record is enough to refuse.
    let enabledAdminExistsElsewhere = false;
    {
      const enabled = await db.collection(PLATFORM_ADMINS_COLLECTION)
        .where('enabled', '==', true).limit(2).get();
      enabledAdminExistsElsewhere = enabled.docs.some((d) => d.id !== uid);
    }

    const decision = decideBootstrap(
      { authenticated: !!uid, uid, email, emailVerified },
      {
        allowlist: parseBootstrapAllowlist(process.env.BOOTSTRAP_ADMIN_ALLOWLIST),
        completed,
        enabledAdminExistsElsewhere,
        attemptsUsed,
        maxAttempts: BOOTSTRAP_MAX_ATTEMPTS,
      },
    );

    if (!decision.ok) {
      // Count only attempts that got past the allowlist: an unauthorized
      // caller must not be able to exhaust the budget for the real owner.
      if (decision.detailSafe) {
        await db.doc(BOOTSTRAP_STATE_DOC).set(
          { attempts: FieldValue.increment(1), lastAttemptAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      }
      if (decision.reason === 'unauthenticated') {
        throw new httpsV2.HttpsError('unauthenticated', 'unauthenticated');
      }
      // A refusal that is not detail-safe says nothing beyond "denied".
      throw new httpsV2.HttpsError(
        'permission-denied',
        decision.detailSafe ? decision.reason : 'denied',
      );
    }

    const subject = decision.uid;

    // ── observe current state, then resume the plan ───────────────────────
    const userRecord = await auth.getUser(subject);
    const existingClaims = userRecord.customClaims ?? {};
    const recSnap = await db.doc(`${PLATFORM_ADMINS_COLLECTION}/${subject}`).get();
    const recData = recSnap.exists ? (recSnap.data() as Record<string, unknown>) : null;

    const plan = bootstrapPlan({
      claimTrue: existingClaims[WELLBUILT_ADMIN_CLAIM] === true,
      recordExists: recSnap.exists,
      recordEnabled: recData?.enabled === true,
    });

    const executed: BootstrapStep[] = [];
    for (const step of plan) {
      switch (step) {
        case 'write_pending_record':
          // Created DISABLED. If everything after this is lost, the
          // surviving state fails the dual gate.
          await db.doc(`${PLATFORM_ADMINS_COLLECTION}/${subject}`).set(
            buildPlatformAdminRecord({ uid: subject, email }, FieldValue.serverTimestamp()),
            { merge: true },
          );
          break;
        case 'set_claim':
          // Merge: unrelated claims on this user are preserved.
          await auth.setCustomUserClaims(subject, {
            ...existingClaims,
            [WELLBUILT_ADMIN_CLAIM]: true,
          });
          break;
        case 'verify_claim': {
          const after = await auth.getUser(subject);
          if ((after.customClaims ?? {})[WELLBUILT_ADMIN_CLAIM] !== true) {
            // Leave the record disabled: the state stays unusable and the
            // next retry resumes from here.
            throw new httpsV2.HttpsError('internal', 'claim_not_persisted');
          }
          break;
        }
        case 'enable_record':
          await db.doc(`${PLATFORM_ADMINS_COLLECTION}/${subject}`).set(
            { enabled: true, enabledAt: FieldValue.serverTimestamp(), policyVersion: ADMIN_POLICY_VERSION },
            { merge: true },
          );
          break;
        case 'mark_completed':
          await db.doc(BOOTSTRAP_STATE_DOC).set(
            {
              completed: true,
              completedAt: FieldValue.serverTimestamp(),
              completedByUid: subject,
              attempts: FieldValue.increment(1),
            },
            { merge: true },
          );
          break;
      }
      executed.push(step);
    }

    // Audit last, so it records a state that actually exists.
    await db.collection(ADMIN_AUDIT_COLLECTION).add(
      buildBootstrapAudit(
        { uid: subject, email, method: 'first_admin_bootstrap' },
        FieldValue.serverTimestamp(),
      ),
    );

    // The client must force an ID-token refresh: the claim is minted on the
    // Auth user, and the caller's current token predates it.
    return { ok: true as const, steps: executed, tokenRefreshRequired: true as const };
  },
);
