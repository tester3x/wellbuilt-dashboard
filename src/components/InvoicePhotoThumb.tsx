'use client';

import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from '@/lib/firebase';
import { photoDisplayRef, preserveAuthorizedPhotoUrl, type PhotoRef } from '@/lib/photoDisplay';

const cache = new Map<string, { url: string; expiresAt: number }>();

export function InvoicePhotoThumb({
  invoiceId,
  photo,
  alt,
  className,
}: {
  invoiceId: string;
  photo: PhotoRef & { photoId?: string };
  alt: string;
  className?: string;
}) {
  const ref = photoDisplayRef(photo);
  const [url, setUrl] = useState<string | null>(
    ref.kind === 'signed_or_absolute' ? preserveAuthorizedPhotoUrl(ref.url) : null,
  );

  useEffect(() => {
    if (ref.kind !== 'canonical') return;
    const key = `${invoiceId}:${photo.photoId || ref.path}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now() + 5000) {
      setUrl(preserveAuthorizedPhotoUrl(hit.url));
      return;
    }
    let cancelled = false;
    (async () => {
      const fn = httpsCallable(getFirebaseFunctions(), 'issueStorageReadUrl');
      const res: any = await fn({
        invoiceId,
        photoId: photo.photoId || undefined,
        path: ref.path,
        bucket: ref.bucket,
      });
      const signed = preserveAuthorizedPhotoUrl(String(res?.data?.readUrl || ''));
      const expiresAt = typeof res?.data?.expiresAt === 'number' ? res.data.expiresAt : Date.now() + 60_000;
      if (!cancelled && signed) {
        cache.set(key, { url: signed, expiresAt });
        setUrl(signed);
      }
    })().catch(() => {
      if (!cancelled) setUrl(null);
    });
    return () => {
      cancelled = true;
    };
  }, [invoiceId, photo.photoId, ref.kind === 'canonical' ? ref.path : '', ref.kind]);

  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      <img src={url} alt={alt} className={className} />
    </a>
  );
}
