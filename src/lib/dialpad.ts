/** Open the installed Dialpad app with an explicit confirmation before calling. */
export function dialpadCallHref(phone: string | undefined, jobId?: string, fromNumber?: string): string | null {
  if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) return null;
  const context = jobId && /^[A-Za-z0-9_-]{1,100}$/.test(jobId) ? `&customData=${encodeURIComponent(`wellbuilt-independent:${jobId}`)}` : '';
  const caller = fromNumber && /^\+[1-9]\d{7,14}$/.test(fromNumber) ? `&fromNumber=${encodeURIComponent(fromNumber)}` : '';
  return `dialpad://${phone}?confirmPhone=1${caller}${context}`;
}
