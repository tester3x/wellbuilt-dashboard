/** Required-job evidence shares a persistent JSA shift context; dates are display metadata. */
import { WELLBUILT_APP_JSA } from "@tester3x/wellbuilt-contracts";
import { decideAppEntitlementAuthorization } from "../sso/appEntitlementAuthorization";
import type { ResolveResult } from "../security/operational/shiftAuthority";
import type { SsoDeps } from "../sso/ssoDeps";
import { JsaReceiptError } from "./jsaReceiptHandlers";
import {
  decideActionSatisfies,
  parseAuthPrincipal,
  requireAudience,
  type AuthPrincipal,
  type JsaAuthorityBinding,
  type JsaCompanyPolicy,
  type JsaGovernedRecord,
} from "./jsaReceiptCore";
export interface JobDayDeps {
  sso: Pick<SsoDeps, "getDriver" | "getCompanyContract" | "getPlan">;
  shift?(driverId: string, companyId: string): Promise<ResolveResult>;
  workPeriod?(p:AuthPrincipal,day:string,shift:ResolveResult):Promise<{id:string;originDate:string;shiftId:string|null}>;
  nowMs(): number;
  company(id: string): Promise<Record<string, unknown>>;
  records(
    companyId: string,
    driverId: string,
    day: string,
    periodId?: string,
  ): Promise<JsaGovernedRecord[]>;
}
export function companyJsaDay(at: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function jobDayPrincipal(auth: {
  uid?: string | null;
  claims?: Record<string, unknown> | null;
}): AuthPrincipal {
  const p = parseAuthPrincipal(auth);
  if (!p.ok)
    throw new JsaReceiptError("permission-denied", "not_owner", "identity");
  if (!requireAudience(p.value, "wbt").ok)
    throw new JsaReceiptError(
      "permission-denied",
      "wrong_audience",
      "audience",
    );
  return p.value;
}
export function hasJobDayRead(
  rows: JsaGovernedRecord[],
  p: AuthPrincipal,
  day: string,
  combined: boolean,
  periodId?:string,
): boolean {
  return rows.some(
    (r) =>
      r.companyId === p.companyId &&
      r.driverId === p.driverId &&
      r.binding.shiftState === "independent" &&
      (periodId ? (r.binding.jsaPeriodId || r.binding.associatedPeriodId) === periodId : r.binding.policyDay === day) &&
      r.state === "completed" &&
      (r.action === "read_and_acknowledged" ||
        (!combined && r.action === "read_completed")),
  );
}
export async function resolveJobDayPolicy(
  deps: JobDayDeps,
  p: AuthPrincipal,
  frozenDay?: string,
): Promise<{
  binding: JsaAuthorityBinding;
  policy: JsaCompanyPolicy;
  hasRead: boolean;
  style: string;
  rows: JsaGovernedRecord[];
  mode: string;
  requirementKey:string;
}> {
  const driver = await deps.sso.getDriver(p.driverId);
  if (
    !driver?.active ||
    driver.companyId !== p.companyId ||
    driver.driverId !== p.driverId
  )
    throw new JsaReceiptError("permission-denied", "not_owner", "membership");
  const state = await deps.sso.getCompanyContract(p.companyId),
    plan = state.contract
      ? await deps.sso.getPlan(state.contract.planId)
      : null;
  const access = decideAppEntitlementAuthorization({
    app: WELLBUILT_APP_JSA,
    contractState: state.state,
    contract: state.contract,
    plan,
    shift: null,
  });
  if (
    !access.ok ||
    !Array.isArray(plan?.capabilities) ||
    !plan.capabilities.includes("jsa")
  )
    throw new JsaReceiptError(
      "permission-denied",
      "jsa_disabled",
      access.ok ? "capability" : access.refusal,
    );
  const cfg = await deps.company(p.companyId);
  const style = ["read", "acknowledge", "read_and_acknowledge"].includes(
    String(cfg.jsaJobPolicy),
  )
    ? String(cfg.jsaJobPolicy)
    : cfg.jsaAllowAcknowledge === false
      ? "read"
      : "acknowledge";
  const raw = cfg.jsaMode ?? "off";
  if (
    !["off", "per_shift", "per_job", "per_load", "per_location"].includes(
      String(raw),
    )
  )
    throw new JsaReceiptError(
      "failed-precondition",
      "malformed",
      "company_policy",
    );
  const mode =
    raw === "per_load" || raw === "per_location" ? "per_job" : String(raw);
  const zone = String(cfg.timeZone || cfg.timezone || "America/Chicago");
  const currentDay=companyJsaDay(deps.nowMs(),zone);
  let day = frozenDay || currentDay;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new JsaReceiptError("failed-precondition", "malformed", "policy_day");
  let observed:ResolveResult={state:'unverifiable',reason:'authority_absent'};
  if(!deps.workPeriod&&deps.shift)try{observed=await deps.shift(p.driverId,p.companyId);}catch{/* JSA does not require clock-in. */}
  const context=deps.workPeriod?await deps.workPeriod(p,currentDay,observed):null;
  const associatedPeriodId=context?context.shiftId||undefined:observed.state==='open'?observed.periodId:undefined;
  const scopedPeriod=context?.id||associatedPeriodId;
  if(context)day=context.originDate;
  const rows=(await deps.records(p.companyId,p.driverId,day,scopedPeriod)).filter(r=>r.companyId===p.companyId&&r.driverId===p.driverId&&r.binding.shiftState==='independent'&&(scopedPeriod?(r.binding.jsaPeriodId||r.binding.associatedPeriodId)===scopedPeriod:r.binding.policyDay===day));
  const hasRead=hasJobDayRead(rows,p,day,true,scopedPeriod);
  const requirementKey=context?`jsa:${context.id}`:scopedPeriod?`shift:${scopedPeriod}`:day;
  return {
    requirementKey,
    binding: {
      ...(associatedPeriodId ? { associatedPeriodId } : {}),
      ...(context ? {jsaPeriodId:context.id} : {}),
      shiftState: "independent",
      policyDay: day,
      requiresActiveShift: false,
      jsaEnabled: true,
    },
    policy: {
      jsaEnabled: true,
      requiresActiveShift: false,
      allowRead: true,
      allowAcknowledge: hasRead,
      minimumIntent:
        context || style === "read_and_acknowledge" ? "read_and_acknowledge" : "read",
    },
    hasRead,
    style,
    rows,
    mode,
  };
}

/** A completed job keeps its verified evidence; this never authorizes a new job. */
export function hasHistoricalJobCoverage(p:AuthPrincipal,jobRef:string,reads:JsaGovernedRecord[],acks:Record<string,unknown>[],linked:Record<string,unknown>|null):boolean {
 const owned=(r:{companyId?:unknown;driverId?:unknown;jobRef?:unknown})=>r.companyId===p.companyId&&r.driverId===p.driverId&&r.jobRef===jobRef;
 return reads.some(r=>owned(r)&&r.state==='completed'&&!!r.action&&decideActionSatisfies(r.intent,r.action).ok)
  ||acks.some(a=>owned(a)&&a.schemaVersion===1&&a.method==='acknowledged'&&typeof a.recordedAtMs==='number'&&Number.isFinite(a.recordedAtMs))
  ||!!linked&&owned(linked)&&linked.schemaVersion===1&&linked.method==='scope_read'&&typeof linked.fullReadId==='string'&&!!linked.fullReadId;
}
