import { readFileSync } from 'fs';
import { join } from 'path';
import { validate, definitionSchema } from '@tester3x/wellbuilt-contracts/transport';

describe('fresh-water tank refill packet', () => {
  it('keeps the existing water-hauling package with a separate single-load job type', () => {
    const path = join(__dirname, '../../../../../release/pw-fieldtest/pw-revision-5-fresh-water-tank-refill.json');
    const draft = JSON.parse(readFileSync(path, 'utf8'));
    const checked = validate(definitionSchema, draft);
    expect(checked.ok).toBe(true);
    const job = draft.jobTypes.find((entry: { jobTypeId: string }) => entry.jobTypeId === 'fresh-water-tank-refill');
    expect(draft.packetId).toBe('water-hauling');
    expect(job).toEqual({ jobTypeId: 'fresh-water-tank-refill', label: 'Fresh Water Tank Refill',
      capabilities: ['lifecycle', 'pickup'] });
  });
});
