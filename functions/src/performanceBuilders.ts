// performanceBuilders.ts — pure performance/accuracy row builder, extracted
// VERBATIM from processIncomingPull (calculation separated from the
// performance/<wellKey>/rows .set persistence). Timestamp/date keys, the
// predicted-inches source preference (packet value → prev-response fallback →
// actual), Math.floor rounding, and the {d,a,p} shape are preserved exactly.

export interface PerformanceInputs {
  wellName: string;
  dateTimeUTC: string;
  tankLevelFeet: number;
  predictedLevelInches?: number | null;
  prevResponse?: {
    currentLevel?: string;
    flowRate?: string;
    timestampUTC?: string;
    timestamp?: string;
  } | null;
}

export interface PerformanceRowResult {
  wellKey: string;
  perfTimestamp: string;
  perfDateStr: string;
  row: { d: string; a: number; p: number };
}

export function buildPerformanceRow(i: PerformanceInputs): PerformanceRowResult {
  const pullTime = new Date(i.dateTimeUTC);
  const perfTimestamp = `${pullTime.getFullYear()}${String(pullTime.getMonth() + 1).padStart(2, '0')}${String(pullTime.getDate()).padStart(2, '0')}_${String(pullTime.getHours()).padStart(2, '0')}${String(pullTime.getMinutes()).padStart(2, '0')}${String(pullTime.getSeconds()).padStart(2, '0')}`;
  const perfDateStr = `${pullTime.getFullYear()}-${String(pullTime.getMonth() + 1).padStart(2, '0')}-${String(pullTime.getDate()).padStart(2, '0')}`;
  const wellKey = i.wellName.replace(/\s+/g, '_');
  const actualInches = Math.floor(i.tankLevelFeet * 12);

  // Best: use predictedLevelInches from packet (what driver saw on screen)
  let predictedInches: number | undefined;
  if (i.predictedLevelInches !== undefined && i.predictedLevelInches !== null) {
    predictedInches = Math.floor(Number(i.predictedLevelInches));
  } else if (i.prevResponse && i.prevResponse.currentLevel && i.prevResponse.flowRate && i.prevResponse.flowRate !== 'Unknown') {
    // Fallback: calculate from previous response (what driver was looking at)
    const levelMatch = i.prevResponse.currentLevel.match(/(\d+)'(\d+)"/);
    const flowMatch = i.prevResponse.flowRate.match(/^(\d+):(\d{2}):(\d{2})$/);
    if (levelMatch && flowMatch) {
      const prevBottomFeet = parseInt(levelMatch[1]) + parseInt(levelMatch[2]) / 12;
      const afrDays = (parseInt(flowMatch[1]) + parseInt(flowMatch[2]) / 60 + parseInt(flowMatch[3]) / 3600) / 24;
      const prevTime = new Date(i.prevResponse.timestampUTC || i.prevResponse.timestamp || 0).getTime();
      const timeDiffDays = (pullTime.getTime() - prevTime) / (1000 * 60 * 60 * 24);
      if (afrDays > 0 && timeDiffDays > 0) {
        const growthFeet = timeDiffDays / afrDays;
        predictedInches = Math.floor((prevBottomFeet + growthFeet) * 12);
      }
    }
  }

  if (predictedInches === undefined) {
    predictedInches = actualInches;
  }

  return { wellKey, perfTimestamp, perfDateStr, row: { d: perfDateStr, a: actualInches, p: predictedInches } };
}
