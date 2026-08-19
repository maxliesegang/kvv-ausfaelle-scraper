/**
 * Unit tests for trip back-verification.
 *
 * Covers the devalue codec (the wire format bahn.expert requires) and the verdict logic, with the
 * emphasis on segment scoping — the rule that a KVV notice names an affected *segment*, not a
 * trip's endpoints. No network access: every journey here is a literal fixture.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { Cancellation } from '../../src/types.js';
import { loadJourneyFixture } from '../helpers/fixture-loader.js';
import { parseDevalue, stringifyDevalue } from '../../src/verification/devalue.js';
import {
  findJourneys,
  orderJourneyCandidates,
  type JourneyStop,
} from '../../src/verification/bahn-expert.js';
import {
  MAX_ATTEMPTS,
  isVerifiable,
  needsCheck,
  retainStrongerVerdict,
  withAttemptCount,
} from '../../src/verification/selection.js';
import {
  classifyJourney,
  createJourneyMismatchVerification,
  createUnresolvedVerification,
  determineStatus,
  locateSegment,
  matchesNetworkOperator,
  type SegmentCounts,
  type TripVerification,
  type VerificationStatus,
  VERIFICATION_METHOD_VERSION,
} from '../../src/verification/verify.js';

const NOW = new Date('2026-08-13T20:00:00.000Z');

function tripOn(overrides: Partial<Cancellation> = {}): Cancellation {
  return {
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
    ...overrides,
  } as Cancellation;
}

/**
 * Builds a stop in the feed's own encoding.
 *
 * The default is a **timetable-only** stop, and it deliberately carries `delay: 0` with
 * `isRealTime: null` — that is what bahn.expert sends for a stop it has not observed, and reading
 * that delay as evidence of a tracked vehicle was the original bug. Pass `delay` to make the stop
 * observed; it sets `isRealTime` too, exactly as the feed does.
 */
function stop(
  name: string,
  berlinClock: string,
  options: { delay?: number; cancelled?: boolean } = {},
): JourneyStop {
  const [hours, minutes] = berlinClock.split(':');
  // Europe/Berlin is UTC+2 on this date.
  const utcHour = String(Number(hours) - 2).padStart(2, '0');
  const scheduledTime = `2026-08-13T${utcHour}:${minutes}:00.000Z`;
  const observed = options.delay !== undefined;
  const event = {
    scheduledTime,
    time: scheduledTime,
    delay: observed ? options.delay : 0,
    isRealTime: observed ? true : null,
    cancelled: options.cancelled ?? null,
  };
  return {
    stopPlace: { name },
    arrival: event,
    departure: event,
    cancelled: options.cancelled ?? null,
  };
}

describe('devalue codec', () => {
  it('encodes the root representation inline at index 0', () => {
    assert.deepStrictEqual(stringifyDevalue('20260813-abc'), ['20260813-abc']);
  });

  it('encodes objects as index references, matching the client wire form', () => {
    const encoded = stringifyDevalue({
      journeyNumber: 85414,
      initialDepartureDate: new Date('2026-08-13T16:14:18.316Z'),
      withOEV: false,
    });
    assert.deepStrictEqual(encoded, [
      { journeyNumber: 1, initialDepartureDate: 2, withOEV: 3 },
      85414,
      ['Date', '2026-08-13T16:14:18.316Z'],
      false,
    ]);
  });

  it('round-trips nested structures', () => {
    const value = { stops: [{ name: 'A' }, { name: 'B' }], cancelled: true };
    assert.deepStrictEqual(parseDevalue(stringifyDevalue(value)), value);
  });

  it('treats a slot holding a bare number as a literal, not a reference', () => {
    // The regression that broke the first decoder: flat[1] = 84805 is the train number itself,
    // and following it as an index walks past the end of the array.
    assert.deepStrictEqual(parseDevalue([{ journeyNumber: 1 }, 84805]), { journeyNumber: 84805 });
  });

  it('decodes tagged Date values', () => {
    assert.deepStrictEqual(parseDevalue([{ at: 1 }, ['Date', '2026-08-13T05:35:00.000Z']]), {
      at: '2026-08-13T05:35:00.000Z',
    });
  });
});

describe('bahn.expert client errors', () => {
  it('throws on a tRPC error returned with HTTP 200 instead of treating it as no results', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify([{ error: { json: { message: 'upstream unavailable', code: -32000 } } }]),
        { status: 200 },
      );
    try {
      await assert.rejects(
        findJourneys(20019, new Date('2026-08-13T08:00:00.000Z'), 1000),
        /journey\.find failed: upstream unavailable/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('journey candidate ordering', () => {
  it('tries the exact line, then AVG and other rail candidates, before same-number buses', () => {
    const ordered = orderJourneyCandidates(
      [
        { journeyId: 'bus', train: { line: '283', category: 'Bus', transportType: 'BUS' } },
        { journeyId: 'other-s-line', train: { line: 'S71', transportType: 'CITY_TRAIN' } },
        { journeyId: 'avg-alias', train: { line: 'S52', category: 'AVG' } },
        { journeyId: 'exact', train: { line: 'S5', category: 'AVG' } },
      ],
      'S5',
    );
    assert.deepStrictEqual(
      ordered.map((candidate) => candidate.journeyId),
      ['exact', 'avg-alias', 'other-s-line', 'bus'],
    );
  });
});

describe('segment location', () => {
  it('scopes to the announced segment rather than the whole journey', () => {
    const stops = [
      stop('Ittersbach Rathaus', '09:21'),
      stop('Busenbach', '09:40'),
      stop('Ettlingen Stadt', '09:48'),
      stop('Karlsruhe Albtalbahnhof', '10:03'),
      stop('Karlsruhe-Neureut Kirchfeld', '10:31'),
    ];
    assert.deepStrictEqual(locateSegment(tripOn(), stops), { start: 0, end: 2 });
  });

  it('returns null when no stop matches the announced departure', () => {
    assert.strictEqual(locateSegment(tripOn(), [stop('Somewhere', '14:00')]), null);
  });

  it('uses the stop name to disambiguate dense-corridor departure times', () => {
    const stops = [
      stop('Söllingen (b Karlsr)', '18:18'),
      stop('Weinweg, Karlsruhe', '18:39'),
      stop('Tullastraße/Alter Schlachthof, Karlsruhe', '18:41'),
      stop('Karlsruhe-Kniel. Rheinbergstr.', '19:04'),
    ];
    const trip = tripOn({
      line: 'S5',
      fromStop: 'KA Tullastraße',
      fromTime: '18:41',
      toStop: 'Knielingen Rheinbergstraße',
      toTime: '19:04',
    });
    assert.deepStrictEqual(locateSegment(trip, stops), { start: 2, end: 3 });
  });

  it('does not let a generic city token beat the actual destination', () => {
    const stops = [
      stop('Söllingen (b Karlsr)', '08:48'),
      stop('Durlach Hubstraße, Karlsruhe', '09:04'),
      stop('Tullastraße/Alter Schlachthof, Karlsruhe', '09:11'),
    ];
    const trip = tripOn({
      line: 'S5',
      fromStop: 'Söllingen Bahnhof',
      fromTime: '08:48',
      toStop: 'Karlsruhe Tullastr.',
      toTime: '09:10',
    });
    assert.deepStrictEqual(locateSegment(trip, stops), { start: 0, end: 2 });
  });

  it("matches a short KVV stop name against the feed's compound stop name", () => {
    const stops = [
      stop('Tullastraße/Alter Schlachthof, Karlsruhe', '12:17'),
      stop('Karlsruhe Albtalbahnhof', '12:32'),
      stop('Achern', '13:25'),
    ];
    const trip = tripOn({
      line: 'S7',
      fromStop: 'Tullastraße',
      fromTime: '12:17',
      toStop: 'Achern',
      toTime: '13:25',
    });
    assert.deepStrictEqual(locateSegment(trip, stops), { start: 0, end: 2 });
  });

  it('matches a short street stop against feed locality and district prefixes', () => {
    // Live 84957 was the exact AVG S5 candidate at the exact published times, but the symmetric
    // token score rejected its origin: one KVV token versus three feed tokens scored only 0.5.
    const stops = [
      stop('Karlsruhe-Kniel. Rheinbergstr.', '05:02'),
      stop('Söllingen (b Karlsr)', '05:48'),
      stop('Pforzheim Hbf', '06:11'),
    ];
    const trip = tripOn({
      line: 'S5',
      trainNumber: '84957',
      fromStop: 'Rheinbergstraße',
      fromTime: '05:02',
      toStop: 'Pforzheim Hbf.',
      toTime: '06:11',
    });
    assert.deepStrictEqual(locateSegment(trip, stops), { start: 0, end: 2 });
  });

  it('accepts one stale endpoint time when both names match and the other time is exact', () => {
    // Live S1 10004: KVV said 05:52 at Hochstetten, the feed said 05:33, and both agreed on the
    // named 06:42 destination. The exact second anchor makes the wider first delta safe.
    const stops = [stop('Hochstetten', '05:33'), stop('Albgaubad, Ettlingen', '06:42')];
    const trip = tripOn({
      line: 'S1',
      trainNumber: '10004',
      fromStop: 'Hochstetten',
      fromTime: '05:52',
      toStop: 'Ettlingen Albgaubad',
      toTime: '06:42',
    });
    assert.deepStrictEqual(locateSegment(trip, stops), { start: 0, end: 1 });
  });

  it('uses a unique exact schedule pair when neither endpoint name is recognisable', () => {
    const stops = [
      stop('Feed origin', '09:21'),
      stop('Middle', '09:35'),
      stop('Feed end', '09:45'),
    ];
    const trip = tripOn({ fromStop: 'KVV origin', toStop: 'KVV destination' });
    assert.deepStrictEqual(locateSegment(trip, stops), { start: 0, end: 2 });
  });

  it('rejects a time-only fallback when more than one ordered pair fits', () => {
    const stops = [
      stop('First origin', '09:21'),
      stop('Second origin', '09:21'),
      stop('Feed end', '09:45'),
    ];
    const trip = tripOn({ fromStop: 'KVV origin', toStop: 'KVV destination' });
    assert.strictEqual(locateSegment(trip, stops), null);
  });

  it('normalizes Bahnhof when KVV attaches it to the specific station name', () => {
    const stops = [stop('Karlsruhe-Neureut Kirchfeld', '10:35'), stop('Ettlingen Stadt', '11:18')];
    const trip = tripOn({
      fromStop: 'Neureut Kirchfeld',
      fromTime: '10:35',
      toStop: 'Ettlingen Stadtbahnhof',
      toTime: '11:18',
    });
    assert.deepStrictEqual(locateSegment(trip, stops), { start: 0, end: 1 });
  });

  it('does not mistake a municipality qualifier for the named origin', () => {
    const stops = [
      stop('Hochstetten Altenheim, Linkenheim-Hochstetten', '05:34'),
      stop('Hochstetten Grenzstraße', '05:36'),
      stop('Linkenheim Süd, Linkenheim-Hochstetten', '05:42'),
      stop('Albgaubad, Ettlingen', '06:42'),
    ];
    const trip = tripOn({
      line: 'S1',
      fromStop: 'Hochstetten',
      fromTime: '05:52',
      toStop: 'Ettlingen Albgaubad',
      toTime: '06:42',
    });
    assert.strictEqual(locateSegment(trip, stops), null);
  });

  it('prefers the named station over a regional qualifier despite a source time offset', () => {
    const stops = [
      stop('Bondorf (b Herrenberg)', '08:02'),
      stop('Schopfloch (b Freudenstadt)', '08:30'),
      stop('Freudenstadt Hbf', '08:53'),
    ];
    const trip = tripOn({
      line: 'S8',
      fromStop: 'Bondorf Bahnhof',
      fromTime: '08:02',
      toStop: 'Freudenstadt Bahnhof',
      toTime: '08:43',
    });
    assert.deepStrictEqual(locateSegment(trip, stops), { start: 0, end: 2 });
  });

  it('tolerates a one-character stop typo but never accepts a time-only match', () => {
    const trip = tripOn({
      line: 'S5',
      fromStop: 'Wörh Badepark',
      fromTime: '07:35',
      toStop: 'Söllingen Bahnhof',
      toTime: '08:37',
    });
    const realJourney = [
      stop('Wörth (Rhein) Badepark', '07:35'),
      stop('Philippstraße, Karlsruhe', '08:03'),
      stop('Söllingen (b Karlsr)', '08:37'),
    ];
    assert.deepStrictEqual(locateSegment(trip, realJourney), { start: 0, end: 2 });
    assert.strictEqual(locateSegment(trip, realJourney.slice(1)), null);
  });

  it('rejects the same train and endpoints when both published times describe another run', () => {
    // KVV published 84805 as 08:05–09:09 on 2026-08-17, while bahn.expert's only AVG 84805 was
    // 07:35–08:37. Matching names alone called that earlier train `ran` with false confidence.
    const trip = tripOn({
      line: 'S5',
      trainNumber: '84805',
      fromStop: 'Wörh Badepark',
      fromTime: '08:05',
      toStop: 'Söllingen Bahnhof',
      toTime: '09:09',
    });
    const earlierJourney = [
      stop('Wörth (Rhein) Badepark', '07:35', { delay: 0 }),
      stop('Söllingen (b Karlsr)', '08:37', { delay: 0 }),
    ];
    assert.strictEqual(locateSegment(trip, earlierJourney), null);
  });
});

describe('trip selection', () => {
  // 2026-08-13 12:00 Berlin, i.e. after the 09:45 segment end the default trip uses.
  const NOW_MS = Date.parse('2026-08-13T10:00:00.000Z');
  const NEXT_DAY_MS = Date.parse('2026-08-14T10:00:00.000Z');
  const verified = (overrides: Partial<TripVerification>): TripVerification => ({
    status: 'cancelled',
    methodVersion: VERIFICATION_METHOD_VERSION,
    source: 'bahn.expert',
    checkedAt: '2026-08-13',
    segmentStops: 3,
    segmentCancelledStops: 3,
    segmentTrackedStops: 0,
    journeyStops: 3,
    journeyCancelledStops: 3,
    journeyTrackedStops: 0,
    trackedOutsideSegment: 0,
    ...overrides,
  });

  it('skips a trip whose segment has not started yet', () => {
    assert.strictEqual(isVerifiable(tripOn({ fromTime: '23:50' }), NOW_MS), false);
  });

  it('skips a trip whose segment ended within the settling grace period', () => {
    assert.strictEqual(isVerifiable(tripOn({ fromTime: '10:30', toTime: '11:45' }), NOW_MS), false);
  });

  it('waits for the whole announced segment instead of checking a long trip mid-run', () => {
    assert.strictEqual(isVerifiable(tripOn({ fromTime: '09:00', toTime: '12:30' }), NOW_MS), false);
  });

  it('waits for a segment that ends after midnight', () => {
    const beforeEnd = Date.parse('2026-08-13T22:15:00.000Z'); // 00:15 Berlin on August 14
    const afterGrace = Date.parse('2026-08-13T23:00:00.000Z'); // 01:00 Berlin on August 14
    const overnight = tripOn({ fromTime: '23:30', toTime: '00:20' });
    assert.strictEqual(isVerifiable(overnight, beforeEnd), false);
    assert.strictEqual(isVerifiable(overnight, afterGrace), true);
  });

  it('accepts a departed trip inside the lookback window', () => {
    assert.strictEqual(isVerifiable(tripOn(), NOW_MS), true);
  });

  it('uses the measured rolling seven-day cutoff instead of dropping the whole seventh day', () => {
    assert.strictEqual(
      isVerifiable(tripOn({ date: '2026-08-06', fromTime: '12:00' }), NOW_MS),
      true,
    );
    assert.strictEqual(
      isVerifiable(tripOn({ date: '2026-08-06', fromTime: '11:59' }), NOW_MS),
      false,
    );
  });

  it('skips a trip older than the feed window', () => {
    assert.strictEqual(isVerifiable(tripOn({ date: '2026-08-01' }), NOW_MS), false);
  });

  it('checks a trip that has never been verified', () => {
    assert.strictEqual(needsCheck(tripOn(), false, NOW_MS), true);
  });

  it('leaves a settled verdict alone', () => {
    const trip = tripOn({ verification: verified({ attempts: 1 }) });
    assert.strictEqual(needsCheck(trip, false, NOW_MS), false);
  });

  it('rechecks an older matching method even when its retry budget is exhausted', () => {
    const old = verified({
      status: 'unresolved',
      methodVersion: VERIFICATION_METHOD_VERSION - 1,
      attempts: MAX_ATTEMPTS,
    });
    assert.strictEqual(needsCheck(tripOn({ verification: old }), false, NOW_MS), true);
  });

  it('retries a provisional verdict on a later day until the attempt limit', () => {
    const atLimit = MAX_ATTEMPTS;
    const retryable = tripOn({ verification: verified({ status: 'unresolved', attempts: 1 }) });
    const exhausted = tripOn({
      verification: verified({ status: 'unresolved', attempts: atLimit }),
    });
    assert.strictEqual(needsCheck(retryable, false, NEXT_DAY_MS), true);
    assert.strictEqual(needsCheck(exhausted, false, NEXT_DAY_MS), false);
    // `--recheck` ignores the budget entirely.
    assert.strictEqual(needsCheck(exhausted, true, NOW_MS), true);
  });

  it('does not spend multiple provisional attempts on the same day', () => {
    const retryable = tripOn({ verification: verified({ status: 'no-data', attempts: 1 }) });
    assert.strictEqual(needsCheck(retryable, false, NOW_MS), false);
    assert.strictEqual(needsCheck(retryable, false, NEXT_DAY_MS), true);
  });

  it('rechecks a partial verdict because late evidence can settle it', () => {
    const partial = tripOn({ verification: verified({ status: 'partial', attempts: 1 }) });
    assert.strictEqual(needsCheck(partial, false, NOW_MS), false);
    assert.strictEqual(needsCheck(partial, false, NEXT_DAY_MS), true);
  });

  it('counts attempts cumulatively across runs while a verdict stays provisional', () => {
    const first = withAttemptCount(verified({ status: 'unresolved' }), undefined);
    assert.strictEqual(first.attempts, 1);
    assert.strictEqual(withAttemptCount(verified({ status: 'no-data' }), first).attempts, 2);
  });

  it('counts a legacy partial without attempts as an existing first check', () => {
    const legacyPartial = verified({ status: 'partial' });
    assert.strictEqual(withAttemptCount(legacyPartial, legacyPartial).attempts, 2);
  });

  it('drops the attempt count once a verdict settles', () => {
    // `needsCheck` reads `attempts` only for provisional verdicts, so on a settled one it is a
    // number nothing will consult again — and one paid for on every departed trip.
    const provisional = withAttemptCount(verified({ status: 'no-data' }), undefined);
    const settled = withAttemptCount(verified({ status: 'cancelled' }), provisional);
    assert.strictEqual(settled.attempts, undefined);
    assert.ok(!('attempts' in settled), 'the key is absent, not merely undefined');
    // Dropping it cannot revive a retry: a settled verdict is not re-checked at all.
    assert.strictEqual(needsCheck(tripOn({ verification: settled }), false, NEXT_DAY_MS), false);
  });

  // The feed thins realtime out of a journey as the day recedes, so a later look at the same trip
  // sees strictly less than the first one did. Every case here is taken from the 2026-08-13
  // recheck, where decay alone turned `ran` into `no-data` and `partial` into `cancelled`.
  describe('evidence ratchet', () => {
    const ran = verified({ status: 'ran', segmentCancelledStops: 0, segmentTrackedStops: 13 });
    const partial = verified({
      status: 'partial',
      segmentCancelledStops: 1,
      segmentTrackedStops: 1,
    });

    it('takes a fresh verdict when the trip has never been verified', () => {
      const choice = retainStrongerVerdict(undefined, ran);
      assert.strictEqual(choice.retainedPrevious, false);
      assert.strictEqual(choice.verification.status, 'ran');
      // Settled on the first look, so it never needs an attempt count.
      assert.strictEqual(choice.verification.attempts, undefined);
    });

    it('counts the attempt when a first look lands provisional', () => {
      const choice = retainStrongerVerdict(undefined, verified({ status: 'unresolved' }));
      assert.strictEqual(choice.verification.attempts, 1);
    });

    it('discards a re-check that lost the observations behind a `ran` verdict', () => {
      const decayed = verified({
        status: 'no-data',
        segmentCancelledStops: 0,
        segmentTrackedStops: 0,
      });
      const choice = retainStrongerVerdict(ran, decayed);
      assert.strictEqual(choice.retainedPrevious, true);
      assert.strictEqual(choice.verification.status, 'ran');
      assert.strictEqual(choice.verification.segmentTrackedStops, 13);
    });

    it('discards a re-check that would turn `partial` into `cancelled` by losing evidence', () => {
      const decayed = verified({
        status: 'cancelled',
        segmentCancelledStops: 0,
        segmentTrackedStops: 0,
      });
      const choice = retainStrongerVerdict(partial, decayed);
      assert.strictEqual(choice.retainedPrevious, true);
      assert.strictEqual(choice.verification.status, 'partial');
    });

    it('dates retained evidence to the fresh check so retries remain daily', () => {
      const previous = verified({
        status: 'partial',
        segmentCancelledStops: 1,
        segmentTrackedStops: 12,
        attempts: 1,
      });
      const decayed = verified({
        status: 'cancelled',
        checkedAt: '2026-08-14',
        segmentCancelledStops: 1,
        segmentTrackedStops: 0,
      });
      const choice = retainStrongerVerdict(previous, decayed);
      assert.strictEqual(choice.retainedPrevious, true);
      assert.strictEqual(choice.verification.checkedAt, '2026-08-14');
      assert.strictEqual(choice.verification.attempts, 2);
      assert.strictEqual(
        needsCheck(tripOn({ verification: choice.verification }), false, NEXT_DAY_MS),
        false,
      );
    });

    it('keeps retries bounded when a provisional verdict is re-checked', () => {
      // Retention can only ever keep a *settled* verdict — a provisional one carries zero evidence
      // by definition, so no fresh verdict can be weaker than it. The bound therefore lives on the
      // path where the fresh verdict wins, and it is the attempt count that has to survive there.
      const stale = verified({
        status: 'no-data',
        segmentCancelledStops: 0,
        segmentTrackedStops: 0,
        attempts: 1,
      });
      const again = verified({
        status: 'no-data',
        segmentCancelledStops: 0,
        segmentTrackedStops: 0,
      });
      const choice = retainStrongerVerdict(stale, again);
      assert.strictEqual(choice.retainedPrevious, false);
      assert.strictEqual(choice.verification.attempts, 2);
    });

    it('discards the attempt count when a decayed re-check keeps a settled verdict', () => {
      const previous = { ...ran, attempts: 1 };
      const decayed = verified({
        status: 'no-data',
        segmentCancelledStops: 0,
        segmentTrackedStops: 0,
      });
      const choice = retainStrongerVerdict(previous, decayed);
      assert.strictEqual(choice.retainedPrevious, true);
      assert.strictEqual(choice.verification.attempts, undefined);
    });

    it('accepts late-arriving evidence, which is what makes a retry worth doing', () => {
      const noData = verified({
        status: 'no-data',
        segmentCancelledStops: 0,
        segmentTrackedStops: 0,
      });
      const arrived = verified({ status: 'cancelled', segmentCancelledStops: 3 });
      const choice = retainStrongerVerdict(noData, arrived);
      assert.strictEqual(choice.retainedPrevious, false);
      assert.strictEqual(choice.verification.status, 'cancelled');
    });

    it('prioritizes new explicit cancellation flags over decayed tracking', () => {
      const previous = verified({
        status: 'partial',
        segmentCancelledStops: 1,
        segmentTrackedStops: 12,
      });
      const settled = verified({
        status: 'cancelled',
        segmentCancelledStops: 3,
        segmentTrackedStops: 0,
      });
      const choice = retainStrongerVerdict(previous, settled);
      assert.strictEqual(choice.retainedPrevious, false);
      assert.strictEqual(choice.verification.status, 'cancelled');
    });

    it('does not erase explicit cancellation flags when tracking later increases', () => {
      const previous = verified({
        status: 'partial',
        segmentCancelledStops: 2,
        segmentTrackedStops: 1,
      });
      const contradictory = verified({
        status: 'ran',
        segmentCancelledStops: 0,
        segmentTrackedStops: 3,
      });
      const choice = retainStrongerVerdict(previous, contradictory);
      assert.strictEqual(choice.retainedPrevious, true);
      assert.strictEqual(choice.verification.segmentCancelledStops, 2);
    });

    it('does not erase an explicit journey-level cancellation flag', () => {
      const explicit = verified({
        status: 'cancelled',
        journeyCancelled: true,
        segmentCancelledStops: 0,
        segmentTrackedStops: 0,
      });
      const contradictory = verified({
        status: 'ran',
        segmentCancelledStops: 0,
        segmentTrackedStops: 3,
      });
      const choice = retainStrongerVerdict(explicit, contradictory);
      assert.strictEqual(choice.retainedPrevious, true);
      assert.strictEqual(choice.verification.journeyCancelled, true);
    });

    it('accepts corrected segment bounds instead of comparing counts across different scopes', () => {
      const wronglyScoped = verified({
        status: 'ran',
        segmentStops: 19,
        segmentTrackedStops: 19,
      });
      const corrected = verified({
        status: 'ran',
        segmentStops: 18,
        segmentTrackedStops: 18,
      });
      const choice = retainStrongerVerdict(wronglyScoped, corrected);
      assert.strictEqual(choice.retainedPrevious, false);
      assert.strictEqual(choice.verification.segmentStops, 18);
    });

    it('takes an equally-evidenced re-check, refreshing the verdict', () => {
      const later = { ...ran, checkedAt: '2026-08-14' };
      const choice = retainStrongerVerdict(ran, later);
      assert.strictEqual(choice.retainedPrevious, false);
      assert.strictEqual(choice.verification.checkedAt, '2026-08-14');
    });

    it('never lets an `unresolved` re-check erase a settled verdict', () => {
      const unresolved = verified({
        status: 'unresolved',
        segmentStops: 0,
        segmentCancelledStops: 0,
        segmentTrackedStops: 0,
      });
      const choice = retainStrongerVerdict(partial, unresolved);
      assert.strictEqual(choice.retainedPrevious, true);
      assert.strictEqual(choice.verification.status, 'partial');
    });

    it('lets a newer matching method correct a settled verdict from the legacy method', () => {
      const legacyRan = { ...ran, methodVersion: 1 };
      const rejectedByCurrentMatcher = verified({
        status: 'unresolved',
        segmentStops: 0,
        segmentCancelledStops: 0,
        segmentTrackedStops: 0,
        unresolvedReason: 'journey-mismatch',
      });
      const choice = retainStrongerVerdict(legacyRan, rejectedByCurrentMatcher);
      assert.strictEqual(choice.retainedPrevious, false);
      assert.strictEqual(choice.verification.status, 'unresolved');
      assert.strictEqual(choice.verification.methodVersion, VERIFICATION_METHOD_VERSION);
    });

    it('does not let feed expiry masquerade as a newer-method correction', () => {
      const legacyRan = { ...ran, methodVersion: 1 };
      const missingFromFeed = verified({
        status: 'unresolved',
        segmentStops: 0,
        segmentCancelledStops: 0,
        segmentTrackedStops: 0,
        unresolvedReason: 'journey-not-found',
      });
      const choice = retainStrongerVerdict(legacyRan, missingFromFeed);
      assert.strictEqual(choice.retainedPrevious, true);
      assert.strictEqual(choice.verification.status, 'ran');
      assert.strictEqual(choice.verification.methodVersion, VERIFICATION_METHOD_VERSION);
    });

    it('does not discard journey-wide evidence while a segment remains unresolved', () => {
      const evidence = verified({
        status: 'unresolved',
        segmentStops: 0,
        journeyStops: 30,
        journeyCancelledStops: 30,
        journeyCancelled: true,
      });
      const decayed = verified({
        status: 'unresolved',
        segmentStops: 0,
        journeyStops: 30,
        journeyCancelledStops: 0,
      });
      const choice = retainStrongerVerdict(evidence, decayed);
      assert.strictEqual(choice.retainedPrevious, true);
      assert.strictEqual(choice.verification.journeyCancelledStops, 30);
    });
  });
});

describe('verdict rules', () => {
  const counts = (overrides: Partial<SegmentCounts> = {}): SegmentCounts => ({
    segmentStops: 10,
    segmentCancelledStops: 0,
    segmentTrackedStops: 0,
    journeyStops: 10,
    journeyCancelledStops: 0,
    journeyTrackedStops: 0,
    trackedOutsideSegment: 0,
    ...overrides,
  });

  const cases: ReadonlyArray<[string, SegmentCounts, boolean, VerificationStatus]> = [
    ["the feed's own trip-level flag outranks the tallies", counts({}), true, 'cancelled'],
    ['every segment stop cancelled', counts({ segmentCancelledStops: 10 }), false, 'cancelled'],
    ['some segment stops cancelled', counts({ segmentCancelledStops: 4 }), false, 'partial'],
    [
      'segment untracked while the rest of the run was tracked',
      counts({ trackedOutsideSegment: 5 }),
      false,
      'cancelled',
    ],
    ['nothing tracked anywhere', counts({}), false, 'no-data'],
    ['segment only partly tracked', counts({ segmentTrackedStops: 6 }), false, 'partial'],
    ['segment fully tracked', counts({ segmentTrackedStops: 10 }), false, 'ran'],
  ];

  for (const [name, input, journeyCancelled, expected] of cases) {
    it(`resolves ${name} to ${expected}`, () => {
      assert.strictEqual(determineStatus(input, journeyCancelled), expected);
    });
  }
});

// A Zugnummer is reused all over Europe, and the announced departure time is matched with a
// ±2-minute tolerance, so an unrelated all-day service can satisfy it by coincidence — which is
// exactly how `S7 85586 2026-08-13 19:55 Achern -> Karlsruhe Hbf` was once verified against an
// SNCF Rennes -> Brest run.
describe('operator identity', () => {
  const segment = [stop('Achern', '19:55'), stop('Karlsruhe Hbf', '20:40')];
  const trip = tripOn({
    line: 'S7',
    trainNumber: '85586',
    fromStop: 'Achern',
    fromTime: '19:55',
    toStop: 'Karlsruhe Hbf',
    toTime: '20:40',
  });

  const withOperator = (
    train?: { operator?: string; admin?: string },
    administration?: { operatorCode?: string; operatorName?: string; administrationID?: string },
  ) => ({
    stops: administration
      ? segment.map((s) => ({ ...s, departure: { ...s.departure, transport: { administration } } }))
      : segment,
    ...(train ? { train } : {}),
  });

  const withEventOperator = (
    value: JourneyStop,
    event: 'arrival' | 'departure',
    operatorCode: string,
  ): JourneyStop => ({
    ...value,
    [event]: {
      ...value[event],
      transport: { administration: { operatorCode } },
    },
  });

  it('accepts the network operator named in full', () => {
    const details = withOperator({ operator: 'Albtal-Verkehrs-Gesellschaft mbH', admin: 'A6S11' });
    assert.strictEqual(matchesNetworkOperator(details), true);
    assert.ok(classifyJourney(trip, details, NOW));
  });

  it('accepts the S12-specific AVG administration ID', () => {
    assert.strictEqual(matchesNetworkOperator(withOperator({ admin: 'A6S12' })), true);
  });

  it('accepts the canonical operator code carried per leg', () => {
    const details = withOperator(undefined, { operatorCode: 'AVG', administrationID: 'A6' });
    assert.strictEqual(matchesNetworkOperator(details), true);
  });

  it('rejects a foreign operator that matched only by coincidence of time', () => {
    const details = withOperator({ operator: 'SNCF', admin: '87' }, { operatorCode: 'R' });
    assert.strictEqual(matchesNetworkOperator(details), false);
    // Rejected before any counting, so the caller falls through to the next candidate.
    assert.strictEqual(classifyJourney(trip, details, NOW), null);
  });

  it('rejects details carrying a different journey number', () => {
    const details = withOperator({ operator: 'Albtal-Verkehrs-Gesellschaft mbH', admin: 'A6' });
    assert.strictEqual(
      classifyJourney(trip, { ...details, train: { ...details.train, journeyNumber: 12345 } }, NOW),
      null,
    );
  });

  it('rejects an unrelated administration whose ID merely starts like the network one', () => {
    assert.strictEqual(matchesNetworkOperator(withOperator({ admin: 'A60' })), false);
  });

  it('accepts a journey that names no operator at all', () => {
    // Silence is not evidence of a foreign train, and rejecting it would discard real answers.
    assert.strictEqual(matchesNetworkOperator({ stops: segment }), true);
  });

  it('does not record the operator when it is the expected network one', () => {
    // Present-means-unusual: storing `Albtal…` on the overwhelming majority of records would make
    // the audit a filter instead of a grep, and cost bytes on every departed trip to say "normal".
    const details = withOperator({ operator: 'Albtal-Verkehrs-Gesellschaft mbH', admin: 'A6' });
    const verdict = classifyJourney(trip, details, NOW);
    assert.ok(verdict);
    assert.ok(!('feedOperator' in verdict), 'the key is absent on the normal case');
  });

  it('records an unexpected operator on a journey another token vouched for', () => {
    // Whole-journey metadata conflicts, but the administration on the announced segment is more
    // specific and vouches for it. This is exactly what the anomaly field is for.
    const details = withOperator({ operator: 'SNCF' }, { operatorCode: 'AVG' });
    assert.strictEqual(matchesNetworkOperator(details), false);
    assert.strictEqual(classifyJourney(trip, details, NOW)?.feedOperator, 'SNCF');
  });

  it('checks the operator on the announced segment, not an AVG leg elsewhere in the journey', () => {
    const before = withEventOperator(stop('Baden-Baden', '19:30'), 'departure', 'AVG');
    const from = withEventOperator(stop('Achern', '19:55'), 'departure', 'DB');
    const to = withEventOperator(stop('Karlsruhe Hbf', '20:40'), 'arrival', 'DB');
    const after = withEventOperator(stop('Durlach', '20:50'), 'arrival', 'AVG');
    const details = { stops: [before, from, to, after], train: { operator: 'AVG' } };

    assert.strictEqual(classifyJourney(trip, details, NOW), null);
  });

  it('accepts an AVG segment on a through journey operated by someone else outside it', () => {
    const before = withEventOperator(stop('Baden-Baden', '19:30'), 'departure', 'DB');
    const from = withEventOperator(stop('Achern', '19:55'), 'departure', 'AVG');
    const to = withEventOperator(stop('Karlsruhe Hbf', '20:40'), 'arrival', 'AVG');
    const after = withEventOperator(stop('Durlach', '20:50'), 'arrival', 'DB');
    const details = { stops: [before, from, to, after], train: { operator: 'DB Regio AG' } };

    assert.ok(classifyJourney(trip, details, NOW));
  });
});

describe('journey classification', () => {
  it('preserves whole-journey evidence when a strongly identified segment cannot be located', () => {
    // Live S1 56008 has a malformed KVV interval, but the exact S1 journey is explicitly cancelled
    // and every stop is flagged. Keep that evidence without claiming the unknown segment's bounds.
    const stops = [
      stop('Karlsruhe-Neureut Kirchfeld', '02:35', { cancelled: true }),
      stop('Albgaubad, Ettlingen', '03:25', { cancelled: true }),
    ];
    const trip = tripOn({
      line: 'S1',
      trainNumber: '56008',
      fromStop: 'Neureut Kirchfeld',
      fromTime: '03:33',
      toStop: 'Ettlingen Albgaubad',
      toTime: '03:25',
    });
    const verdict = createJourneyMismatchVerification(
      trip,
      {
        stops,
        cancelled: true,
        train: {
          line: 'S1',
          journeyNumber: 56008,
          operator: 'Albtal-Verkehrs-Gesellschaft mbH',
        },
      },
      NOW,
    );
    assert.strictEqual(verdict?.status, 'cancelled');
    assert.strictEqual(verdict?.segmentStops, 0);
    assert.strictEqual(verdict?.journeyStops, 2);
    assert.strictEqual(verdict?.journeyCancelledStops, 2);
    assert.strictEqual(verdict?.journeyCancelled, true);
    assert.strictEqual(verdict?.unresolvedReason, undefined);
  });

  it('does not attach journey-wide evidence from a different feed line', () => {
    const trip = tripOn({ line: 'S4', trainNumber: '84805' });
    const details = {
      stops: [stop('Wörth Badepark', '07:35'), stop('Söllingen', '08:37')],
      train: {
        line: 'S5',
        journeyNumber: 84805,
        operator: 'Albtal-Verkehrs-Gesellschaft mbH',
      },
    };
    assert.strictEqual(createJourneyMismatchVerification(trip, details, NOW), null);
  });

  it('confirms a cancellation when every stop of the segment is cancelled', () => {
    const stops = [
      stop('Wörth (Rhein) Badepark', '07:35', { cancelled: true }),
      stop('Maxau', '07:50', { cancelled: true }),
      stop('Söllingen (b Karlsr)', '08:37', { cancelled: true }),
    ];
    const trip = tripOn({
      line: 'S5',
      trainNumber: '84805',
      fromStop: 'Wörth Badepark',
      fromTime: '07:35',
      toStop: 'Söllingen Bahnhof',
      toTime: '08:37',
    });
    const verdict = classifyJourney(trip, { stops }, NOW);
    assert.strictEqual(verdict?.status, 'cancelled');
    assert.strictEqual(verdict?.segmentCancelledStops, 3);
  });

  it("retains the source's explicit whole-journey cancellation evidence", () => {
    const stops = [stop('Ittersbach Rathaus', '09:21'), stop('Ettlingen Stadt', '09:48')];
    const verdict = classifyJourney(tripOn(), { stops, cancelled: true }, NOW);
    assert.strictEqual(verdict?.status, 'cancelled');
    assert.strictEqual(verdict?.journeyCancelled, true);
  });

  it('reports a trip that ran when the whole segment is tracked', () => {
    const stops = [
      stop('Ittersbach Rathaus', '09:21', { delay: 0 }),
      stop('Ettlingen Stadt', '09:48', { delay: 2 }),
    ];
    assert.strictEqual(classifyJourney(tripOn(), { stops }, NOW)?.status, 'ran');
  });

  it('treats an untracked segment inside a tracked run as cancelled', () => {
    // The announced leg was never observed while the rest of the run was, which is what makes the
    // silence meaningful rather than merely missing data.
    const stops = [
      stop('Ittersbach Rathaus', '09:21'),
      stop('Busenbach', '09:40'),
      stop('Ettlingen Stadt', '09:48'),
      stop('Karlsruhe Albtalbahnhof', '10:03', { delay: 0 }),
      stop('Karlsruhe-Neureut Kirchfeld', '10:31', { delay: 1 }),
    ];
    const verdict = classifyJourney(tripOn(), { stops }, NOW);
    assert.strictEqual(verdict?.status, 'cancelled');
    assert.strictEqual(verdict?.segmentTrackedStops, 0);
  });

  it('does not infer cancellation when the feed has no data at all', () => {
    const stops = [stop('Ittersbach Rathaus', '09:21'), stop('Ettlingen Stadt', '09:48')];
    assert.strictEqual(classifyJourney(tripOn(), { stops }, NOW)?.status, 'no-data');
  });

  it('records which feed answered, on every verdict', () => {
    // Provenance is the one fact about a verdict that cannot be recovered later, so it is stamped
    // on the unresolved case too — where there is no journey to re-derive anything from.
    const stops = [
      stop('Ittersbach Rathaus', '09:21', { delay: 0 }),
      stop('Ettlingen Stadt', '09:48', { delay: 2 }),
    ];
    assert.strictEqual(classifyJourney(tripOn(), { stops }, NOW)?.source, 'bahn.expert');
    assert.strictEqual(createUnresolvedVerification(NOW).source, 'bahn.expert');
    assert.strictEqual(
      createUnresolvedVerification(NOW, 'journey-mismatch').unresolvedReason,
      'journey-mismatch',
    );
  });

  it('reports a partial cancellation when only some stops are cancelled', () => {
    const stops = [
      stop('Ittersbach Rathaus', '09:21', { cancelled: true }),
      stop('Busenbach', '09:40', { cancelled: true }),
      stop('Ettlingen Stadt', '09:48', { delay: 0 }),
    ];
    const verdict = classifyJourney(tripOn(), { stops }, NOW);
    assert.strictEqual(verdict?.status, 'partial');
    assert.strictEqual(verdict?.segmentCancelledStops, 2);
  });

  it('counts cancelled stops across the whole journey, not just the announced segment', () => {
    // KVV announced Ittersbach Rathaus -> Ettlingen Stadt, but the run lost stops beyond it too.
    // Segment counts drive the verdict; journey counts show how large the disruption really was.
    const stops = [
      stop('Ittersbach Rathaus', '09:21', { cancelled: true }),
      stop('Busenbach', '09:40', { cancelled: true }),
      stop('Ettlingen Stadt', '09:48', { cancelled: true }),
      stop('Karlsruhe Albtalbahnhof', '10:03', { cancelled: true }),
      stop('Karlsruhe-Neureut Kirchfeld', '10:31', { delay: 0 }),
    ];
    const verdict = classifyJourney(tripOn(), { stops }, NOW);
    assert.strictEqual(verdict?.status, 'cancelled');
    assert.strictEqual(verdict?.segmentStops, 3);
    assert.strictEqual(verdict?.segmentCancelledStops, 3);
    assert.strictEqual(verdict?.journeyStops, 5);
    assert.strictEqual(verdict?.journeyCancelledStops, 4);
  });

  it('tolerates a small gap between the published and timetabled departure', () => {
    // KVV published 84793 as 05:43 for an 05:45 departure. The journey is already pinned by train
    // number, so the tolerance only locates the segment inside it.
    const stops = [
      stop('Wörth (Rhein) Badepark', '05:45', { cancelled: true }),
      stop('Karlsruhe Tullastraße', '06:26', { cancelled: true }),
    ];
    const trip = tripOn({
      line: 'S5',
      trainNumber: '84793',
      fromStop: 'Wörth Badepark',
      fromTime: '05:43',
      toStop: 'Karlsruhe Tullastraße',
      toTime: '06:26',
    });
    assert.strictEqual(classifyJourney(trip, { stops }, NOW)?.status, 'cancelled');
  });

  it('records the feed line only when it disagrees with the stored line', () => {
    // 84885 is stored as S51 but the feed calls the same 07:26 Germersheim run S52.
    const stops = [
      stop('Germersheim', '07:26', { cancelled: true }),
      stop('Karlsruhe Marktplatz (Pyramide U)', '08:26', { cancelled: true }),
    ];
    const trip = tripOn({
      line: 'S51',
      trainNumber: '84885',
      fromStop: 'Germersheim Bahnhof',
      fromTime: '07:26',
      toStop: 'Karlsruhe Marktplatz',
      toTime: '08:26',
    });
    assert.strictEqual(
      classifyJourney(trip, { stops, train: { line: 'S52' } }, NOW)?.feedLine,
      'S52',
    );
    assert.strictEqual(
      classifyJourney(trip, { stops, train: { line: 'S51' } }, NOW)?.feedLine,
      undefined,
    );
  });

  it('returns null when the journey does not contain the announced departure', () => {
    assert.strictEqual(
      classifyJourney(tripOn(), { stops: [stop('Elsewhere', '18:00')] }, NOW),
      null,
    );
  });

  it('does not read a timetabled delay as realtime', () => {
    // The feed stamps `delay: 0` on stops it never observed. Counting those as tracked reported an
    // entirely untracked run as having run.
    const stops = [stop('Ittersbach Rathaus', '09:21'), stop('Ettlingen Stadt', '09:48')];
    const verdict = classifyJourney(tripOn(), { stops }, NOW);
    assert.strictEqual(verdict?.segmentTrackedStops, 0);
    assert.strictEqual(verdict?.status, 'no-data');
  });

  it('does not leak realtime from adjacent legs across segment boundaries', () => {
    const precedingArrival: JourneyStop = {
      stopPlace: { name: 'Ittersbach Rathaus' },
      arrival: {
        scheduledTime: '2026-08-13T07:20:00.000Z',
        time: '2026-08-13T07:21:00.000Z',
        isRealTime: true,
      },
      departure: { scheduledTime: '2026-08-13T07:21:00.000Z' },
    };
    const followingDeparture: JourneyStop = {
      stopPlace: { name: 'Ettlingen Stadt' },
      arrival: { scheduledTime: '2026-08-13T07:48:00.000Z' },
      departure: {
        scheduledTime: '2026-08-13T07:49:00.000Z',
        time: '2026-08-13T07:50:00.000Z',
        isRealTime: true,
      },
    };
    const verdict = classifyJourney(
      tripOn(),
      { stops: [precedingArrival, followingDeparture] },
      NOW,
    );
    assert.strictEqual(verdict?.segmentTrackedStops, 0);
    assert.strictEqual(verdict?.journeyTrackedStops, 2);
    assert.strictEqual(verdict?.trackedOutsideSegment, 2);
    assert.strictEqual(verdict?.status, 'cancelled');
  });

  it('does not leak cancellation flags from adjacent legs across segment boundaries', () => {
    const origin: JourneyStop = {
      stopPlace: { name: 'Ittersbach Rathaus' },
      arrival: { scheduledTime: '2026-08-13T07:20:00.000Z', cancelled: true },
      departure: {
        scheduledTime: '2026-08-13T07:21:00.000Z',
        time: '2026-08-13T07:22:00.000Z',
        isRealTime: true,
      },
    };
    const destination: JourneyStop = {
      stopPlace: { name: 'Ettlingen Stadt' },
      arrival: {
        scheduledTime: '2026-08-13T07:48:00.000Z',
        time: '2026-08-13T07:49:00.000Z',
        isRealTime: true,
      },
      departure: { scheduledTime: '2026-08-13T07:49:00.000Z', cancelled: true },
    };
    const verdict = classifyJourney(tripOn(), { stops: [origin, destination] }, NOW);
    assert.strictEqual(verdict?.segmentCancelledStops, 0);
    assert.strictEqual(verdict?.journeyCancelledStops, 2);
    assert.strictEqual(verdict?.status, 'ran');
  });

  it('does not treat equivalent timestamp encodings as realtime', () => {
    const stops: JourneyStop[] = [
      {
        stopPlace: { name: 'Ittersbach Rathaus' },
        departure: {
          scheduledTime: '2026-08-13T07:21:00.000Z',
          time: '2026-08-13T09:21:00.000+02:00',
        },
      },
      {
        stopPlace: { name: 'Ettlingen Stadt' },
        arrival: {
          scheduledTime: '2026-08-13T07:48:00.000Z',
          time: '2026-08-13T09:48:00.000+02:00',
        },
      },
    ];
    const verdict = classifyJourney(tripOn(), { stops }, NOW);
    assert.strictEqual(verdict?.segmentTrackedStops, 0);
    assert.strictEqual(verdict?.status, 'no-data');
  });

  it('counts a stop the feed cancelled only at event level', () => {
    // Partial cancellations are flagged per arrival/departure at their boundary, with no
    // stop-level flag — the uncounted stop downgraded a full cancellation to `partial`.
    const boundary: JourneyStop = {
      stopPlace: { name: 'Ettlingen Stadt' },
      arrival: { scheduledTime: '2026-08-13T07:48:00.000Z', cancelled: true },
    };
    const stops = [stop('Ittersbach Rathaus', '09:21', { cancelled: true }), boundary];
    const verdict = classifyJourney(tripOn(), { stops }, NOW);
    assert.strictEqual(verdict?.segmentCancelledStops, 2);
    assert.strictEqual(verdict?.status, 'cancelled');
  });
});

/**
 * The same verdicts, against decoded responses the live feed actually returned. The hand-built
 * journeys above assert the rules; these assert that the rules meet the wire format — which is
 * where both original defects lived.
 */
describe('journey classification against captured feed responses', () => {
  it('does not count timetabled stops of a real journey as observed', () => {
    // Every one of 85636's 62 stops carries a `delay`, but only a dozen carry realtime — the rest
    // are timetable rows with `delay: 0`. Delay-as-tracking reported all 16 segment stops observed.
    const trip = tripOn({
      line: 'S8',
      trainNumber: '85636',
      date: '2026-08-13',
      fromStop: 'Freudenstadt Hbf',
      fromTime: '10:53',
      toStop: 'Forbach',
      toTime: '11:39',
    });
    const details = loadJourneyFixture('20260813-19b67970-4b65-3820-ab7b-dea40958d407');
    const verdict = classifyJourney(trip, details, NOW);
    assert.strictEqual(verdict?.segmentStops, 16);
    // The only observations at the boundaries are the arrival into Freudenstadt before the
    // announced segment and the departure from Forbach after it. Neither belongs to this leg.
    assert.strictEqual(verdict?.segmentTrackedStops, 0);
  });

  it('still recognises observation reported without the realtime flag', () => {
    // 20019 carries `isRealTime: null` throughout, yet its later stops report second-precision
    // times that drift from the schedule. That is an observed vehicle, and dropping the fallback
    // would report a tracked run as `no-data`.
    const trip = tripOn({
      line: 'S11',
      trainNumber: '20019',
      fromStop: 'Ittersbach Rathaus',
      fromTime: '09:21',
      toStop: 'Ettlingen Stadt',
      toTime: '09:45',
    });
    const details = loadJourneyFixture('20260813-682647f9-023f-336c-b852-2edfa1f95e75');
    const verdict = classifyJourney(trip, details, NOW);
    assert.strictEqual(verdict?.segmentTrackedStops, 2);
    assert.strictEqual(verdict?.status, 'partial');
  });

  it('confirms a cancellation whose boundary stop is flagged per event', () => {
    // 41 stop-level cancellations plus one event-level: the segment is cancelled end to end.
    const trip = tripOn({
      line: 'S4',
      trainNumber: '85414',
      date: '2026-08-13',
      fromStop: 'Heilbronn-Willy-Brandt Platz',
      fromTime: '08:03',
      toStop: 'Karlsruhe Albtalbahnhof',
      toTime: '09:42',
    });
    const details = loadJourneyFixture('20260813-aec8f33d-b9cf-3759-afa4-a4afcbe7c305');
    const verdict = classifyJourney(trip, details, NOW);
    assert.strictEqual(verdict?.status, 'cancelled');
    assert.strictEqual(verdict?.segmentCancelledStops, verdict?.segmentStops);
    // The feed calls this S41 where KVV publishes S4 — recorded, never used to rewrite the line.
    assert.strictEqual(verdict?.feedLine, 'S41');
  });

  it('keeps a genuinely partial cancellation partial', () => {
    // 85636 lost the start of its announced segment and served the rest: counting event-level
    // cancellations must not promote that to a full cancellation.
    const trip = tripOn({
      line: 'S8',
      trainNumber: '85636',
      date: '2026-08-13',
      fromStop: 'Freudenstadt Hbf',
      fromTime: '10:53',
      toStop: 'Forbach',
      toTime: '11:39',
    });
    const details = loadJourneyFixture('20260813-19b67970-4b65-3820-ab7b-dea40958d407');
    const verdict = classifyJourney(trip, details, NOW);
    assert.strictEqual(verdict?.status, 'partial');
    assert.strictEqual(verdict?.segmentCancelledStops, 2);
    assert.strictEqual(verdict?.segmentStops, 16);
  });
});
