'use client';

import { useMemo, useRef, useState } from 'react';

/**
 * Body displays stored canonical HTML only.
 * Chrome: close, scroll, zoom, print, share.
 * No document-layout JSX and no live-field rebuild.
 */
interface Props {
  html: string;
  contentHash?: string;
  displayNumber?: string;
  onClose?: () => void;
  embedded?: boolean;
}

export function CanonicalPaperViewer({ html, contentHash, displayNumber, onClose, embedded }: Props) {
  const [zoom, setZoom] = useState(1);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(() => html, [html]);

  function printStored() {
    const frame = frameRef.current;
    frame?.contentWindow?.focus();
    frame?.contentWindow?.print();
  }

  async function shareStored() {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const file = new File([blob], `water-ticket-${displayNumber || 'document'}.html`, { type: 'text/html' });
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void>; canShare?: (d: ShareData) => boolean };
    if (nav.share && (!nav.canShare || nav.canShare({ files: [file] }))) {
      try {
        await nav.share({ title: `Water Ticket ${displayNumber || ''}`.trim(), files: [file] });
        return;
      } catch {
        /* fall through to download */
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={embedded ? 'flex flex-col min-h-[480px]' : 'flex flex-col'}>
      <div className="flex items-center justify-between px-3 py-2 bg-gray-900 text-gray-200 text-xs gap-2">
        {onClose ? (
          <button type="button" onClick={onClose} className="text-gray-300 hover:text-white">
            Back
          </button>
        ) : <span />}
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setZoom((z) => Math.max(0.75, +(z - 0.25).toFixed(2)))} className="px-2 py-1 bg-gray-800 rounded">−</button>
          <span className="tabular-nums w-12 text-center">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom((z) => Math.min(1.75, +(z + 0.25).toFixed(2)))} className="px-2 py-1 bg-gray-800 rounded">+</button>
          <button type="button" onClick={printStored} className="px-2 py-1 bg-gray-800 rounded">Print</button>
          <button type="button" onClick={() => void shareStored()} className="px-2 py-1 bg-gray-800 rounded">Share</button>
        </div>
      </div>
      <div className="bg-gray-700 overflow-auto" style={{ minHeight: embedded ? 480 : 640 }}>
        <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}>
          <iframe
            ref={frameRef}
            title={displayNumber ? `Water Ticket ${displayNumber}` : 'Canonical paper'}
            sandbox=""
            srcDoc={srcDoc}
            className="w-full bg-white border-0"
            style={{ height: 1000, minHeight: 1000 }}
          />
        </div>
      </div>
      {contentHash ? (
        <div className="px-3 py-1 text-[10px] text-gray-500 font-mono truncate">rev {contentHash.slice(0, 12)}</div>
      ) : null}
    </div>
  );
}
