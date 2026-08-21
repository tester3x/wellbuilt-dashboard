/**
 * Production rate limiter. Counter mutation is a single RTDB transaction
 * using nextRateWindow so concurrent callers cannot both increment past N.
 */
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { nextRateWindow, type RateWindow } from './rateLimitTxn';

const db = () => admin.database();

export async function checkRateLimit(opts: {
  bucket: string;
  key: string;
  limit: number;
  windowMs: number;
}): Promise<boolean> {
  const path = `security/rate_limit/${opts.bucket}/${sanitizeKey(opts.key)}`;
  const ref = db().ref(path);
  const now = Date.now();
  const result = await ref.transaction((cur: RateWindow | null) => {
    return nextRateWindow(cur, now, opts.windowMs, opts.limit).next;
  });
  if (!result.committed) return false;
  const next = result.snapshot.val() as RateWindow | null;
  if (!next) return false;
  return next.count <= opts.limit;
}

export async function checkRateLimitDecision(opts: {
  bucket: string;
  key: string;
  limit: number;
  windowMs: number;
  nowMs?: number;
  runTransaction?: (fn: (cur: RateWindow | null) => RateWindow) => Promise<RateWindow>;
}): Promise<boolean> {
  const now = opts.nowMs ?? Date.now();
  if (opts.runTransaction) {
    const next = await opts.runTransaction((cur) => nextRateWindow(cur, now, opts.windowMs, opts.limit).next);
    return next.count <= opts.limit;
  }
  return checkRateLimit(opts);
}

function sanitizeKey(k: string): string {
  return k.replace(/[.#$\[\]/]/g, '_').slice(0, 120);
}

export function hashIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

export { nextRateWindow } from './rateLimitTxn';
