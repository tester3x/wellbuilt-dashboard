import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '../index.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('wellDown authority and well_config synchronization wiring', () => {
  const pullStart = src.indexOf('export const processIncomingPull');
  const editStart = src.indexOf('export const processEditRequest');
  const deleteStart = src.indexOf('export const processDeleteRequest');

  const pullHandler = src.slice(pullStart, editStart);
  const editHandler = src.slice(editStart, deleteStart);

  test('processIncomingPull synchronizes well_config isDown only under incomingHasAuthoritativeWellDown', () => {
    const authCheckIdx = pullHandler.indexOf('incomingHasAuthoritativeWellDown');
    expect(authCheckIdx).toBeGreaterThan(-1);

    expect(pullHandler).toMatch(
      /if\s*\(\s*incomingHasAuthoritativeWellDown\s*\)\s*\{[\s\S]*?well_config\/\$\{targetConfigKey\}\/isDown`\)\.set\(nextIsDown\);/
    );

    // Assert that the well_config.isDown write sits after the authoritative check
    const syncIdx = pullHandler.indexOf('well_config/${targetConfigKey}/isDown`).set(nextIsDown)');
    expect(syncIdx).toBeGreaterThan(authCheckIdx);

    // Confirm no un-gated well_config isDown writes exist in processIncomingPull
    const allConfigIsDownWrites = pullHandler.match(/well_config[^\n]*isDown/g) || [];
    expect(allConfigIsDownWrites.length).toBe(1);
  });

  test('processEditRequest synchronizes well_config isDown only under editIsAuthoritative', () => {
    const editAuthIdx = editHandler.indexOf('editIsAuthoritative');
    expect(editAuthIdx).toBeGreaterThan(-1);

    // Confirm both branches (no-level and standard) synchronize under editIsAuthoritative
    const matches = editHandler.match(
      /if\s*\(\s*editIsAuthoritative\s*\)\s*\{[\s\S]*?well_config\/\$\{targetConfigKey\}\/isDown`\)\.set\(nextEditIsDown\);/g
    );
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);

    const allConfigIsDownWrites = editHandler.match(/well_config[^\n]*isDown/g) || [];
    expect(allConfigIsDownWrites.length).toBe(2);
  });
});
