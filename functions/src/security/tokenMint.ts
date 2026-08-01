/**
 * Mint Firebase Auth session tokens for a driver.
 * Prefers createCustomToken; falls back to email/password exchange when the
 * runtime service account lacks iam.serviceAccounts.signBlob (common on GCF
 * default compute SA until Token Creator is granted).
 */
import * as crypto from 'crypto';
import * as admin from 'firebase-admin';

const WEB_API_KEY =
  process.env.FIREBASE_WEB_API_KEY || 'AIzaSyAGWXa-doFGzo7T5SxHVD_v5-SHXIc8wAI';

export function driverAuthUid(driverId: string): string {
  return `driver_${driverId.replace(/-/g, '').slice(0, 28)}`;
}

export function driverAuthEmail(driverId: string): string {
  // Synthetic mailbox — not for human mail; used only for Auth password exchange fallback
  const id = driverId.replace(/-/g, '').toLowerCase();
  return `drv_${id.slice(0, 28)}@drivers.wellbuilt-sync.local`;
}

export interface MintedDriverTokens {
  customToken?: string;
  idToken?: string;
  refreshToken?: string;
  authUid: string;
  mintMethod: 'custom_token' | 'password_exchange';
}

export async function ensureDriverAuthUser(
  driverId: string,
  displayName: string,
): Promise<string> {
  const authUid = driverAuthUid(driverId);
  const email = driverAuthEmail(driverId);
  try {
    await admin.auth().getUser(authUid);
    try {
      await admin.auth().updateUser(authUid, { email, displayName, emailVerified: true });
    } catch {
      /* email may already be taken — ignore */
    }
  } catch {
    await admin.auth().createUser({
      uid: authUid,
      email,
      emailVerified: true,
      displayName,
      disabled: false,
    });
  }
  return authUid;
}

export async function mintDriverSessionTokens(
  authUid: string,
  claims: Record<string, unknown>,
): Promise<MintedDriverTokens> {
  await admin.auth().setCustomUserClaims(authUid, claims);

  try {
    const customToken = await admin.auth().createCustomToken(authUid, claims);
    return { customToken, authUid, mintMethod: 'custom_token' };
  } catch (err: any) {
    const msg = String(err?.message || err || '');
    if (!/signBlob|insufficient-permission|create-custom-tokens/i.test(msg)) {
      throw err;
    }
    console.warn(
      '[tokenMint] createCustomToken unavailable (signBlob); using password-exchange fallback',
    );
  }

  const email = (await admin.auth().getUser(authUid)).email || undefined;
  if (!email) {
    throw new Error('password-exchange requires auth user email');
  }
  const tempPassword = crypto.randomBytes(24).toString('base64url') + 'Aa1!';
  await admin.auth().updateUser(authUid, { password: tempPassword });

  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: tempPassword,
      returnSecureToken: true,
    }),
  });
  const body: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(body?.error?.message || `password-exchange failed (${resp.status})`);
  }

  try {
    await admin.auth().updateUser(authUid, {
      password: crypto.randomBytes(32).toString('base64url') + 'Zz9!',
    });
  } catch {
    /* non-fatal */
  }

  return {
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    authUid,
    mintMethod: 'password_exchange',
  };
}
