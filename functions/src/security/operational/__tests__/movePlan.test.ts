import {
  selectLatestPull,
  findAdjacent,
  tankAfterInches,
  recomputeAgainstPrior,
  perfRowKey,
  wellPerfKey,
  planMove,
  timeMs,
  type PullRow,
} from '../movePlan';

const iso = (s: string) => new Date(s).toISOString();

const A: PullRow = { packetId: 'A', dateTimeUTC: iso('2026-09-01T10:00:00Z'), tankTopInches: 80, tankAfterInches: 40 };
const B: PullRow = { packetId: 'B', dateTimeUTC: iso('2026-09-04T10:00:00Z'), tankTopInches: 84, tankAfterInches: 44 };
const C: PullRow = { packetId: 'C', dateTimeUTC: iso('2026-09-07T10:00:00Z'), tankTopInches: 88, tankAfterInches: 48 };

describe('selectLatestPull', () => {
  it('picks the newest valid pull regardless of array order', () => {
    expect(selectLatestPull([A, C, B])?.packetId).toBe('C');
  });
  it('returns null for an empty history', () => {
    expect(selectLatestPull([])).toBeNull();
  });
  it('ignores rows with invalid dates', () => {
    expect(selectLatestPull([{ packetId: 'X', dateTimeUTC: 'not-a-date' }, A])?.packetId).toBe('A');
  });
});

describe('findAdjacent', () => {
  it('finds the pulls immediately before and after a pivot', () => {
    const { prev, next } = findAdjacent([A, B, C], timeMs(B.dateTimeUTC) as number);
    // pivot equals B; B is excluded (strict), so prev=A, next=C
    expect(prev?.packetId).toBe('A');
    expect(next?.packetId).toBe('C');
  });
  it('returns nulls when there is nothing on a side', () => {
    const { prev, next } = findAdjacent([A], timeMs('2026-08-01T00:00:00Z'));
    expect(prev).toBeNull();
    expect(next?.packetId).toBe('A');
  });
});

describe('tankAfterInches', () => {
  it('matches processIncomingPull: top - (bbls/20/tanks)*12', () => {
    // 100 bbls, 2 tanks: (100/20/2)*12 = 30; 84 - 30 = 54
    expect(tankAfterInches(84, 100, 2)).toBeCloseTo(54, 6);
  });
  it('guards a zero/absent tank count', () => {
    expect(tankAfterInches(84, 20, 0)).toBeCloseTo(84 - (20 / 20 / 1) * 12, 6);
  });
});

describe('recomputeAgainstPrior — AFR / flow ownership', () => {
  it('first pull of a well (no prior) has zero recovery/flow', () => {
    expect(recomputeAgainstPrior({ dateTimeUTC: A.dateTimeUTC, tankTopInches: 80 }, null))
      .toEqual({ timeDifDays: 0, recoveryInches: 0, flowRateDays: 0 });
  });
  it('measures recovery from the prior pull tank-after and derives days/ft', () => {
    // prior after 40", this top 84", recovery 44"; 3 days → flow=(3/44)*12
    const r = recomputeAgainstPrior(
      { dateTimeUTC: B.dateTimeUTC, tankTopInches: 84 },
      { dateTimeUTC: A.dateTimeUTC, tankAfterInches: 40 },
    );
    expect(r.recoveryInches).toBeCloseTo(44, 6);
    expect(r.timeDifDays).toBeCloseTo(3, 6);
    expect(r.flowRateDays).toBeCloseTo((3 / 44) * 12, 6);
  });
  it('rejects an anomalous flow rate (>= 365 days/ft) as 0', () => {
    // tiny recovery over a long gap → huge days/ft → rejected
    const r = recomputeAgainstPrior(
      { dateTimeUTC: '2027-09-01T00:00:00Z', tankTopInches: 40.01 },
      { dateTimeUTC: '2026-09-01T00:00:00Z', tankAfterInches: 40 },
    );
    expect(r.flowRateDays).toBe(0);
  });
});

describe('planMove — no regression / recompute anchors', () => {
  it('rebuilds each well from its latest pull; a concurrent NEWER pull is honored, never regressed', () => {
    // Moved pull B leaves fromWell = [A]; toWell gains B but already has a NEWER C.
    const plan = planMove({ movedPacketId: 'B', fromPulls: [A], toPulls: [B, C] });
    expect(plan.fromLatest?.packetId).toBe('A'); // fromWell current-state anchor
    expect(plan.toLatest?.packetId).toBe('C');   // NOT B — newer C owns current state
    expect(plan.fromEmpty).toBe(false);
  });

  it('moving the latest pull re-derives fromWell from the prior remaining pull', () => {
    // Move C out of a well that had [A,B,C]; remaining [A,B] → latest B.
    const plan = planMove({ movedPacketId: 'C', fromPulls: [A, B], toPulls: [C] });
    expect(plan.fromLatest?.packetId).toBe('B');
    expect(plan.toLatest?.packetId).toBe('C');
  });

  it('flags an emptied source well (outgoing should be cleared)', () => {
    const plan = planMove({ movedPacketId: 'A', fromPulls: [], toPulls: [A] });
    expect(plan.fromEmpty).toBe(true);
    expect(plan.fromLatest).toBeNull();
  });
});

describe('performance keys', () => {
  it('wellPerfKey underscores spaces (Gabriel 3 → Gabriel_3)', () => {
    expect(wellPerfKey('Gabriel 3')).toBe('Gabriel_3');
  });
  it('perfRowKey derives a stable local-time key from the pull time', () => {
    // Deterministic format YYYYMMDD_HHMMSS in local time.
    expect(perfRowKey('2026-09-07T10:00:00Z')).toMatch(/^\d{8}_\d{6}$/);
  });
});
