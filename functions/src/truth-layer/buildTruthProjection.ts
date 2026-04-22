import type {
  ActivityRef,
  JSAView,
  LocationRef,
  OperationalEvent,
  OperatorRef,
  ReportingWindow,
  Session,
  TruthProjection,
} from './types';
import { mergeOperatorRefs, resolveOperatorRef } from './normalizeOperator';
import {
  LocationCatalog,
  mergeLocationRefs,
  resolveLocationRef,
} from './normalizeLocation';
import { mergeActivityRefs, resolveActivityRef } from './normalizeActivity';
import { buildSessionView, ShiftDocInput } from './buildSessionView';
import { buildReportingWindows } from './buildReportingWindows';
import { buildJSAView, BuildJSAViewInput } from './buildJSAView';
import {
  DispatchInput,
  ExtractEventsInput,
  extractOperationalEvents,
  InvoiceInput,
  ProductionInput,
} from './extractOperationalEvents';

export interface BuildTruthProjectionInput {
  drivers?: unknown[];
  shifts?: ShiftDocInput[];
  invoices?: InvoiceInput[];
  dispatches?: DispatchInput[];
  jsas?: BuildJSAViewInput[];
  packets?: Array<{ driverId?: string; driverName?: string; wellName?: string }>;
  production?: ProductionInput[];
  catalog?: LocationCatalog;
  timezone?: string;
  additionalReferenceDates?: string[];
}

function pushIfPresent<T>(arr: T[], v: T | null | undefined): void {
  if (v) arr.push(v);
}

export function buildTruthProjection(
  input: BuildTruthProjectionInput
): TruthProjection {
  const operators: OperatorRef[] = [];
  const locations: LocationRef[] = [];
  const activities: ActivityRef[] = [];
  const jsaViews: JSAView[] = [];
  const referenceDates: string[] = [];

  for (const d of input.drivers ?? []) {
    pushIfPresent(
      operators,
      resolveOperatorRef(d, {
        sourceRef: { system: 'rtdb', path: 'drivers/approved', field: 'record' },
      })
    );
  }

  for (const s of input.shifts ?? []) {
    pushIfPresent(
      operators,
      resolveOperatorRef(s, {
        sourceRef: {
          system: 'firestore',
          path: 'driver_shifts',
          field: 'driverId',
        },
      })
    );
    for (const e of s.events ?? []) {
      if (e.timestamp) referenceDates.push(e.timestamp);
    }
  }

  for (const inv of input.invoices ?? []) {
    pushIfPresent(
      operators,
      resolveOperatorRef(inv, {
        sourceRef: { system: 'firestore', path: 'invoices', field: 'driver' },
      })
    );
    if (inv.wellName) {
      pushIfPresent(
        locations,
        resolveLocationRef({
          name: inv.wellName,
          kind: 'well',
          sourceRef: { system: 'firestore', path: 'invoices', field: 'wellName' },
          catalog: input.catalog,
        })
      );
    }
    if (inv.hauledTo) {
      pushIfPresent(
        locations,
        resolveLocationRef({
          name: inv.hauledTo,
          pickupDropoffHint: 'dropoff',
          sourceRef: { system: 'firestore', path: 'invoices', field: 'hauledTo' },
          catalog: input.catalog,
        })
      );
    }
    if (inv.commodityType) {
      pushIfPresent(
        activities,
        resolveActivityRef({
          commodityType: inv.commodityType,
          sourceRef: {
            system: 'firestore',
            path: 'invoices',
            field: 'commodityType',
          },
          sourceSystem: 'firestore',
        })
      );
    }
    for (const t of inv.timeline ?? []) {
      if (t.timestamp) referenceDates.push(t.timestamp);
    }
  }

  for (const disp of input.dispatches ?? []) {
    pushIfPresent(
      operators,
      resolveOperatorRef(disp, {
        sourceRef: {
          system: 'firestore',
          path: 'dispatches',
          field: 'driverHash',
        },
      })
    );
    const wellName = disp.wellName ?? disp.ndicWellName;
    if (wellName) {
      pushIfPresent(
        locations,
        resolveLocationRef({
          name: wellName,
          kind: 'well',
          sourceRef: {
            system: 'firestore',
            path: 'dispatches',
            field: 'wellName',
          },
          catalog: input.catalog,
        })
      );
    }
    const disposalName = disp.disposal ?? disp.disposalName;
    if (disposalName) {
      pushIfPresent(
        locations,
        resolveLocationRef({
          name: disposalName,
          kind: 'disposal',
          sourceRef: {
            system: 'firestore',
            path: 'dispatches',
            field: 'disposal',
          },
          catalog: input.catalog,
        })
      );
    }
    if (disp.jobType || disp.commodityType) {
      pushIfPresent(
        activities,
        resolveActivityRef({
          jobType: disp.jobType,
          commodityType: disp.commodityType,
          sourceRef: { system: 'firestore', path: 'dispatches', field: 'jobType' },
          sourceSystem: 'firestore',
        })
      );
    }
    const ts =
      disp.completedAt ?? disp.stageUpdatedAt ?? disp.updatedAt ?? disp.assignedAt;
    if (ts) referenceDates.push(ts);
  }

  for (const jsaInput of input.jsas ?? []) {
    const view = buildJSAView(jsaInput);
    jsaViews.push(view);
    pushIfPresent(
      operators,
      resolveOperatorRef(jsaInput, {
        sourceRef: {
          system: jsaInput.sourceSystem ?? 'firestore',
          path: jsaInput.sourceRecordPath ?? 'jsa_day_status',
          field: 'driverHash',
        },
      })
    );
    for (const entry of view.entries) {
      pushIfPresent(
        locations,
        resolveLocationRef({
          name: entry.name,
          kind: entry.kind === 'well' ? 'well' : undefined,
          operator: entry.operator,
          county: entry.county,
          pickupDropoffHint: entry.pickupDropoffType,
          sourceRef: {
            system: jsaInput.sourceSystem ?? 'firestore',
            path: jsaInput.sourceRecordPath ?? 'jsa_day_status',
            field: entry.kind === 'well' ? 'wells[]' : 'locations[]',
          },
          catalog: input.catalog,
        })
      );
      if (entry.activityLabel) {
        pushIfPresent(
          activities,
          resolveActivityRef({
            perWellJobType: entry.activityLabel,
            sourceRef: {
              system: jsaInput.sourceSystem ?? 'firestore',
              path: jsaInput.sourceRecordPath ?? 'jsa_day_status',
              field: 'wells[].jobType',
            },
            sourceSystem: jsaInput.sourceSystem ?? 'firestore',
          })
        );
      }
      if (entry.stampedAt) referenceDates.push(entry.stampedAt);
    }
    if (jsaInput.jobActivityName || jsaInput.task) {
      pushIfPresent(
        activities,
        resolveActivityRef({
          jobActivityName: jsaInput.jobActivityName,
          task: jsaInput.task,
          sourceRef: {
            system: jsaInput.sourceSystem ?? 'firestore',
            path: jsaInput.sourceRecordPath ?? 'jsa_day_status',
            field: 'jobActivityName',
          },
          sourceSystem: jsaInput.sourceSystem ?? 'firestore',
        })
      );
    }
    if (jsaInput.timestamp) referenceDates.push(jsaInput.timestamp);
  }

  for (const p of input.packets ?? []) {
    pushIfPresent(
      operators,
      resolveOperatorRef(p, {
        sourceRef: {
          system: 'rtdb',
          path: 'packets/processed',
          field: 'driverId',
        },
      })
    );
    if (p.wellName) {
      pushIfPresent(
        locations,
        resolveLocationRef({
          name: p.wellName,
          kind: 'well',
          sourceRef: {
            system: 'rtdb',
            path: 'packets/processed',
            field: 'wellName',
          },
          catalog: input.catalog,
        })
      );
    }
  }

  for (const prod of input.production ?? []) {
    if (prod.wellName) {
      pushIfPresent(
        locations,
        resolveLocationRef({
          name: prod.wellName,
          kind: 'well',
          sourceRef: {
            system: 'rtdb',
            path: 'production',
            field: 'wellName',
          },
          catalog: input.catalog,
        })
      );
    }
    if (prod.updatedAt) referenceDates.push(prod.updatedAt);
    if (prod.date) referenceDates.push(`${prod.date}T06:00:00Z`);
  }

  for (const d of input.additionalReferenceDates ?? []) {
    referenceDates.push(d);
  }

  for (const entry of input.catalog?.ndic ?? []) {
    pushIfPresent(
      locations,
      resolveLocationRef({
        name: entry.name,
        kind: 'well',
        operator: entry.operator,
        county: entry.county,
        apiNo: entry.apiNo,
        lat: entry.lat,
        lng: entry.lng,
        sourceRef: { system: 'firestore', path: 'wells', field: 'ndic' },
        catalog: input.catalog,
      })
    );
  }

  const mergedOperators = mergeOperatorRefs(operators);
  const mergedLocations = mergeLocationRefs(locations);
  const mergedActivities = mergeActivityRefs(activities);

  const sessions: Session[] = buildSessionView({
    shifts: input.shifts ?? [],
  });

  const reportingWindows: ReportingWindow[] = buildReportingWindows({
    referenceDates,
    timezone: input.timezone,
  });

  const eventsInput: ExtractEventsInput = {};
  if (input.shifts) eventsInput.shifts = input.shifts;
  if (input.invoices) eventsInput.invoices = input.invoices;
  if (input.dispatches) eventsInput.dispatches = input.dispatches;
  if (input.jsas) eventsInput.jsas = input.jsas;
  if (input.production) eventsInput.production = input.production;
  const events: OperationalEvent[] = extractOperationalEvents(eventsInput);

  const jsaViewsSorted = [...jsaViews].sort((a, b) =>
    a.jsaKey.localeCompare(b.jsaKey)
  );

  return {
    operators: mergedOperators,
    sessions,
    reportingWindows,
    locations: mergedLocations,
    activities: mergedActivities,
    jsaViews: jsaViewsSorted,
    events,
  };
}
