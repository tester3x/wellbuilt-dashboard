import {
  validateDeviceLocation,
  evaluateLegTravel,
  sequencePickupAndDisposalLegs,
  GovernedRoutingRepository,
  DeviceLocationInput,
  CandidateDisposal,
  WellRoutingContext,
} from '../routeMeAssistedRouting';

describe('routeMeAssistedRouting', () => {
  const asOfMs = 1757940000000; // pinned reference time

  describe('validateDeviceLocation', () => {
    it('rejects missing or undefined location', () => {
      expect(validateDeviceLocation(undefined, asOfMs)).toEqual({
        valid: false,
        reason: 'missing',
      });
      expect(validateDeviceLocation(null, asOfMs)).toEqual({
        valid: false,
        reason: 'missing',
      });
    });

    it('rejects missing or non-numeric coordinates', () => {
      expect(validateDeviceLocation({ latitude: undefined, longitude: -103.28, capturedAt: asOfMs }, asOfMs)).toEqual({
        valid: false,
        reason: 'missing',
      });
      expect(validateDeviceLocation({ latitude: NaN, longitude: -103.28, capturedAt: asOfMs }, asOfMs)).toEqual({
        valid: false,
        reason: 'missing',
      });
    });

    it('rejects invalid coordinates out of WGS84 range or (0,0)', () => {
      expect(validateDeviceLocation({ latitude: 95.0, longitude: -103.28, capturedAt: asOfMs }, asOfMs)).toEqual({
        valid: false,
        reason: 'invalid_coords',
      });
      expect(validateDeviceLocation({ latitude: 0, longitude: 0, capturedAt: asOfMs }, asOfMs)).toEqual({
        valid: false,
        reason: 'invalid_coords',
      });
    });

    it('rejects missing or unparseable capturedAt timestamp', () => {
      expect(validateDeviceLocation({ latitude: 47.8, longitude: -103.28, capturedAt: undefined }, asOfMs)).toEqual({
        valid: false,
        reason: 'missing',
      });
      expect(validateDeviceLocation({ latitude: 47.8, longitude: -103.28, capturedAt: 'not-a-date' }, asOfMs)).toEqual({
        valid: false,
        reason: 'missing',
      });
    });

    it('rejects stale location older than 15 minutes', () => {
      const sixteenMinutesAgo = asOfMs - 16 * 60 * 1000;
      expect(validateDeviceLocation({ latitude: 47.8, longitude: -103.28, capturedAt: sixteenMinutesAgo }, asOfMs)).toEqual({
        valid: false,
        reason: 'stale',
      });
    });

    it('rejects location with clock drift far into the future', () => {
      const futureMs = asOfMs + 2 * 60 * 1000; // 2 minutes future
      expect(validateDeviceLocation({ latitude: 47.8, longitude: -103.28, capturedAt: futureMs }, asOfMs)).toEqual({
        valid: false,
        reason: 'stale',
      });
    });

    it('rejects inaccurate location exceeding 500 meters', () => {
      expect(validateDeviceLocation({ latitude: 47.8, longitude: -103.28, capturedAt: asOfMs, accuracy: 550 }, asOfMs)).toEqual({
        valid: false,
        reason: 'inaccurate',
      });
    });

    it('accepts fresh, accurate location within limits', () => {
      const fiveMinutesAgo = asOfMs - 5 * 60 * 1000;
      const res = validateDeviceLocation(
        { latitude: 47.8012, longitude: -103.2845, capturedAt: fiveMinutesAgo, accuracy: 15 },
        asOfMs,
      );
      expect(res.valid).toBe(true);
      expect(res.latitude).toBe(47.8012);
      expect(res.longitude).toBe(-103.2845);
      expect(res.capturedAtMs).toBe(fiveMinutesAgo);
      expect(res.accuracy).toBe(15);
    });

    it('accepts ISO string capturedAt', () => {
      const isoStr = new Date(asOfMs - 60000).toISOString();
      const res = validateDeviceLocation(
        { latitude: 47.8012, longitude: -103.2845, capturedAt: isoStr, accuracy: 20 },
        asOfMs,
      );
      expect(res.valid).toBe(true);
      expect(res.capturedAtMs).toBe(Date.parse(isoStr));
    });
  });

  describe('Mike Closed-Road Acceptance Fixture', () => {
    /**
     * Fixture setup:
     * - Driver Origin: Watford City Yard.
     * - Well A ("Mike Well A"):
     *   - Naive map shortcut claims 20 minutes (via County Road CR-12).
     *   - Governed active closure is logged on CR-12 ("road_closed").
     *   - Safe approved detour via State Hwy 23 takes 40 minutes.
     * - Well B ("Mike Well B"):
     *   - Approved corridor route takes 30 minutes.
     *
     * Invariant:
     * - Governed road closure outranks naive map shortcut.
     * - Well A must be routed via safe detour (40 minutes) with restriction flag.
     * - Well B (30 minutes) must rank ahead of Well A (40 minutes).
     * - Naive map ranking (Well A: 20m < Well B: 30m) is rejected.
     */
    const repo: GovernedRoutingRepository = {
      closures: [
        {
          id: 'closure-cr-12',
          roadName: 'CR-12',
          active: true,
          reason: 'Bridge washout / culvert replacement',
        },
      ],
      corridors: [
        {
          corridorId: 'corridor-watford-to-well-a-safe',
          companyId: 'company-mike',
          originName: 'Watford Yard',
          destName: 'Mike Well A',
          travelMinutes: 40,
          distanceMiles: 28,
          isApproved: true,
          viaRoads: ['US-85', 'ND-23', 'Lease-A'],
        },
        {
          corridorId: 'corridor-watford-to-well-b',
          companyId: 'company-mike',
          originName: 'Watford Yard',
          destName: 'Mike Well B',
          travelMinutes: 30,
          distanceMiles: 21,
          isApproved: true,
          viaRoads: ['US-85', 'ND-1804', 'Lease-B'],
        },
      ],
      naiveMapEstimates: [
        {
          originName: 'Watford Yard',
          destName: 'Mike Well A',
          estimatedMinutes: 20, // Naive shortcut falsely claiming 20 minutes
          distanceMiles: 14,
          viaRoads: ['CR-12'], // Closed road!
        },
      ],
    };

    const origin = { lat: 47.801, lng: -103.284, label: 'Watford Yard' };
    const wellAPoint = { lat: 47.92, lng: -103.15, label: 'Mike Well A' };
    const wellBPoint = { lat: 47.85, lng: -103.45, label: 'Mike Well B' };

    it('invalidates naive 20m shortcut on Well A and applies 40m safe detour with restriction flag', () => {
      const legA = evaluateLegTravel(
        {
          legType: 'origin_to_pickup',
          origin,
          destination: wellAPoint,
          companyId: 'company-mike',
        },
        repo,
      );

      expect(legA.estimatedTravelMinutes).toBe(40);
      expect(legA.travelBasis).toBe('approved_corridor');
      expect(legA.restrictions).toContain('road_closed');
      expect(legA.reasonCode).toBe('CLOSED_ROAD_SAFE_DETOUR');
    });

    it('evaluates Well B via approved corridor at 30 minutes with zero restrictions', () => {
      const legB = evaluateLegTravel(
        {
          legType: 'origin_to_pickup',
          origin,
          destination: wellBPoint,
          companyId: 'company-mike',
        },
        repo,
      );

      expect(legB.estimatedTravelMinutes).toBe(30);
      expect(legB.travelBasis).toBe('approved_corridor');
      expect(legB.restrictions).toHaveLength(0);
      expect(legB.reasonCode).toBe('APPROVED_CORRIDOR_VERIFIED');
    });

    it('proves Well B (30 min) outranks Well A (40 min) despite naive map falsely claiming 20 min', () => {
      const wellAContext: WellRoutingContext = {
        wellName: 'Mike Well A',
        companyId: 'company-mike',
        lat: wellAPoint.lat,
        lng: wellAPoint.lng,
        predictedReadyAtMs: asOfMs, // ready now
        priorityState: 'pull-now',
      };

      const wellBContext: WellRoutingContext = {
        wellName: 'Mike Well B',
        companyId: 'company-mike',
        lat: wellBPoint.lat,
        lng: wellBPoint.lng,
        predictedReadyAtMs: asOfMs, // ready now
        priorityState: 'pull-now',
      };

      const commonDisposal: CandidateDisposal[] = [
        {
          name: 'Watford SWD 1',
          companyId: 'company-mike',
          lat: 47.82,
          lng: -103.30,
        },
      ];

      const resA = sequencePickupAndDisposalLegs(
        origin,
        wellAContext,
        commonDisposal,
        'Watford SWD 1',
        asOfMs,
        repo,
      );

      const resB = sequencePickupAndDisposalLegs(
        origin,
        wellBContext,
        commonDisposal,
        'Watford SWD 1',
        asOfMs,
        repo,
      );

      // Travel to pickup: Well A = 40m, Well B = 30m
      expect(resA.originToPickupLeg.estimatedTravelMinutes).toBe(40);
      expect(resB.originToPickupLeg.estimatedTravelMinutes).toBe(30);

      // Ranking: Well B's transit to pickup is faster than Well A's governed detour
      expect(resB.originToPickupLeg.estimatedTravelMinutes!).toBeLessThan(
        resA.originToPickupLeg.estimatedTravelMinutes!,
      );

      // Well A carries the restriction flag
      expect(resA.originToPickupLeg.restrictions).toContain('road_closed');
      expect(resB.originToPickupLeg.restrictions).not.toContain('road_closed');
    });
  });

  describe('Driver History Outranking Unsafe Map Shortcut', () => {
    it('uses driver history when sampleCount >= 3 and confidence >= 0.7 to bypass unsafe road', () => {
      const repo: GovernedRoutingRepository = {
        restrictions: [
          {
            id: 'truck-ban-old-trail',
            roadName: 'Old Trail',
            prohibitedTrucks: true,
            active: true,
          },
        ],
        naiveMapEstimates: [
          {
            originName: 'Staging',
            destName: 'Well Charlie',
            estimatedMinutes: 25,
            viaRoads: ['Old Trail'], // Prohibited for trucks!
          },
        ],
        travelHistory: [
          {
            originName: 'Staging',
            destName: 'Well Charlie',
            sampleCount: 8,
            medianMinutes: 42,
            confidence: 0.88,
            viaRoads: ['Highway 200', 'County 5'],
          },
        ],
      };

      const leg = evaluateLegTravel(
        {
          legType: 'origin_to_pickup',
          origin: { lat: 47.5, lng: -103.5, label: 'Staging' },
          destination: { lat: 47.7, lng: -103.6, label: 'Well Charlie' },
          companyId: 'company-test',
        },
        repo,
      );

      expect(leg.travelBasis).toBe('driver_history');
      expect(leg.estimatedTravelMinutes).toBe(42);
      expect(leg.confidence).toBe(0.88);
      expect(leg.sampleCount).toBe(8);
      expect(leg.restrictions).toContain('prohibited_truck');
      expect(leg.reasonCode).toBe('DRIVER_HISTORY_SAFE_DETOUR');
    });
  });

  describe('Disposal Selection Driven by Verified Travel Choice', () => {
    it('selects faster verified disposal over slower historical favorite after eligibility filtering', () => {
      const repo: GovernedRoutingRepository = {
        corridors: [
          {
            corridorId: 'corridor-to-disp-fast',
            originName: 'Well Delta',
            destName: 'Fast Verified SWD',
            travelMinutes: 18,
            isApproved: true,
            viaRoads: ['Highway 85'],
          },
          {
            corridorId: 'corridor-to-disp-slow',
            originName: 'Well Delta',
            destName: 'Slow Historical SWD',
            travelMinutes: 38,
            isApproved: true,
            viaRoads: ['County Road 10'],
          },
        ],
      };

      const wellContext: WellRoutingContext = {
        wellName: 'Well Delta',
        companyId: 'company-test',
        lat: 47.8,
        lng: -103.2,
        predictedReadyAtMs: asOfMs,
        priorityState: 'pull-now',
      };

      const candidateDisposals: CandidateDisposal[] = [
        {
          name: 'Blacklisted Closest SWD',
          companyId: 'company-test',
          isBlacklisted: true, // Rule 2: Excluded
          lat: 47.81,
          lng: -103.21,
        },
        {
          name: 'Slow Historical SWD',
          companyId: 'company-test',
          lat: 47.95,
          lng: -103.45,
        },
        {
          name: 'Fast Verified SWD',
          companyId: 'company-test',
          lat: 47.85,
          lng: -103.25,
        },
      ];

      // Driver historically preferred 'Slow Historical SWD'
      const res = sequencePickupAndDisposalLegs(
        { lat: 47.7, lng: -103.1, label: 'Origin' },
        wellContext,
        candidateDisposals,
        'Slow Historical SWD', // Historical preference
        asOfMs,
        repo,
      );

      // Fast Verified SWD (18m) must be chosen over Slow Historical SWD (38m)
      expect(res.selectedDisposalName).toBe('Fast Verified SWD');
      expect(res.pickupToDisposalLeg.estimatedTravelMinutes).toBe(18);
      expect(res.pickupToDisposalLeg.travelBasis).toBe('approved_corridor');
    });
  });

  describe('Honest Fail-Safe Contract when Governed Routing Data is Absent', () => {
    it('returns ROUTE_UNVERIFIED with ROUTING_DATA_UNAVAILABLE when repo is empty', () => {
      const wellContext: WellRoutingContext = {
        wellName: 'Well Echo',
        companyId: 'company-test',
        lat: 47.8,
        lng: -103.2,
        predictedReadyAtMs: asOfMs + 10 * 60 * 1000,
        priorityState: 'approaching',
      };

      const res = sequencePickupAndDisposalLegs(
        { lat: 47.7, lng: -103.1, label: 'Device Location' },
        wellContext,
        [{ name: 'Some SWD', companyId: 'company-test' }],
        'Some SWD',
        asOfMs,
        undefined, // NO repo provided
      );

      expect(res.routeVerificationStatus).toBe('ROUTE_UNVERIFIED');
      expect(res.originToPickupLeg.travelBasis).toBe('unverified');
      expect(res.originToPickupLeg.confidence).toBe(0);
      expect(res.originToPickupLeg.sampleCount).toBe(0);
      expect(res.originToPickupLeg.estimatedTravelMinutes).toBeNull();
      expect(res.originToPickupLeg.reasonCode).toBe('ROUTING_DATA_UNAVAILABLE');

      expect(res.pickupToDisposalLeg.travelBasis).toBe('unverified');
      expect(res.pickupToDisposalLeg.estimatedTravelMinutes).toBeNull();

      expect(res.cycleTime.travelToPickupMinutes).toBeNull();
      expect(res.cycleTime.travelToDisposalMinutes).toBeNull();
      expect(res.cycleTime.totalCycleMinutes).toBeNull();
      expect(res.cycleTime.loadingMinutes).toBe(30);
      expect(res.cycleTime.unloadingMinutes).toBe(30);
    });
  });
});
