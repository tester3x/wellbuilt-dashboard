/**
 * governedProfileCore — PURE extraction of the pre-binding governed job-type
 * profile from a published packet revision.
 *
 * Used by getDriverReferenceBundle to expose, BEFORE any job/dispatch exists,
 * the current published governed per-job-type capability matrix so field apps
 * (WB-T) can gate execution variants (e.g. planned Split Tickets) on governed
 * authority — never on the V9 job_packages catalog and never on label inference.
 *
 * PURE: no imports, no I/O. Fails closed (returns null) on anything unpublished,
 * cross-tenant, or malformed. Never trusts client-supplied capabilities.
 *
 * NOTE (lifecycle profile): the current revision schema has NO per-job-type
 * lifecycle-shape field (on-site-only vs pickup-dropoff). This core is designed
 * to be extended additively when that field is published — see extractJobTypes.
 */

export interface GovernedJobTypeProfile {
  jobTypeId: string;
  label: string;
  capabilities: string[];
  /** Present only once the governed revision schema publishes it. Additive. */
  lifecycleProfile?: string;
}

export interface GovernedPackageProfile {
  packageId: string;
  packetRevision: number;
  contentHash: string;
  policyHash: string;
  jobTypes: GovernedJobTypeProfile[];
}

/**
 * Reconstruct the published revision doc id from the package-index doc id + its
 * schemaVersion/latestRevision. Index `11.co.13.pkg` + schemaVersion 1 +
 * latestRevision 3 → `11.co.13.pkg.1.3`.
 */
export function revisionDocIdFromIndex(
  indexDocId: string,
  indexData: { schemaVersion?: unknown; latestRevision?: unknown } | null | undefined,
): string | null {
  const id = typeof indexDocId === 'string' ? indexDocId.trim() : '';
  const schemaVersion = Number(indexData?.schemaVersion);
  const latestRevision = Number(indexData?.latestRevision);
  if (!id || !Number.isInteger(schemaVersion) || !Number.isInteger(latestRevision)) return null;
  if (schemaVersion < 0 || latestRevision < 1) return null;
  return `${id}.${schemaVersion}.${latestRevision}`;
}

function capabilityIdsOf(entry: Record<string, unknown>): string[] {
  const caps = (entry as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(caps)) return [];
  const out: string[] = [];
  for (const c of caps) {
    // Published revisions carry capabilities as plain capability-id strings
    // (e.g. "splitTicket"). Also accept the { capabilityId } object form
    // defensively so either revision shape resolves identically.
    if (typeof c === 'string') {
      if (c.trim()) out.push(c.trim());
    } else if (c && typeof c === 'object' && !Array.isArray(c)) {
      const id = (c as Record<string, unknown>).capabilityId;
      if (typeof id === 'string' && id.trim()) out.push(id.trim());
    }
  }
  return out;
}

function extractJobTypes(revisionData: Record<string, unknown>): GovernedJobTypeProfile[] {
  const jts = (revisionData as { jobTypes?: unknown }).jobTypes;
  if (!Array.isArray(jts)) return [];
  const out: GovernedJobTypeProfile[] = [];
  for (const jt of jts) {
    if (!jt || typeof jt !== 'object' || Array.isArray(jt)) continue;
    const rec = jt as Record<string, unknown>;
    const jobTypeId = typeof rec.jobTypeId === 'string' ? rec.jobTypeId.trim() : '';
    if (!jobTypeId) continue;
    const label = typeof rec.label === 'string' ? rec.label : jobTypeId;
    // Additive: only surface a lifecycle profile once the schema actually publishes it.
    const lifecycle = typeof rec.lifecycleProfile === 'string' ? rec.lifecycleProfile.trim() : '';
    out.push({
      jobTypeId,
      label,
      capabilities: capabilityIdsOf(rec),
      ...(lifecycle ? { lifecycleProfile: lifecycle } : {}),
    });
  }
  return out;
}

/**
 * Build one governed package profile. Returns null (fail closed) unless the
 * revision is published, belongs to the caller's company, and has usable
 * job-type/hash data. `packetRevision` is taken from the index (the authority
 * for "current"), and cross-checked against the revision doc.
 */
export function buildGovernedPackageProfile(input: {
  companyId: string;
  indexDocId: string;
  indexData: Record<string, unknown> | null | undefined;
  revisionData: Record<string, unknown> | null | undefined;
}): GovernedPackageProfile | null {
  const companyId = typeof input.companyId === 'string' ? input.companyId.trim() : '';
  if (!companyId) return null;
  const ix = input.indexData;
  const rev = input.revisionData;
  if (!ix || typeof ix !== 'object' || !rev || typeof rev !== 'object') return null;

  // Never expose an unpublished revision.
  if ((rev as Record<string, unknown>).status !== 'published') return null;

  // Tenant containment — both index and revision must belong to the caller.
  if (typeof ix.companyId === 'string' && ix.companyId !== companyId) return null;
  if (typeof (rev as Record<string, unknown>).companyId === 'string'
    && (rev as Record<string, unknown>).companyId !== companyId) return null;

  const packageId = typeof ix.packageId === 'string' ? ix.packageId.trim() : '';
  if (!packageId) return null;

  const packetRevision = Number(ix.latestRevision);
  if (!Number.isInteger(packetRevision) || packetRevision < 1) return null;

  // The index's current revision must match the revision doc we read.
  const revNum = Number((rev as Record<string, unknown>).revision);
  if (Number.isInteger(revNum) && revNum !== packetRevision) return null;

  const contentHash = typeof ix.contentHash === 'string' ? ix.contentHash : '';
  const policyHash = typeof ix.policyHash === 'string' ? ix.policyHash : '';
  if (!contentHash || !policyHash) return null;

  const jobTypes = extractJobTypes(rev as Record<string, unknown>);
  if (jobTypes.length === 0) return null;

  return { packageId, packetRevision, contentHash, policyHash, jobTypes };
}
