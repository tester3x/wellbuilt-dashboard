import {
  parseFeetDecimal,
  parseFlowMinutesPerFoot,
  formatFeetWBM,
  formatTtp,
  projectRouteMeLevelAndTtp,
  RouteMeProjectionInputs,
} from '../routeMeProjection';

describe('Route Me Dynamic Level and TTP Projection Engine', () => {
  const BASE_TIME_MS = Date.UTC(2026, 8, 14, 0, 0, 0); // 2026-09-14T00:00:00Z

  describe('Gabriel-5 Acceptance Case (Mandatory Projection Rule)', () => {
    // Trigger: 10'0" (120 inches = 10 ft)
    // Baseline: 4'9" (57 inches = 4.75 ft)
    // Flow: 3:20:24 per foot (200.4 minutes per foot)
    // Distance to fill: 5.25 ft
    // Raw full fill duration: 5.25 * 200.4 = 1052.1 minutes (~17h 32m)
    const gabrielInputs: RouteMeProjectionInputs = {
      startingBottomFeet: parseFeetDecimal("4'9\""), // 4.75 ft
      pullTimeMs: BASE_TIME_MS,
      flowMinutesPerFoot: parseFlowMinutesPerFoot('3:20:24'), // 200.4 min/ft
      wellDown: false,
      targetFeet: parseFeetDecimal("10'0\""), // 10 ft
    };

    it('parses exact Gabriel-5 parameters correctly', () => {
      expect(gabrielInputs.startingBottomFeet).toBe(4.75);
      expect(gabrielInputs.targetFeet).toBe(10);
      expect(gabrielInputs.flowMinutesPerFoot).toBeCloseTo(200.4, 4);
    });

    it('at t = 0 (immediately post-pull), returns baseline 4\'9" and ~17h 32m TTP', () => {
      const res0 = projectRouteMeLevelAndTtp(gabrielInputs, BASE_TIME_MS);
      expect(res0.levelDisplay).toBe("4'9\"");
      expect(res0.timeTillPull).toBe('17h 32m');
      expect(res0.hasFlow).toBe(true);
      expect(res0.frozen).toBe(false);
      expect(res0.available).toBe(true);
      expect(res0.predictedReadyAtMs).toBe(BASE_TIME_MS + Math.round(1052.1 * 60000));
    });

    it('after eight elapsed hours, Route Me MUST NOT still return 4\'9" and 17h 32m', () => {
      const eightHoursMs = BASE_TIME_MS + 8 * 3600 * 1000;
      const res8 = projectRouteMeLevelAndTtp(gabrielInputs, eightHoursMs);

      // Must NOT return stale post-pull readings
      expect(res8.levelDisplay).not.toBe("4'9\"");
      expect(res8.timeTillPull).not.toBe('17h 32m');

      // Projected level rises with elapsed time:
      // 480 min / 200.4 min/ft = 2.3952 ft. 4.75 + 2.3952 = 7.1452 ft = 85.74 in -> 7'1"
      expect(res8.levelDisplay).toBe("7'1\"");

      // Remaining TTP falls by the same 8 elapsed hours:
      // 1052.1 min - 480 min = 572.1 min -> 9h 32m
      expect(res8.timeTillPull).toBe('9h 32m');

      // Predicted Next Pull timestamp remains strictly FIXED
      const res0 = projectRouteMeLevelAndTtp(gabrielInputs, BASE_TIME_MS);
      expect(res8.predictedReadyAtMs).toBe(res0.predictedReadyAtMs);
    });

    it('repeated projection at eight elapsed hours never compounds', () => {
      const eightHoursMs = BASE_TIME_MS + 8 * 3600 * 1000;
      const run1 = projectRouteMeLevelAndTtp(gabrielInputs, eightHoursMs);
      const run2 = projectRouteMeLevelAndTtp(gabrielInputs, eightHoursMs);
      const run3 = projectRouteMeLevelAndTtp(gabrielInputs, eightHoursMs);

      expect(run1.levelDisplay).toBe("7'1\"");
      expect(run2.levelDisplay).toBe("7'1\"");
      expect(run3.levelDisplay).toBe("7'1\"");
      expect(run1.timeTillPull).toBe('9h 32m');
      expect(run2.timeTillPull).toBe('9h 32m');
      expect(run3.timeTillPull).toBe('9h 32m');
      expect(run1.predictedReadyAtMs).toBe(run2.predictedReadyAtMs);
      expect(run2.predictedReadyAtMs).toBe(run3.predictedReadyAtMs);
    });
  });

  describe('Down Well & Error Invariants', () => {
    it('DOWN wells remain frozen at baseline level with TTP = Down', () => {
      const downInputs: RouteMeProjectionInputs = {
        startingBottomFeet: parseFeetDecimal("5'6\""),
        pullTimeMs: BASE_TIME_MS,
        flowMinutesPerFoot: 60,
        wellDown: true,
        targetFeet: 10,
      };

      const res0 = projectRouteMeLevelAndTtp(downInputs, BASE_TIME_MS);
      const resLater = projectRouteMeLevelAndTtp(downInputs, BASE_TIME_MS + 24 * 3600 * 1000);

      expect(res0.levelDisplay).toBe("5'6\"");
      expect(res0.timeTillPull).toBe('Down');
      expect(res0.priorityState).toBe('down');
      expect(res0.frozen).toBe(true);
      expect(res0.hasFlow).toBe(false);

      expect(resLater.levelDisplay).toBe("5'6\""); // never rises
      expect(resLater.timeTillPull).toBe('Down');
      expect(resLater.predictedReadyAtMs).toBeNull();
    });

    it('missing baseline fails unavailable (level: "--", TTP: "Unknown"), NEVER zero', () => {
      const noBaseline: RouteMeProjectionInputs = {
        startingBottomFeet: null,
        pullTimeMs: BASE_TIME_MS,
        flowMinutesPerFoot: 60,
        wellDown: false,
        targetFeet: 10,
      };

      const res = projectRouteMeLevelAndTtp(noBaseline, BASE_TIME_MS + 3600 * 1000);
      expect(res.levelDisplay).toBe('--');
      expect(res.timeTillPull).toBe('Unknown');
      expect(res.priorityState).toBe('verify');
      expect(res.available).toBe(false);
      expect(res.projectedFeet).toBeNull();
    });

    it('missing observation timestamp fails unavailable (never zero)', () => {
      const noTimestamp: RouteMeProjectionInputs = {
        startingBottomFeet: 4.5,
        pullTimeMs: null,
        flowMinutesPerFoot: 60,
        wellDown: false,
        targetFeet: 10,
      };

      const res = projectRouteMeLevelAndTtp(noTimestamp, BASE_TIME_MS);
      expect(res.levelDisplay).toBe('--');
      expect(res.timeTillPull).toBe('Unknown');
      expect(res.available).toBe(false);
    });

    it('missing flow rate freezes at baseline level with TTP = Unknown (no-gain)', () => {
      const noFlow: RouteMeProjectionInputs = {
        startingBottomFeet: parseFeetDecimal("3'4\""),
        pullTimeMs: BASE_TIME_MS,
        flowMinutesPerFoot: null,
        wellDown: false,
        targetFeet: 10,
      };

      const res = projectRouteMeLevelAndTtp(noFlow, BASE_TIME_MS + 10 * 3600 * 1000);
      expect(res.levelDisplay).toBe("3'4\"");
      expect(res.timeTillPull).toBe('Unknown');
      expect(res.priorityState).toBe('no-gain');
      expect(res.frozen).toBe(true);
      expect(res.hasFlow).toBe(false);
      expect(res.predictedReadyAtMs).toBeNull();
    });

    it('when projected level reaches or exceeds trigger, marks pull-now and TTP Ready', () => {
      const readyInputs: RouteMeProjectionInputs = {
        startingBottomFeet: 9.5,
        pullTimeMs: BASE_TIME_MS,
        flowMinutesPerFoot: 60, // 1 ft/hr
        wellDown: false,
        targetFeet: 10.0,
      };

      // After 1 hour, risen 1 ft to 10.5 ft (exceeds 10.0 ft target)
      const res = projectRouteMeLevelAndTtp(readyInputs, BASE_TIME_MS + 3600 * 1000);
      expect(res.levelDisplay).toBe("10'6\"");
      expect(res.timeTillPull).toBe('Ready');
      expect(res.priorityState).toBe('pull-now');
    });
  });

  describe('Parsers and Helpers', () => {
    it('parses feet/inches accurately', () => {
      expect(parseFeetDecimal("4'9\"")).toBe(4.75);
      expect(parseFeetDecimal("10'0\"")).toBe(10);
      expect(parseFeetDecimal("18'6\"")).toBe(18.5);
      expect(parseFeetDecimal("5'")).toBe(5);
      expect(parseFeetDecimal("7'6")).toBe(7.5);
      expect(parseFeetDecimal("15")).toBe(15);
      expect(parseFeetDecimal("--")).toBeNull();
      expect(parseFeetDecimal("DOWN")).toBeNull();
    });

    it('parses H:MM:SS flow rate strings to minutes per foot', () => {
      expect(parseFlowMinutesPerFoot("3:20:24")).toBeCloseTo(200.4, 4);
      expect(parseFlowMinutesPerFoot("0:30:00")).toBe(30);
      expect(parseFlowMinutesPerFoot("1:00:00")).toBe(60);
      expect(parseFlowMinutesPerFoot("2:15")).toBe(135);
      expect(parseFlowMinutesPerFoot("0:00:10")).toBeNull(); // < 1 min/ft rejected
      expect(parseFlowMinutesPerFoot("Unknown")).toBeNull();
    });

    it('formats display feet according to WB-M flooring rules', () => {
      expect(formatFeetWBM(7.0)).toBe("7'");
      expect(formatFeetWBM(7 + 1 / 12)).toBe("7'1\"");
      expect(formatFeetWBM(4.75)).toBe("4'9\"");
      expect(formatFeetWBM(22)).toBe("20'"); // capped at 20'
      expect(formatFeetWBM(null)).toBe('--');
    });

    it('formats TTP intervals cleanly', () => {
      expect(formatTtp(0)).toBe('Ready');
      expect(formatTtp(-10)).toBe('Ready');
      expect(formatTtp(45)).toBe('0h 45m');
      expect(formatTtp(1052.1)).toBe('17h 32m');
      expect(formatTtp(572.1)).toBe('9h 32m');
      expect(formatTtp(1500)).toBe('1d 1h 0m');
      expect(formatTtp(null)).toBe('Unknown');
    });
  });
});
