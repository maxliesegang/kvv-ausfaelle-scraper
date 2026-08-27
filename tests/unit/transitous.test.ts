import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Cancellation } from '../../src/types.js';
import {
  mapTransitousJourney,
  selectTransitousCandidates,
  type TransitousItinerary,
  type TransitousStopTime,
} from '../../src/verification/transitous.js';
import {
  keepOnlyStrongTransitousClaims,
  transitousProvider,
} from '../../src/verification/transitous-provider.js';
import { verifyWithProviders, type VerificationProvider } from '../../src/verification/provider.js';
import { selectAcrossSources } from '../../src/verification/selection.js';
import {
  classifyJourney,
  type TripVerification,
  type VerificationSource,
} from '../../src/verification/verify.js';

const NOW = new Date('2026-08-13T20:00:00.000Z');

const trip: Cancellation = {
  line: 'S11',
  date: '2026-08-13',
  stand: '2026-08-13T01:00:00.000Z',
  trainNumber: '20019',
  fromStop: 'Ittersbach Rathaus',
  fromTime: '09:21',
  toStop: 'Ettlingen Stadt',
  toTime: '09:45',
  sourceUrl: 'https://example.invalid/article',
  capturedAt: '2026-08-13T05:00:00.000Z',
  cause: 'operational',
  causeKeyword: null,
};

function fixture(name: string): {
  candidate: TransitousStopTime;
  itinerary: TransitousItinerary;
} {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'test-data', 'transitous', `${name}.json`), 'utf8'),
  ) as { candidate: TransitousStopTime; itinerary: TransitousItinerary };
}

function verification(
  source: VerificationSource,
  overrides: Partial<TripVerification> = {},
): TripVerification {
  return {
    status: 'no-data',
    methodVersion: 7,
    source,
    checkedAt: '2026-08-13',
    segmentStops: 3,
    segmentCancelledStops: 0,
    segmentTrackedStops: 0,
    journeyStops: 3,
    journeyCancelledStops: 0,
    journeyTrackedStops: 0,
    trackedOutsideSegment: 0,
    trackedAdjacentStops: 0,
    ...overrides,
  };
}

describe('Transitous verification adapter', () => {
  it('finds the exact AVG train and rejects reused numbers from another operator', () => {
    const exact = fixture('cancelled-trip').candidate;
    const candidates = selectTransitousCandidates(trip, [
      { ...exact, tripId: 'foreign', agencyName: 'SNCF' },
      { ...exact, tripId: 'wrong-number', tripShortName: '99999' },
      exact,
    ]);
    assert.deepStrictEqual(
      candidates.map((candidate) => candidate.tripId),
      [exact.tripId],
    );
  });

  it('preserves Transitous explicit trip and stop cancellation flags', () => {
    const { candidate, itinerary } = fixture('cancelled-trip');
    const details = mapTransitousJourney(itinerary, candidate);
    assert.ok(details);
    const verdict = classifyJourney(trip, details, NOW, 'transitous');
    assert.strictEqual(verdict?.source, 'transitous');
    assert.strictEqual(verdict?.status, 'cancelled');
    assert.strictEqual(verdict?.journeyCancelled, true);
    assert.strictEqual(verdict?.segmentCancelledStops, 3);
  });

  it('does not turn a leg-wide realtime forecast into a fully observed run', () => {
    const { candidate, itinerary } = fixture('forecast-trip');
    const details = mapTransitousJourney(itinerary, candidate);
    assert.ok(details);
    const verdict = classifyJourney(trip, details, NOW, 'transitous');
    assert.strictEqual(verdict?.status, 'no-data');
    assert.strictEqual(verdict?.segmentTrackedStops, 0);
  });

  it('does not infer a Transitous cancellation from silence without a cancellation flag', () => {
    const inferred = verification('transitous', {
      status: 'cancelled',
      journeyStops: 10,
      trackedOutsideSegment: 7,
      trackedAdjacentStops: 1,
    });
    assert.strictEqual(keepOnlyStrongTransitousClaims(inferred).status, 'no-data');
  });

  it('limits the live fallback to settled trips inside its one-day window', () => {
    assert.strictEqual(transitousProvider.canCheck(trip, NOW), true);
    assert.strictEqual(
      transitousProvider.canCheck(trip, new Date('2026-08-15T20:00:00.000Z')),
      false,
    );
  });
});

describe('provider orchestration', () => {
  it('tries the fallback after a provisional result and stops at a conclusive result', async () => {
    const calls: string[] = [];
    const providers: readonly VerificationProvider[] = [
      {
        source: 'bahn.expert',
        canCheck: () => true,
        verify: async () => {
          calls.push('bahn.expert');
          return verification('bahn.expert');
        },
      },
      {
        source: 'transitous',
        canCheck: () => true,
        verify: async () => {
          calls.push('transitous');
          return verification('transitous', { status: 'ran' });
        },
      },
    ];

    const result = await verifyWithProviders(trip, NOW, providers);

    assert.deepStrictEqual(calls, ['bahn.expert', 'transitous']);
    assert.deepStrictEqual(result.attemptedSources, ['bahn.expert', 'transitous']);
    assert.deepStrictEqual(
      result.verifications.map(({ source, status }) => `${source}:${status}`),
      ['bahn.expert:no-data', 'transitous:ran'],
    );
  });

  it('continues after a provider failure and returns the failure for reporting', async () => {
    const result = await verifyWithProviders(trip, NOW, [
      {
        source: 'bahn.expert',
        canCheck: () => true,
        verify: async () => {
          throw new Error('gateway unavailable');
        },
      },
      {
        source: 'transitous',
        canCheck: () => true,
        verify: async () => verification('transitous', { status: 'no-data' }),
      },
    ]);

    assert.strictEqual(result.failures.length, 1);
    assert.strictEqual(result.failures[0]?.source, 'bahn.expert');
    assert.strictEqual(result.failures[0]?.error instanceof Error, true);
    assert.strictEqual(result.verifications[0]?.source, 'transitous');
  });
});

describe('cross-source selection', () => {
  it('selects explicit Transitous cancellation over bahn.expert no-data and stores both checks', () => {
    const choice = selectAcrossSources(undefined, [
      verification('bahn.expert'),
      verification('transitous', {
        status: 'cancelled',
        segmentCancelledStops: 3,
        journeyCancelledStops: 3,
        journeyCancelled: true,
      }),
    ]);
    assert.strictEqual(choice.verification.source, 'transitous');
    assert.strictEqual(choice.verification.status, 'cancelled');
    assert.deepStrictEqual(Object.keys(choice.verification.checks ?? {}).sort(), [
      'bahn.expert',
      'transitous',
    ]);
    assert.strictEqual(choice.verification.agreement, 'single-source');
  });

  it('marks credible cancellation-versus-ran evidence as conflicting', () => {
    const choice = selectAcrossSources(undefined, [
      verification('bahn.expert', { status: 'ran', segmentTrackedStops: 3 }),
      verification('transitous', {
        status: 'cancelled',
        segmentCancelledStops: 3,
        journeyCancelledStops: 3,
      }),
    ]);
    assert.strictEqual(choice.verification.status, 'cancelled');
    assert.strictEqual(choice.verification.agreement, 'conflicting');
  });

  it('ratchets evidence independently within each source', () => {
    const previous = selectAcrossSources(undefined, [
      verification('bahn.expert', { status: 'ran', segmentTrackedStops: 3 }),
      verification('transitous'),
    ]).verification;
    const choice = selectAcrossSources(previous, [verification('transitous')]);
    assert.strictEqual(choice.verification.source, 'bahn.expert');
    assert.strictEqual(choice.verification.status, 'ran');
    assert.strictEqual(choice.verification.checks?.['bahn.expert']?.segmentTrackedStops, 3);
  });
});
