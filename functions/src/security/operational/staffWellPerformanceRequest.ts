export function requestedAdminWellName(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const raw = (data as { wellName?: unknown }).wellName;
  if (typeof raw !== 'string') return null;
  const wellName = raw.trim();
  return wellName || null;
}
