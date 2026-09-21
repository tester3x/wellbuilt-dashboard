/**
 * Production adapter for Dashboard Add Well.
 * Never writes well_config from the client — RTDB parent writes are denied.
 */
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import type { WellConfigRecord } from './addWellSubmit';
import type { WellConfigUpdatePatch } from './updateWellConfig';

export type StaffCreateWellResult = {
  ok: true;
  wellName: string;
  created: boolean;
  idempotent: boolean;
  config: WellConfigRecord;
};

export async function staffCreateWellConfig(params: {
  wellName: string;
  config: WellConfigRecord;
}): Promise<StaffCreateWellResult> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffWriteWellConfig');
  const res = await fn({
    op: 'create',
    wellName: params.wellName,
    config: params.config,
  });
  return res.data as StaffCreateWellResult;
}

export type { WellConfigUpdatePatch };

export type StaffUpdateWellResult = {
  ok: true;
  wellName: string;
  updated: boolean;
  idempotent: boolean;
  config: Record<string, unknown>;
};

export async function staffUpdateWellConfig(params: {
  wellName: string;
  config: WellConfigUpdatePatch;
}): Promise<StaffUpdateWellResult> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffWriteWellConfig');
  const res = await fn({
    op: 'update',
    wellName: params.wellName,
    config: params.config,
  });
  return res.data as StaffUpdateWellResult;
}

export async function staffDeleteWellConfig(params: { wellName: string }): Promise<{ ok: true; wellName: string; deleted: boolean }> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffWriteWellConfig');
  const res = await fn({ op: 'delete', wellName: params.wellName, config: {} });
  return res.data as { ok: true; wellName: string; deleted: boolean };
}

export async function staffRenameWellConfig(params: {
  wellName: string;
  newName: string;
}): Promise<{ ok: true; wellName: string; previousName?: string; renamed?: boolean }> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffWriteWellConfig');
  const res = await fn({
    op: 'rename',
    wellName: params.wellName,
    config: { newName: params.newName },
  });
  return res.data as { ok: true; wellName: string; previousName?: string; renamed?: boolean };
}
