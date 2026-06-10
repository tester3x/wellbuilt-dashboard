'use client';

import React from 'react';

/**
 * Single source of truth for rendering a job's photo strip + AI photo-compliance
 * status on the dashboard's paper-invoice surfaces. Used by BOTH the WB Tickets
 * detail modal AND the Dispatch completed-job card so the two never diverge
 * again (they were duplicated copies before — one had compliance badges, one
 * didn't). Paper-light palette (#FAFAF8 background).
 *
 * Renders the "PHOTOS (n)" header + a horizontal strip of image thumbnails
 * (each with location label + compliance badge/reason) followed by JSA tiles.
 *
 * Photos carry compliance only when captured under AI advisory mode; plain and
 * legacy photos simply render without a badge.
 */

type Size = 'sm' | 'md';

type Props = {
  photos: any[] | undefined | null;
  /** 'md' (default) for the full ticket modal, 'sm' for the narrower dispatch card. */
  size?: Size;
};

function rewriteStorageUrl(u: string): string {
  // firebasestorage.googleapis.com has DNS issues — storage.googleapis.com/{bucket}/{path} is reliable.
  if (u && u.includes('firebasestorage.googleapis.com')) {
    const m = u.match(/\/o\/(.+?)(\?|$)/);
    const bucketM = u.match(/\/b\/([^/]+)\//);
    if (m && bucketM) return `https://storage.googleapis.com/${bucketM[1]}/${decodeURIComponent(m[1])}`;
  }
  return u;
}

export function CompliancePhotoStrip({ photos, size = 'md' }: Props) {
  if (!photos || photos.length === 0) return null;

  const imagePhotos: any[] = [];
  const jsaPhotos: any[] = [];
  for (const p of photos) {
    const t = typeof p === 'object' ? p?.type : '';
    if (t === 'jsa') jsaPhotos.push(p); else imagePhotos.push(p);
  }

  const thumb = size === 'sm' ? 'w-16 h-16' : 'w-20 h-20';
  const labelMax = size === 'sm' ? 'max-w-[64px]' : 'max-w-[80px]';
  const badgeW = size === 'sm' ? 'w-16' : 'w-20';
  const jsaIcon = size === 'sm' ? 'w-7 h-7' : 'w-8 h-8';

  return (
    <>
      <h4 className="text-[#111] font-extrabold text-xs tracking-[1.5px] uppercase pt-4 pb-2">
        PHOTOS ({imagePhotos.length}){jsaPhotos.length > 0 ? ' + JSA' : ''}
      </h4>
      <div className="flex gap-2 overflow-x-auto pb-2">
        {imagePhotos.map((photo: any, i: number) => {
          const raw = typeof photo === 'string' ? photo : photo?.uri;
          if (!raw) return null;
          const url = rewriteStorageUrl(raw);
          const loc = typeof photo === 'object' ? photo?.location : '';
          const photoType = typeof photo === 'object' ? photo?.type : '';
          // AI photo compliance (v1) — audit visibility: "why was this accepted?"
          const c = typeof photo === 'object' ? photo?.compliance : null;
          const reqId = typeof photo === 'object' ? photo?.requirementId : null;
          const cOverridden = c?.overrideUsed === true;
          const cPending = c?.status === 'pending';
          const cReview = c?.outcome === 'review' || (c?.status === 'pass' && c?.redFlag === true);
          const cBadgeText = cOverridden ? 'Override Used' : cPending ? 'Pending' : cReview ? 'Review' : 'Verified';
          // Light-paper palette (surface is #FAFAF8, not a dark theme).
          const cBadgeCls = (cOverridden || cReview) ? 'bg-amber-100 text-amber-800 border border-amber-300'
            : cPending ? 'bg-gray-100 text-gray-600 border border-gray-300'
            : 'bg-green-100 text-green-800 border border-green-300';
          return (
            <div key={`img-${i}`} className="flex-shrink-0 text-center" onClick={(e) => e.stopPropagation()}>
              <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                <img src={url} alt={`Photo ${i + 1}`} className={`${thumb} object-cover rounded border border-gray-300 hover:border-yellow-500 transition-colors cursor-pointer`} />
              </a>
              {loc && <p className={`text-[9px] text-gray-400 mt-0.5 ${labelMax} truncate`}>{photoType === 'pickup' ? '📍' : '📦'} {loc}</p>}
              {reqId && c && (
                <div className={`mt-0.5 ${badgeW} mx-auto`}>
                  <span className={`inline-block px-1 py-0.5 rounded text-[8px] font-bold ${cBadgeCls}`}>{cBadgeText}</span>
                  {(cOverridden || cReview) && c?.reason && (
                    <p className="text-[8px] text-gray-600 mt-0.5 leading-tight text-left">{c.reason}</p>
                  )}
                  {cOverridden && c?.overrideAt && (
                    <p className="text-[8px] text-amber-700 mt-0.5 text-left">Kept {new Date(c.overrideAt).toLocaleString()}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {jsaPhotos.map((photo: any, i: number) => {
          const raw = typeof photo === 'string' ? photo : photo?.uri;
          if (!raw) return null;
          const url = rewriteStorageUrl(raw);
          return (
            <div key={`jsa-${i}`} className="flex-shrink-0 text-center" onClick={(e) => e.stopPropagation()}>
              <a href={url} target="_blank" rel="noopener noreferrer" title="Open Job Safety Analysis PDF" onClick={(e) => e.stopPropagation()}>
                <div className={`${thumb} rounded border-2 border-yellow-500 bg-yellow-50 hover:bg-yellow-100 transition-colors cursor-pointer flex flex-col items-center justify-center`}>
                  <svg className={`${jsaIcon} text-yellow-700`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  <span className="text-[9px] font-bold text-yellow-700 mt-0.5 tracking-wider">JSA</span>
                </div>
              </a>
              <p className="text-[8px] text-yellow-700 mt-0.5 font-semibold">Tap to open</p>
            </div>
          );
        })}
      </div>
    </>
  );
}
