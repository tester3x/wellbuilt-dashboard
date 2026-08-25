import type { PaperCaller } from './types';

export function authorizePaperCompany(
  caller: PaperCaller,
  ticketCompanyId: string,
): { ok: true } | { ok: false; reason: string; message: string } {
  if (!ticketCompanyId) {
    return { ok: false, reason: 'company_required', message: 'Ticket has no companyId.' };
  }
  if (caller.isPlatformAdmin) return { ok: true };
  if (!caller.companyId) {
    return { ok: false, reason: 'caller_unscoped', message: 'Caller has no company scope.' };
  }
  if (caller.companyId !== ticketCompanyId) {
    return { ok: false, reason: 'wrong_company', message: 'Cannot resolve another company\'s artifact.' };
  }
  return { ok: true };
}
