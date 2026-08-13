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
import type { JourneyStop } from '../../src/verification/bahn-expert.js';
import {
  MAX_ATTEMPTS,
  isVerifiable,
  needsCheck,
  withAttemptCount,
} from '../../src/verification/selection.js';
import {
  classifyJourney,
  determineStatus,
  locateSegment,
  type SegmentCounts,
  type TripVerification,
  type VerificationStatus,
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
  return {
    stopPlace: { name },
    departure: {
      scheduledTime,
      time: scheduledTime,
      delay: observed ? options.delay : 0,
      isRealTime: observed ? true : null,
      cancelled: options.cancelled ?? null,
    },
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
});

describe('trip selection', () => {
  // 2026-08-13 12:00 Berlin, i.e. after the 09:21 departure the default trip uses.
  const NOW_MS = Date.parse('2026-08-13T10:00:00.000Z');
  const verified = (overrides: Partial<TripVerification>): TripVerification => ({
    status: 'cancelled',
    checkedAt: '2026-08-13T10:00:00.000Z',
    segmentStops: 3,
    segmentCancelledStops: 3,
    segmentTrackedStops: 0,
    journeyStops: 3,
    journeyCancelledStops: 3,
    source: 'bahn.expert',
    ...overrides,
  });

  it('skips a trip that has not departed yet', () => {
    assert.strictEqual(isVerifiable(tripOn({ fromTime: '23:50' }), NOW_MS), false);
  });

  it('skips a trip that departed within the settling grace period', () => {
    assert.strictEqual(isVerifiable(tripOn({ fromTime: '11:45' }), NOW_MS), false);
  });

  it('accepts a departed trip inside the lookback window', () => {
    assert.strictEqual(isVerifiable(tripOn(), NOW_MS), true);
  });

  it('skips a trip older than the feed window', () => {
    assert.strictEqual(isVerifiable(tripOn({ date: '2026-08-01' }), NOW_MS), false);
  });

  it('checks a trip that has never been verified', () => {
    assert.strictEqual(needsCheck(tripOn(), false), true);
  });

  it('leaves a settled verdict alone', () => {
    const trip = tripOn({ verification: verified({ attempts: 1 }) });
    assert.strictEqual(needsCheck(trip, false), false);
  });

  it('retries a provisional verdict until the attempt limit', () => {
    const atLimit = MAX_ATTEMPTS;
    const retryable = tripOn({ verification: verified({ status: 'unresolved', attempts: 1 }) });
    const exhausted = tripOn({
      verification: verified({ status: 'unresolved', attempts: atLimit }),
    });
    assert.strictEqual(needsCheck(retryable, false), true);
    assert.strictEqual(needsCheck(exhausted, false), false);
    // `--recheck` ignores the budget entirely.
    assert.strictEqual(needsCheck(exhausted, true), true);
  });

  it('counts attempts cumulatively across runs', () => {
    const first = withAttemptCount(verified({ status: 'unresolved' }), undefined);
    assert.strictEqual(first.attempts, 1);
    assert.strictEqual(withAttemptCount(verified({}), first).attempts, 2);
  });
});

describe('verdict rules', () => {
  const counts = (overrides: Partial<SegmentCounts> = {}): SegmentCounts => ({
    segmentStops: 10,
    segmentCancelledStops: 0,
    segmentTrackedStops: 0,
    journeyStops: 10,
    journeyCancelledStops: 0,
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

describe('journey classification', () => {
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
    assert.strictEqual(verdict?.segmentTrackedStops, 2);
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
