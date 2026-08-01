/**
 * Narrow pre-login metadata endpoint — no tenant operational data.
 * Intentionally public catalog only (app branding flags, version gates).
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

export const getPublicClientMeta = httpsV2.onCall(
  { timeoutSeconds: 15, memory: '256MiB', enforceAppCheck: false },
  async () => {
    // Minimal public surface — no companies, wells, drivers
    let appRegistry: { id: string; name?: string; public?: boolean }[] = [];
    try {
      const snap = await admin.firestore().collection('app_registry').limit(30).get();
      appRegistry = snap.docs.map((d) => {
        const data = d.data() || {};
        return {
          id: d.id,
          name: typeof data.name === 'string' ? data.name : d.id,
          // Only non-sensitive display fields
          public: true,
          icon: data.icon || null,
          scheme: data.scheme || null,
        };
      });
    } catch {
      appRegistry = [];
    }
    return {
      projectId: process.env.GCLOUD_PROJECT || 'wellbuilt-sync',
      minSecureClientSchema: 1,
      appRegistryPublic: appRegistry,
      // Clients use this to know dual-run vs enforce modes after config flip
      secureAuthRequired: process.env.REQUIRE_DRIVER_CLAIMS === 'true',
      appCheckEnforced: process.env.SECURITY_ENFORCE_APPCHECK === 'true',
    };
  },
);
