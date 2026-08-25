import { createHash } from 'crypto';
import { normalizePaperHtml } from './html';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function contentHashForHtml(html: string): string {
  return sha256Hex(normalizePaperHtml(html));
}
