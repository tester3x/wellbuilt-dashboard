/**
 * Server-side passcode hashing using Node crypto.scrypt.
 * Never use client SHA-256 as a credential store or RTDB key for login.
 */
import * as crypto from 'crypto';

export const SCRYPT = {
  N: 16384,
  r: 8,
  p: 1,
  keyLen: 32,
} as const;

export interface ScryptRecord {
  algo: 'scrypt';
  saltB64: string;
  hashB64: string;
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

function scryptDerive(
  passcode: string,
  salt: Buffer,
  keyLen: number,
  opts: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passcode, salt, keyLen, { N: opts.N, r: opts.r, p: opts.p }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived as Buffer);
    });
  });
}

export function normalizeDisplayName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function hashPasscodeScrypt(passcode: string): Promise<ScryptRecord> {
  const salt = crypto.randomBytes(16);
  const derived = await scryptDerive(passcode, salt, SCRYPT.keyLen, SCRYPT);
  return {
    algo: 'scrypt',
    saltB64: salt.toString('base64'),
    hashB64: derived.toString('base64'),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keyLen: SCRYPT.keyLen,
  };
}

export async function verifyPasscodeScrypt(
  passcode: string,
  record: ScryptRecord,
): Promise<boolean> {
  if (!record || record.algo !== 'scrypt') return false;
  const salt = Buffer.from(record.saltB64, 'base64');
  const expected = Buffer.from(record.hashB64, 'base64');
  const derived = await scryptDerive(passcode, salt, record.keyLen, {
    N: record.N,
    r: record.r,
    p: record.p,
  });
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/** Legacy client algorithm — for forensic comparison only, never for new storage keys. */
export function legacySha256NamePasscode(displayName: string, passcode: string): string {
  const input = normalizeDisplayName(displayName) + passcode;
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export const PASSCODE_MIN_LEN = 6;
export const PASSCODE_MAX_LEN = 128;
export const NAME_MAX_LEN = 64;
export const COMPANY_MAX_LEN = 120;

export function validateRegistrationFields(input: {
  displayName?: string;
  passcode?: string;
  legalName?: string;
  companyName?: string;
}): { displayName: string; passcode: string; legalName?: string; companyName?: string } {
  const displayName = (input.displayName || '').trim();
  const passcode = input.passcode || '';
  const legalName = (input.legalName || '').trim();
  const companyName = (input.companyName || '').trim();

  if (!displayName || displayName.length > NAME_MAX_LEN) {
    throw new Error('invalid_display_name');
  }
  // Reject pure random short garbage that looks like bots (optional soft check)
  if (!/^[\p{L}\p{N} .'_-]{2,64}$/u.test(displayName)) {
    throw new Error('invalid_display_name_chars');
  }
  if (passcode.length < PASSCODE_MIN_LEN || passcode.length > PASSCODE_MAX_LEN) {
    throw new Error('invalid_passcode_length');
  }
  if (legalName && legalName.length > NAME_MAX_LEN) {
    throw new Error('invalid_legal_name');
  }
  if (companyName && companyName.length > COMPANY_MAX_LEN) {
    throw new Error('invalid_company_name');
  }
  return {
    displayName,
    passcode,
    legalName: legalName || undefined,
    companyName: companyName || undefined,
  };
}
