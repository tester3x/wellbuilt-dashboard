import { createHash } from 'crypto';

export function sha256Utf8(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

export function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Hash the exact bytes that were or will be stored. Do not normalize. */
export function hashExactBytes(bytes: Buffer): string {
  return sha256Bytes(bytes);
}

export function utf8Bytes(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}
