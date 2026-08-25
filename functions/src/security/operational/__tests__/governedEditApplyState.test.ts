import {
  applyStatePath,
  buildCapturedApplyState,
  inferPhaseFromHistory,
  parseApplyState,
  phaseAtLeast,
  versionAlreadyPublished,
  withPhase,
} from '../governedEditApplyState';

describe('governedEditApplyState', () => {
  it('captured state has no terminal flags', () => {
    const s = buildCapturedApplyState({
      editEventId: 'e1',
      originalPacketId: 'p1',
      incomingId: 'e1',
      payloadDigest: 'abc',
      wellName: 'Gabriel 5',
      noLevel: false,
      now: 't0',
    });
    expect(s.phase).toBe('captured');
    expect(s.historyWritten).toBe(false);
    expect(s.versionPublished).toBe(false);
    expect(applyStatePath('e1')).toBe('packets/editApplyState/e1');
    expect(phaseAtLeast(s, 'mutated')).toBe(false);
    expect(phaseAtLeast(withPhase(s, 'mutated', { historyWritten: true, processedWritten: true }, 't1'), 'mutated')).toBe(true);
  });

  it('infers mutated from proven history when checkpoint lagged', () => {
    expect(inferPhaseFromHistory({
      state: null,
      historyDigest: 'abc',
      incomingDigest: 'abc',
      acceptedReceipt: false,
    })).toBe('mutated');
    expect(inferPhaseFromHistory({
      state: null,
      historyDigest: 'abc',
      incomingDigest: 'abc',
      acceptedReceipt: true,
    })).toBe('terminal');
    expect(inferPhaseFromHistory({
      state: null,
      historyDigest: 'other',
      incomingDigest: 'abc',
      acceptedReceipt: false,
    })).toBeNull();
  });

  it('versionAlreadyPublished is exactly-once across crash after increment', () => {
    expect(versionAlreadyPublished({
      publishedVersion: 4,
      seqBefore: 3,
      liveVersion: 4,
    })).toEqual({ done: true, seq: 4 });
    expect(versionAlreadyPublished({
      publishedVersion: null,
      seqBefore: 3,
      liveVersion: 4,
    })).toEqual({ done: true, seq: 4 });
    expect(versionAlreadyPublished({
      publishedVersion: null,
      seqBefore: 3,
      liveVersion: 3,
    })).toEqual({ done: false });
    expect(versionAlreadyPublished({
      publishedVersion: null,
      seqBefore: null,
      liveVersion: 0,
    })).toEqual({ done: false });
  });

  it('parseApplyState rejects malformed rows', () => {
    expect(parseApplyState(null)).toBeNull();
    expect(parseApplyState({ editEventId: 'e' })).toBeNull();
    expect(parseApplyState({
      editEventId: 'e1',
      payloadDigest: 'abc',
      phase: 'captured',
    })?.phase).toBe('captured');
  });
});
