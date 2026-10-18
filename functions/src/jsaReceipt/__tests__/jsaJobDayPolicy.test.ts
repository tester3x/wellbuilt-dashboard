import {
  handleRegister,
  handleComplete,
  handleGetContext,
  handleConsume,
  type ReceiptDeps,
} from "../jsaReceiptHandlers";
import {
  companyJsaDay,
  resolveJobDayPolicy,
  hasJobDayRead,
  jobDayPrincipal,
  type JobDayDeps,
} from "../jsaJobDayPolicy";
import { decideAppEntitlementAuthorization } from "../../sso/appEntitlementAuthorization";
import { decideJsaAccess } from "../../sso/jsaAuthorization";
import {
  decideRegister,
  decideComplete,
  decideConsume,
  bindingsEqual,
  type JsaGovernedRecord,
} from "../jsaReceiptCore";
const principal = {
  uid: "u",
  app: "wbt",
  driverId: "d",
  companyId: "c",
  kind: "driver",
};
const now = Date.parse("2026-10-18T15:00:00Z"),
  day = "2026-10-18";
const plan: any = {
  contractVersion: 1,
  planId: "p",
  displayName: "Plan",
  capabilities: ["jsa"],
  status: "active",
  apps: { "wellbuilt-jsa": { included: true, requiresActiveShift: true } },
};
const contract: any = { planId: "p", contractEnforced: true };
const binding = {
  shiftState: "independent" as const,
  policyDay: day,
  requiresActiveShift: false,
  jsaEnabled: true,
};
const row = (patch: Partial<JsaGovernedRecord> = {}): JsaGovernedRecord => ({
  requestId: "A".repeat(43),
  jobRef: "job",
  groupRef: null,
  intent: "read",
  driverId: "d",
  companyId: "c",
  binding,
  state: "completed",
  action: "read_and_acknowledged",
  receiptHandle: "handle",
  createdAtMs: now,
  expiresAtMs: now + 7200000,
  completedAtMs: now,
  wbtConsumedAtMs: null,
  ...patch,
});
function deps(
  style = "acknowledge",
  rows: JsaGovernedRecord[] = [],
  extra: Partial<JobDayDeps> = {},
): JobDayDeps {
  return {
    nowMs: () => now,
    sso: {
      getDriver: async () =>
        ({ driverId: "d", companyId: "c", active: true }) as any,
      getCompanyContract: async () => ({ state: "active", contract }),
      getPlan: async () => plan,
    },
    company: async () => ({
      jsaMode: "per_job",
      jsaJobPolicy: style,
      timeZone: "America/Chicago",
    }),
    records: async () => rows,
    ...extra,
  };
}
test("no shift dependency: first job requires full read; later acknowledgement becomes available", async () => {
  const first = await resolveJobDayPolicy(deps(), principal);
  expect(first.binding).toEqual(binding);
  expect(first.policy.allowAcknowledge).toBe(false);
  const later = await resolveJobDayPolicy(
    deps("acknowledge", [row()]),
    principal,
  );
  expect(later.hasRead).toBe(true);
  expect(later.policy.allowAcknowledge).toBe(true);
});
test.each(["read", "read_and_acknowledge"])(
  "%s never gains acknowledgement-only shortcut",
  async (style) => {
    const policy = await resolveJobDayPolicy(deps(style, [row()]), principal);
    expect(policy.policy.allowAcknowledge).toBe(false);
    expect(policy.policy.minimumIntent).toBe(style);
  },
);
test("pending, other driver/company/day, and ack-only records never bootstrap a full read", () => {
  for (const patch of [
    { state: "pending" as const },
    { driverId: "foreign" },
    { companyId: "foreign" },
    { binding: { ...binding, policyDay: "2026-10-17" } },
    { action: "acknowledged" as const },
  ])
    expect(hasJobDayRead([row(patch)], principal, day, false)).toBe(false);
});
test("combined policy rejects a read-only bootstrap", () =>
  expect(
    hasJobDayRead([row({ action: "read_completed" })], principal, day, true),
  ).toBe(false));
test("company-local midnight resets the day; DST dates use the named zone", () => {
  expect(
    companyJsaDay(Date.parse("2026-10-19T04:59:00Z"), "America/Chicago"),
  ).toBe(day);
  expect(
    companyJsaDay(Date.parse("2026-10-19T05:01:00Z"), "America/Chicago"),
  ).toBe("2026-10-19");
  expect(
    companyJsaDay(Date.parse("2026-11-01T06:30:00Z"), "America/Chicago"),
  ).toBe("2026-11-01");
});
test("current active membership and commercial entitlement remain mandatory", async () => {
  await expect(
    resolveJobDayPolicy(
      deps("acknowledge", [], {
        sso: {
          ...deps().sso,
          getDriver: async () =>
            ({ driverId: "d", companyId: "other", active: true }) as any,
        },
      }),
      principal,
    ),
  ).rejects.toThrow("membership");
  await expect(
    resolveJobDayPolicy(
      deps("acknowledge", [], {
        sso: {
          ...deps().sso,
          getPlan: async () => ({
            ...plan,
            apps: { "wellbuilt-jsa": { included: false } },
          }),
        },
      }),
      principal,
    ),
  ).rejects.toThrow("app_not_entitled");
});
test("WBT audience required and foreign identity remains refused", () => {
  expect(() =>
    jobDayPrincipal({
      uid: "u",
      claims: { kind: "driver", app: "jsa", companyId: "c", driverId: "d" },
    }),
  ).toThrow("audience");
  expect(() =>
    jobDayPrincipal({
      uid: "u",
      claims: { kind: "driver", app: "wbt", companyId: "c", driverId: "d" },
    }),
  ).not.toThrow();
});
test("only JSA bypasses shift prerequisite; excluded JSA remains excluded", () => {
  expect(
    decideAppEntitlementAuthorization({
      app: "wellbuilt-jsa",
      contractState: "active",
      contract,
      plan,
      shift: { state: "none" },
    }).ok,
  ).toBe(true);
  expect(
    decideJsaAccess({
      contractState: "active",
      contract,
      plan,
      shift: { state: "none" },
    }),
  ).toMatchObject({
    ok: true,
    requiresActiveShift: false,
    binding: { shiftState: "none" },
  });
  expect(
    decideAppEntitlementAuthorization({
      app: "wellbuilt-jsa",
      contractState: "active",
      contract,
      plan: { ...plan, apps: { "wellbuilt-jsa": { included: false } } },
      shift: { state: "none" },
    }).ok,
  ).toBe(false);
  expect(
    decideAppEntitlementAuthorization({
      app: "wellbuilt-equipment",
      contractState: "active",
      contract,
      plan: {
        ...plan,
        apps: {
          "wellbuilt-equipment": { included: true, requiresActiveShift: true },
        },
      },
      shift: { state: "none" },
    }).ok,
  ).toBe(false);
});
test("independent receipts complete and consume without a period; wrong actor/day cannot reuse them", () => {
  const policy = {
    jsaEnabled: true,
    requiresActiveShift: false,
    allowRead: true,
    allowAcknowledge: false,
  };
  const registered = decideRegister({
    existing: null,
    meta: {
      requestId: "B".repeat(43),
      jobRef: "split-leg-2",
      groupRef: null,
      intent: "read",
    },
    principal,
    binding,
    policy,
    nowMs: now,
    receiptHandle: "handle",
  });
  expect(registered.ok).toBe(true);
  if (!registered.ok) return;
  const completed = decideComplete({
    existing: registered.value.record,
    requestId: "B".repeat(43),
    action: "read_and_acknowledged",
    principal: { ...principal, app: "jsa" },
    binding,
    nowMs: now + 10,
  });
  expect(completed.ok).toBe(true);
  if (!completed.ok) return;
  const result = decideConsume({
    existing: completed.value.record,
    requestId: "B".repeat(43),
    principal,
    nowMs: now + 20,
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.view).toMatchObject({
      jobRef: "split-leg-2",
      policyDay: day,
      shiftState: "independent",
    });
    expect(result.value.view.periodId).toBeUndefined();
  }
  expect(
    decideConsume({
      existing: completed.value.record,
      requestId: "B".repeat(43),
      principal: { ...principal, driverId: "foreign" },
      nowMs: now + 20,
    }).ok,
  ).toBe(false);
  expect(bindingsEqual(binding, { ...binding, policyDay: "2026-10-19" })).toBe(
    false,
  );
});

test("a real open shift is an optional association; unavailable shift storage never blocks the authenticated read", async () => {
  const linked = await resolveJobDayPolicy(
    deps("acknowledge", [], {
      shift: async () => ({
        state: "open",
        periodId: "2026-10-18_080000",
        originLocalDate: day,
      }),
    }),
    principal,
  );
  expect(linked.binding.associatedPeriodId).toBe("2026-10-18_080000");
  expect(bindingsEqual(binding, linked.binding)).toBe(true);
  const offlineShift = await resolveJobDayPolicy(
    deps("acknowledge", [], {
      shift: async () => {
        throw Error("shift store unavailable");
      },
    }),
    principal,
  );
  expect(offlineShift.binding.associatedPeriodId).toBeUndefined();
  expect(offlineShift.binding.policyDay).toBe(day);
});

test("handler flow: off-shift read, each later job ack, policy tightening and actor isolation", async () => {
  const docs = new Map<string, any>();
  let style = "acknowledge";
  const daily = () =>
    deps(
      style,
      [...docs.values()].filter((r) => r.requestId),
    );
  const adapter: ReceiptDeps = {
    registerJobDay: true,
    nowMs: () => now,
    randomBytes: (n) => new Uint8Array(n),
    base64Url: () => "H".repeat(43),
    getCompanyContract: deps().sso.getCompanyContract,
    getPlan: deps().sso.getPlan,
    getJsaStylePolicy: async () => ({
      allowRead: true,
      allowAcknowledge: true,
    }),
    resolveShift: async () => ({ state: "none" }),
    readInvoice: async () => ({
      exists: true,
      data: {
        companyId: "c",
        driverId: "d",
        wellName: "Well",
        commodityType: "Production Water",
      },
    }),
    readRequest: async (id) => docs.get("jsa_governed_requests/" + id) || null,
    jobDayBinding: (p, day) => resolveJobDayPolicy(daily(), p, day),
    runTransaction: async (fn) =>
      fn({
        get: async (path) => ({ exists: docs.has(path), data: docs.get(path) }),
        create: (path, value) => {
          docs.set(path, value);
        },
        update: (path, value) => {
          docs.set(path, { ...docs.get(path), ...value });
        },
      }),
    log: () => {},
  };
  const auth = {
      uid: "u",
      claims: { kind: "driver", app: "wbt", driverId: "d", companyId: "c" },
    },
    jsaAuth = { ...auth, claims: { ...auth.claims, app: "jsa" } };
  await expect(
    handleRegister(adapter, auth, {
      requestId: "C".repeat(43),
      jobRef: "multi-1",
      intent: "acknowledge",
    }),
  ).rejects.toMatchObject({ refusal: "intent_not_permitted" });
  const requestId = "D".repeat(43);
  await handleRegister(adapter, auth, {
    requestId,
    jobRef: "multi-1",
    intent: "read",
  });
  expect(await handleGetContext(adapter, jsaAuth, { requestId })).toMatchObject(
    { state: "pending", wellName: "Well", jobRef: "multi-1" },
  );
  await handleComplete(adapter, jsaAuth, {
    requestId,
    action: "read_and_acknowledged",
  });
  expect(await handleConsume(adapter, auth, { requestId })).toMatchObject({
    shiftState: "independent",
    policyDay: day,
    jobRef: "multi-1",
  });
  expect(await resolveJobDayPolicy(daily(), principal)).toMatchObject({
    hasRead: true,
    policy: { allowAcknowledge: true },
  });
  const next = "E".repeat(43);
  await handleRegister(adapter, auth, {
    requestId: next,
    jobRef: "split-2",
    intent: "acknowledge",
  });
  style = "read";
  await expect(
    handleGetContext(adapter, jsaAuth, { requestId: next }),
  ).rejects.toMatchObject({ refusal: "intent_not_permitted" });
  await expect(
    handleRegister(
      adapter,
      { ...auth, claims: { ...auth.claims, driverId: "foreign" } },
      { requestId: "F".repeat(43), jobRef: "multi-1", intent: "read" },
    ),
  ).rejects.toMatchObject({ refusal: "not_found" });
});

test('once-per-shift companies retain each actual shift scope, with an off-shift daily scope available',async()=>{
 const original='2026-10-18_070000',next='2026-10-18_120000';
 const prior=row({binding:{...binding,associatedPeriodId:original}});
 const scenario=(period:string|null,mode='per_shift')=>deps('acknowledge',[prior],{company:async()=>({jsaMode:mode,jsaJobPolicy:'acknowledge'}),shift:async()=>period?{state:'open',periodId:period,originLocalDate:day}:{state:'none'}});
 expect(await resolveJobDayPolicy(scenario(original),principal)).toMatchObject({hasRead:true,requirementKey:`shift:${original}`});
 expect(await resolveJobDayPolicy(scenario(next),principal)).toMatchObject({hasRead:false,requirementKey:`shift:${next}`});
 expect(await resolveJobDayPolicy(scenario(null),principal)).toMatchObject({hasRead:true,requirementKey:day});
 expect(await resolveJobDayPolicy(scenario(next,'per_job'),principal)).toMatchObject({hasRead:true,requirementKey:day});
});

test('once-per-shift full read survives midnight in the same real shift',async()=>{
 const period='2026-10-18_210000',prior=row({binding:{...binding,associatedPeriodId:period}});
 const overnight=await resolveJobDayPolicy(deps('acknowledge',[prior],{nowMs:()=>Date.parse('2026-10-19T10:00:00Z'),company:async()=>({jsaMode:'per_shift',jsaJobPolicy:'acknowledge',timeZone:'America/Chicago'}),shift:async()=>({state:'open',periodId:period,originLocalDate:day})}),principal);
 expect(overnight).toMatchObject({hasRead:true,requirementKey:`shift:${period}`,binding:{policyDay:'2026-10-19'}});
});
