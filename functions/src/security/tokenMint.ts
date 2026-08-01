/**
 * Mint Firebase Auth session tokens for a driver.
 *
 * Primary: createCustomToken (requires runtime SA has
 * roles/iam.serviceAccountTokenCreator on itself for signBlob).
 *
 * Password-exchange fallback is DISABLED by default after IAM fix.
 * Set ALLOW_PASSWORD_EXCHANGE_FALLBACK=true only for emergency rollback.
 */
import * as crypto from 'crypto';
import * as admin from 'firebase-admin';

const WEB_API_KEY =
  process.env.FIREBASE_WEB_API_KEY || 'AIzaSyAGWXa-doFGzo7T5SxHVD_v5-SHXIc8wAI';

/** Emergency only — default false/off. */
export function isPasswordExchangeFallbackAllowed(): boolean {
  return process.env.ALLOW_PASSWORD_EXCHANGE_FALLBACK === 'true';
}

export function driverAuthUid(driverId: string): string {
  return `driver_${driverId.replace(/-/g, '').slice(0, 28)}`;
}

export function driverAuthEmail(driverId: string): string {
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
      /* ignore email conflicts */
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

/**
 * Invalidate residual password material on synthetic driver Auth users
 * (random unusable password). Does not delete the Auth identity.
 */
export async function invalidateSyntheticPassword(authUid: string): Promise<void> {
  const junk = crypto.randomBytes(32).toString('base64url') + 'Xx9!';
  try {
    await admin.auth().updateUser(authUid, { password: junk });
  } catch {
    /* user may not exist */
  }
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
    const isSignBlob =
      /signBlob|insufficient-permission|create-custom-tokens/i.test(msg);
    if (!isSignBlob || !isPasswordExchangeFallbackAllowed()) {
      // Surface clearly — do not silently mint passwords when fallback is off
      throw err;
    }
    console.warn(
      '[tokenMint] ALLOW_PASSWORD_EXCHANGE_FALLBACK=true: using password-exchange (audit mintMethod)',
    );
  }

  // --- Emergency fallback only (disabled by default) ---
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

  // Invalidate temp password immediately
  await invalidateSyntheticPassword(authUid);

  return {
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    authUid,
    mintMethod: 'password_exchange',
  };
}
