import { validate, definitionSchema } from '@tester3x/wellbuilt-contracts/transport';
import { DEMO_PACKET_DRAFT } from '../packetDraft';
import { DEMO_COMPANY_ID } from '../plan';
import { runPublishJobPacketRevision, type PublishStoreTx } from '../../security/operational/jobPacketPublish';

class MemoryStore implements PublishStoreTx {
  revisions = new Map<string, Record<string, unknown>>();
  claims = new Map<string, Record<string, unknown>>();
  heads = new Map<string, Record<string, unknown>>();
  receipts = new Map<string, Record<string, unknown>>();
  async getRevision(id: string) { return this.revisions.get(id) || null; }
  async getClaim(id: string) { return this.claims.get(id) || null; }
  async getHead(id: string) { return this.heads.get(id) || null; }
  async getReceipt(id: string) { return this.receipts.get(id) || null; }
  createRevision(id: string, data: Record<string, unknown>) { this.revisions.set(id, data); }
  createClaim(id: string, data: Record<string, unknown>) { this.claims.set(id, data); }
  createHead(id: string, data: Record<string, unknown>) { this.heads.set(id, data); }
  updateHead(id: string, data: Record<string, unknown>) { this.heads.set(id, data); }
  createReceipt(id: string, data: Record<string, unknown>) { this.receipts.set(id, data); }
}

describe('demo tenant packet binding', () => {
  it('publishes a separate revision with the SW split and multi-haul grants', async () => {
    expect(validate(definitionSchema, DEMO_PACKET_DRAFT).ok).toBe(true);
    const store = new MemoryStore();
    const result = await runPublishJobPacketRevision({
      caller: { uid: 'demo-service', companyId: DEMO_COMPANY_ID },
      request: { requestId: 'demo-bootstrap-r1', expectedLatestRevision: 0, packetDraft: DEMO_PACKET_DRAFT },
      store,
      publishedAt: '2026-10-12T00:00:00.000Z',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision).toBe(1);
    const revision = [...store.revisions.values()][0];
    expect(revision.companyId).toBe(DEMO_COMPANY_ID);
    expect(revision.jobTypes).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobTypeId: 'service-work', capabilities: ['lifecycle', 'pickup', 'multiHaul', 'splitTicket'] }),
    ]));
  });
});
