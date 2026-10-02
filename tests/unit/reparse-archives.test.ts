import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listsUnresolvedTripRows, reconcileArchivedTrips } from '../../scripts/reparse-archives.js';
import type { Cancellation } from '../../src/types.js';
import type { TripVerification } from '../../src/verification/verify.js';

const ARTICLE_A = 'test://detail?detailID=A';
const ARTICLE_B = 'test://detail?detailID=B';
const ARTICLE_UNPARSED = 'test://detail?detailID=UNPARSED';

/** A fixed clock between the fixtures' past (2026-09-30) and future (2026-10-10) trips. */
const NOW_MS = Date.parse('2026-10-02T12:00:00Z');

const CANCELLED: TripVerification = {
  status: 'cancelled',
  methodVersion: 7,
  source: 'bahn.expert',
  checkedAt: '2026-09-30',
  segmentStops: 42,
  segmentCancelledStops: 42,
  segmentTrackedStops: 0,
  journeyStops: 74,
  journeyCancelledStops: 42,
  journeyTrackedStops: 32,
  trackedOutsideSegment: 32,
  trackedAdjacentStops: 1,
};

function trip(overrides: Partial<Cancellation> = {}): Cancellation {
  return {
    line: 'S4',
    date: '2026-10-10',
    stand: '2026-10-09T20:00:00.000Z',
    trainNumber: '85401',
    fromStop: 'Albtalbahnhof',
    fromTime: '03:55',
    toStop: 'Schwaigern',
    toTime: '05:25',
    sourceUrl: ARTICLE_A,
    capturedAt: '2026-10-09T20:05:00.000Z',
    cause: 'operational',
    causeKeyword: 'betriebsbedingt',
    ...overrides,
  };
}

function reconcile(
  storedTrips: readonly Cancellation[],
  reparsed: Record<string, readonly Cancellation[]>,
) {
  return reconcileArchivedTrips(
    new Map([['S4', storedTrips]]),
    new Map(Object.entries(reparsed)),
    NOW_MS,
  );
}

describe('archive trip reconciliation', () => {
  it('changes nothing when the archive reparses to what is stored', () => {
    const stored = trip();
    const result = reconcile([stored], { [ARTICLE_A]: [trip({ capturedAt: 'reparse time' })] });
    assert.equal(result.changesByLine.size, 0);
    assert.deepEqual(result.tripsByLine.get('S4'), [stored]);
  });

  it('does not re-add a trip already stored under a sibling notice', () => {
    const stored = trip({ sourceUrl: ARTICLE_A });
    const result = reconcile([stored], {
      [ARTICLE_A]: [trip({ sourceUrl: ARTICLE_A })],
      [ARTICLE_B]: [trip({ sourceUrl: ARTICLE_B })],
    });
    assert.equal(result.changesByLine.size, 0);
  });

  it('moves a future trip to the sibling notice that still lists it', () => {
    const stored = trip({ sourceUrl: ARTICLE_A });
    const relisted = trip({ sourceUrl: ARTICLE_B });
    const changes = reconcile([stored], { [ARTICLE_A]: [], [ARTICLE_B]: [relisted] }).changesByLine;
    assert.deepEqual(changes.get('S4'), { restored: [relisted], corrected: [], removed: [stored] });
  });

  it('retains a departed trip its article no longer lists, and reports it as retained', () => {
    const departed = trip({ date: '2026-09-30' });
    const result = reconcile([departed], { [ARTICLE_A]: [] });
    assert.equal(result.changesByLine.size, 0);
    assert.deepEqual(result.retainedPastTrips, [departed]);
  });

  it('never touches trips of an article that failed to reparse', () => {
    const stored = trip({ sourceUrl: ARTICLE_UNPARSED });
    const result = reconcile([stored], { [ARTICLE_A]: [] });
    assert.equal(result.changesByLine.size, 0);
    assert.deepEqual(result.tripsByLine.get('S4'), [stored]);
  });

  it('keeps provenance and the verdict across a re-spelled stop', () => {
    const stored = trip({ verification: CANCELLED, restoredFrom: 'manual' });
    const reparsed = trip({
      fromStop: 'KA-Albtalbahnhof',
      toStop: 'Schwaigern Bf',
      capturedAt: 'reparse time',
    });
    const [correction] = reconcile([stored], { [ARTICLE_A]: [reparsed] }).changesByLine.get(
      'S4',
    )!.corrected;
    assert.deepEqual(correction?.reconciled, {
      ...reparsed,
      capturedAt: stored.capturedAt,
      restoredFrom: 'manual',
      verification: CANCELLED,
    });
  });

  it('drops the verdict when the reparse moves the announced segment', () => {
    const stored = trip({ verification: CANCELLED });
    const reparsed = trip({ toStop: 'Heilbronn Hbf' });
    const [correction] = reconcile([stored], { [ARTICLE_A]: [reparsed] }).changesByLine.get(
      'S4',
    )!.corrected;
    assert.equal(correction?.reconciled.verification, undefined);
  });
});

describe('trip-less archive detection', () => {
  const article = (rows: string) =>
    `<main><p>Linien S1 und S11: Fahrtausfälle</p><p>Folgende Fahrten fallen aus:</p>${rows}</main>`;

  it('flags valid rows whose train numbers map to none of the article lines', () => {
    const body = article(
      '<p>99991 Ittersbach Rathaus (09:21 Uhr) - Ettlingen Stadt (09:45 Uhr)</p>',
    );
    assert.ok(listsUnresolvedTripRows(body, 'test://unmapped'));
  });

  it('flags a line-prefixed numbered row no format matched', () => {
    const body = article(
      '<p>S1 10074 Ittersbach Rathaus /09:21 Uhr) - Ettlingen Stadt (09:45 Uhr)</p>',
    );
    assert.ok(listsUnresolvedTripRows(body, 'test://prefixed'));
  });

  it('accepts a notice without trip rows', () => {
    const body = article('<p>Nähere Infos gibt es im Abfahrtsmonitor.</p>');
    assert.ok(!listsUnresolvedTripRows(body, 'test://no-rows'));
  });
});
