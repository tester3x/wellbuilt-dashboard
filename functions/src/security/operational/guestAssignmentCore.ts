import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export type GuestStep = 'pending' | 'accepted' | 'declined' | 'arrived' | 'completed';
export type GuestAction = Exclude<GuestStep, 'pending'>;
export const GUEST_LINK_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export function createGuestToken(): { linkId: string; secret: string; tokenHash: string } {
  const linkId = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { linkId, secret, tokenHash: hashGuestToken(linkId, secret) };
}
export function hashGuestToken(linkId: string, secret: string): string {
  return createHash('sha256').update('wellbuilt-guest-v1\0').update(linkId).update('\0').update(secret).digest('hex');
}
export function parseGuestBearer(raw: unknown): { linkId: string; secret: string } | null {
  if (typeof raw !== 'string' || raw.length > 160) return null;
  const m = /^([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(raw);
  return m ? { linkId: m[1], secret: m[2] } : null;
}
export function matchesGuestToken(recordedHash: unknown, bearer: { linkId: string; secret: string }): boolean {
  if (typeof recordedHash !== 'string' || !/^[a-f0-9]{64}$/.test(recordedHash)) return false;
  return timingSafeEqual(Buffer.from(recordedHash, 'hex'), Buffer.from(hashGuestToken(bearer.linkId, bearer.secret), 'hex'));
}
export function guestLinkIsValid(link: unknown, root: unknown, nowMs: number): boolean {
  if (!link || !root || typeof link !== 'object' || typeof root !== 'object') return false;
  const l = link as Record<string, unknown>, r = root as Record<string, unknown>;
  return l.schemaVersion === 1 && l.companyId === r.companyId
    && l.deliveryId === r.deliveryId && l.dispatchId === r.dispatchId
    && l.externalDriverId === r.externalDriverId
    && l.revision === r.currentRevision && l.linkId === r.guestLinkId
    && r.assignmentState === 'active'
    && Number.isSafeInteger(l.expiresAtMs)
    && (l.expiresAtMs as number) > nowMs
    && (l.expiresAtMs as number) <= (l.createdAtMs as number) + GUEST_LINK_MAX_AGE_MS;
}
export function decideGuestAction(current: GuestStep, next: GuestAction): 'apply' | 'repeat' | 'deny' {
  if (current === next) return 'repeat';
  const paths: Record<GuestAction, GuestStep[]> = {
    accepted: ['pending'],
    declined: ['pending'],
    arrived: ['accepted'],
    completed: ['arrived'],
  };
  return paths[next].includes(current) ? 'apply' : 'deny';
}
