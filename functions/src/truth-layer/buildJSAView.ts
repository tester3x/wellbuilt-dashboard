import type { JSAEntryView, JSAView, SourceRef, SourceSystem } from './types';
import { normalizeLocationName } from './normalizeLocation';

export interface JSAWellInputEntry {
  name?: string;
  operator?: string;
  county?: string;
  jobType?: string;
  source?: string;
  addedAt?: string;
}

export interface JSALocationStampInputEntry {
  name?: string;
  type?: 'pickup' | 'dropoff';
  jobType?: string;
  stampedAt?: string;
  dispatchId?: string;
}

export type JSALocationInput = string | JSALocationStampInputEntry;

export interface BuildJSAViewInput {
  id?: string;
  driverHash?: string;
  driverName?: string;
  companyId?: string;
  date?: string;
  timestamp?: string;
  jsaCompleted?: boolean;
  pdfUrl?: string;
  signature?: string;
  signatureImage?: string | null;
  wells?: JSAWellInputEntry[];
  locations?: JSALocationInput[];
  locationStamps?: JSALocationStampInputEntry[];
  addedWells?: JSAWellInputEntry[];
  addedLocations?: string[];
  wellName?: string;
  location?: string;
  jobActivityName?: string;
  task?: string;
  jsaType?: string;
  sourceSystem?: SourceSystem;
  sourceRecordPath?: string;
}

interface PartialEntryAdd {
  name?: string;
  kind: JSAEntryView['kind'];
  pickupDropoffType?: 'pickup' | 'dropoff';
  activityLabel?: string;
  stampedAt?: string;
  dispatchId?: string;
  operator?: string;
  county?: string;
  sourceField: string;
  sourceSystem: SourceSystem;
}

function buildSourceRef(system: SourceSystem, field: string, path?: string): SourceRef {
  const ref: SourceRef = { system, field };
  if (path !== undefined) ref.path = path;
  return ref;
}

export function buildJSAView(input: BuildJSAViewInput): JSAView {
  const system: SourceSystem = input.sourceSystem ?? 'async_storage';
  const path = input.sourceRecordPath;

  const jsaKey =
    input.id
      ? `jsa:${input.id}`
      : input.driverHash && input.date
      ? `jsa:${input.driverHash}:${input.date}`
      : input.date
      ? `jsa:unknown:${input.date}`
      : 'jsa:unknown';

  const entries = new Map<string, JSAEntryView>();

  const add = (raw: PartialEntryAdd) => {
    const name = raw.name?.trim();
    if (!name) return;
    const normalizedName = normalizeLocationName(name);
    if (!normalizedName) return;
    const existing = entries.get(normalizedName);
    const srcRef = buildSourceRef(raw.sourceSystem, raw.sourceField, path);
    if (existing) {
      const mergedActivity = existing.activityLabel ?? raw.activityLabel;
      const updated: JSAEntryView = {
        ...existing,
        pickupDropoffType: existing.pickupDropoffType ?? raw.pickupDropoffType,
        activityLabel: mergedActivity,
        stampedAt: existing.stampedAt ?? raw.stampedAt,
        dispatchId: existing.dispatchId ?? raw.dispatchId,
        operator: existing.operator ?? raw.operator,
        county: existing.county ?? raw.county,
        sourceRefs: [...existing.sourceRefs, srcRef],
        hasActivityBinding: !!(mergedActivity && mergedActivity.trim()),
      };
      entries.set(normalizedName, updated);
      return;
    }
    const entry: JSAEntryView = {
      entryKey: `entry:${normalizedName}`,
      name,
      normalizedName,
      kind: raw.kind,
      sourceRefs: [srcRef],
      hasActivityBinding: !!(raw.activityLabel && raw.activityLabel.trim()),
    };
    if (raw.pickupDropoffType !== undefined) entry.pickupDropoffType = raw.pickupDropoffType;
    if (raw.activityLabel !== undefined) entry.activityLabel = raw.activityLabel;
    if (raw.stampedAt !== undefined) entry.stampedAt = raw.stampedAt;
    if (raw.dispatchId !== undefined) entry.dispatchId = raw.dispatchId;
    if (raw.operator !== undefined) entry.operator = raw.operator;
    if (raw.county !== undefined) entry.county = raw.county;
    entries.set(normalizedName, entry);
  };

  for (const w of input.wells ?? []) {
    add({
      name: w.name,
      kind: 'well',
      activityLabel: w.jobType,
      operator: w.operator,
      county: w.county,
      sourceField: 'wells[]',
      sourceSystem: system,
    });
  }

  for (const loc of input.locations ?? []) {
    if (typeof loc === 'string') {
      add({ name: loc, kind: 'location', sourceField: 'locations[]', sourceSystem: system });
    } else if (loc && typeof loc === 'object') {
      add({
        name: loc.name,
        kind: 'stamp',
        pickupDropoffType: loc.type,
        activityLabel: loc.jobType,
        stampedAt: loc.stampedAt,
        dispatchId: loc.dispatchId,
        sourceField: 'locations[]',
        sourceSystem: system,
      });
    }
  }

  for (const s of input.locationStamps ?? []) {
    add({
      name: s.name,
      kind: 'stamp',
      pickupDropoffType: s.type,
      activityLabel: s.jobType,
      stampedAt: s.stampedAt,
      dispatchId: s.dispatchId,
      sourceField: 'locationStamps[]',
      sourceSystem: system,
    });
  }

  for (const w of input.addedWells ?? []) {
    add({
      name: w.name,
      kind: 'well',
      activityLabel: w.jobType,
      operator: w.operator,
      county: w.county,
      sourceField: 'addedWells[]',
      sourceSystem: system,
    });
  }

  for (const loc of input.addedLocations ?? []) {
    add({
      name: loc,
      kind: 'location',
      sourceField: 'addedLocations[]',
      sourceSystem: system,
    });
  }

  if (input.wellName) {
    add({ name: input.wellName, kind: 'legacy', sourceField: 'wellName', sourceSystem: system });
  }
  if (input.location) {
    add({ name: input.location, kind: 'legacy', sourceField: 'location', sourceSystem: system });
  }

  const sortedEntries = Array.from(entries.values()).sort((a, b) =>
    a.normalizedName.localeCompare(b.normalizedName)
  );

  const jsaSourceRef: SourceRef = { system, field: 'record' };
  if (path !== undefined) jsaSourceRef.path = path;
  if (input.id !== undefined) jsaSourceRef.recordId = input.id;

  const view: JSAView = {
    jsaKey,
    entries: sortedEntries,
    sourceRefs: [jsaSourceRef],
  };
  if (input.driverHash) view.operatorKey = `op:${input.driverHash}`;
  if (input.date) view.localDate = input.date;
  if (input.timestamp) {
    const d = new Date(input.timestamp);
    if (!isNaN(d.getTime())) view.utcDate = d.toISOString().slice(0, 10);
  }
  if (input.jsaCompleted !== undefined) view.completed = input.jsaCompleted;
  if (input.pdfUrl !== undefined) view.pdfUrl = input.pdfUrl;
  if (input.signature !== undefined) view.signatureName = input.signature;
  view.signatureImagePresent = !!input.signatureImage;
  return view;
}
