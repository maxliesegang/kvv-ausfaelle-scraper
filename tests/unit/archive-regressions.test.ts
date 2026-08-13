import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ParseError, parseDetailPage } from '../../src/parser/index.js';
import type { Cancellation } from '../../src/types.js';
import { loadArchivedArticle } from '../helpers/fixture-loader.js';
import { normalizeCancellation } from '../helpers/test-utils.js';

function parseArchivedArticle(id: string): Cancellation[] {
  const article = loadArchivedArticle('2026', id);
  return parseDetailPage(article.body, article.url);
}

function findTrip(trips: Cancellation[], trainNumber: string): Cancellation {
  const trip = trips.find((candidate) => candidate.trainNumber === trainNumber);
  assert.ok(trip, `expected archived article to contain train ${trainNumber}`);
  return trip;
}

type RouteSummary = Pick<
  Cancellation,
  'trainNumber' | 'line' | 'fromStop' | 'fromTime' | 'toStop' | 'toTime'
>;

/** Projects a trip down to its train, resolved line, and endpoints for line-resolution assertions. */
function routeOf({
  trainNumber,
  line,
  fromStop,
  fromTime,
  toStop,
  toTime,
}: Cancellation): RouteSummary {
  return { trainNumber, line, fromStop, fromTime, toStop, toTime };
}

describe('archived article parser regressions', () => {
  test('keeps the cancellation endpoints when trailing prose contains later times', () => {
    const trips = parseArchivedArticle('Nettro_CMS_272351');

    assert.equal(trips.length, 1, 'trailing deployment details must not create another trip');
    assert.deepEqual(normalizeCancellation(trips[0]!), {
      line: 'S51',
      date: '2026-07-13',
      stand: '2026-07-13T04:13:00.000Z',
      trainNumber: '84892',
      fromStop: 'Karlsruhe Tullastraße',
      fromTime: '10:01',
      toStop: 'Karlsruhe Rheinbergstraße',
      toTime: '10:26',
      cause: 'personnel',
      causeKeyword: 'fahrpersonal',
    });
  });

  test('resolves every train in an S1/S11 article and keeps bare betriebsbedingt operational', () => {
    const trips = parseArchivedArticle('Nettro_CMS_272784');

    assert.deepEqual(
      trips.map(({ trainNumber, line }) => [trainNumber, line]),
      [
        ['30020', 'S1'],
        ['10039', 'S1'],
        ['10044', 'S1'],
        ['30037', 'S1'],
        ['20039', 'S11'],
        ['30044', 'S1'],
        ['30051', 'S1'],
        ['30054', 'S1'],
      ],
    );
    assert.ok(
      trips.every(
        ({ date, stand, cause, causeKeyword }) =>
          date === '2026-07-17' &&
          stand === '2026-07-17T04:39:00.000Z' &&
          cause === 'operational' &&
          causeKeyword === 'betriebsbedingt',
      ),
      'all trips should share the article metadata and classification',
    );
  });

  test('parses a dense S5/S51 article without omissions or false-positive trips', () => {
    const trips = parseArchivedArticle('Nettro_CMS_271521');

    assert.equal(trips.length, 33);
    assert.deepEqual(
      Object.fromEntries(
        [...new Set(trips.map(({ line }) => line))].map((line) => [
          line,
          trips.filter((trip) => trip.line === line).length,
        ]),
      ),
      { S5: 32, S51: 1 },
    );

    assert.deepEqual(
      normalizeCancellation(findTrip(trips, '85015')),
      {
        line: 'S5',
        date: '2026-07-04',
        stand: '2026-07-04T10:30:00.000Z',
        trainNumber: '85015',
        fromStop: 'Starkstr.',
        fromTime: '17:47',
        toStop: 'Pforzheim Hbf',
        toTime: '18:50',
        cause: 'personnel',
        causeKeyword: 'fahrpersonal',
      },
      'capitalized "Ab" must remain a valid row separator',
    );
    assert.deepEqual(
      normalizeCancellation(findTrip(trips, '85096')),
      {
        line: 'S5',
        date: '2026-07-04',
        stand: '2026-07-04T10:30:00.000Z',
        trainNumber: '85096',
        fromStop: 'Söllingen Bf.',
        fromTime: '23:19',
        toStop: 'Tullastraße',
        toTime: '23:36',
        cause: 'personnel',
        causeKeyword: 'fahrpersonal',
      },
      'the trailing (LT) annotation must not alter the destination',
    );
    assert.deepEqual(
      normalizeCancellation(findTrip(trips, '84945')),
      {
        line: 'S51',
        date: '2026-07-05',
        stand: '2026-07-04T10:30:00.000Z',
        trainNumber: '84945',
        fromStop: 'Tullastraße',
        fromTime: '00:37',
        toStop: 'Söllingen Bf.',
        toTime: '00:56',
        cause: 'personnel',
        causeKeyword: 'fahrpersonal',
      },
      'the after-midnight row must run on the day after the Stand and retain its line mapping',
    );
  });

  test('propagates a real vehicle classification to every parsed trip', () => {
    const trips = parseArchivedArticle('Nettro_CMS_272039');

    assert.deepEqual(trips.map(normalizeCancellation), [
      {
        line: 'S8',
        date: '2026-07-09',
        stand: '2026-07-09T10:00:00.000Z',
        trainNumber: '85646',
        fromStop: 'Freudenstadt Hbf',
        fromTime: '13:23',
        toStop: 'Freudenstadt Stadt',
        toTime: '13:28',
        cause: 'vehicle',
        causeKeyword: 'fahrzeugstoerung',
      },
      {
        line: 'S8',
        date: '2026-07-09',
        stand: '2026-07-09T10:00:00.000Z',
        trainNumber: '85643',
        fromStop: 'Freudenstadt Stadt',
        fromTime: '14:32',
        toStop: 'Freudenstadt Hbf',
        toTime: '14:37',
        cause: 'vehicle',
        causeKeyword: 'fahrzeugstoerung',
      },
    ]);
  });

  test('resolves shared S8/S81 article trains to their individual lines', () => {
    const trips = parseArchivedArticle('Nettro_CMS_272824');

    assert.deepEqual(trips.map(routeOf), [
      {
        trainNumber: '85647',
        line: 'S8',
        fromStop: 'Karlsruhe Tullastraße',
        fromTime: '13:57',
        toStop: 'Freudenstadt Hbf',
        toTime: '16:07',
      },
      {
        trainNumber: '85660',
        line: 'S81',
        fromStop: 'Freudenstadt Hbf',
        fromTime: '17:21',
        toStop: 'Karlsruhe Hbf',
        toTime: '19:16',
      },
    ]);
  });

  test('applies source-scoped S6 overrides while parsing the archived source URL', () => {
    const trips = parseArchivedArticle('Nettro_CMS_272859');

    assert.equal(trips.length, 13);
    assert.deepEqual(
      trips
        .filter(({ trainNumber }) => trainNumber === '74351' || trainNumber === '74352')
        .map(routeOf),
      [
        {
          trainNumber: '74352',
          line: 'S6',
          fromStop: 'Bad Wildbad Kurpark',
          fromTime: '21:05',
          toStop: 'Pforzheim Bahnhof',
          toTime: '21:40',
        },
        {
          trainNumber: '74351',
          line: 'S6',
          fromStop: 'Pforzheim Bahnhof',
          fromTime: '22:17',
          toStop: 'Bad Wildbad Kurpark',
          toTime: '22:52',
        },
      ],
    );
  });

  test('resolves an S52-only Germersheim run in an S5/S51 article via an override', () => {
    const trips = parseArchivedArticle('Nettro_CMS_273506');

    // GTFS files 85481 only under S52, the sibling short-working on the S51 Germersheim
    // corridor, which this S5/S51 notice never mentions — without the override the article
    // fails to parse with a MultiLineMappingError.
    assert.deepEqual(routeOf(findTrip(trips, '85481')), {
      trainNumber: '85481',
      line: 'S51',
      fromStop: 'Germersheim',
      fromTime: '13:26',
      toStop: 'KA Marktplatz',
      toTime: '14:26',
    });
    assert.ok(
      trips.every(({ line }) => line === 'S5' || line === 'S51'),
      'every trip must resolve to one of the mentioned lines',
    );
  });

  test('resolves an S52-only run and a GTFS-unknown depot run in an S5/S51 article', () => {
    const trips = parseArchivedArticle('Nettro_CMS_274370');

    // 84885 is an S52 in GTFS (the sibling short-working on the S51 Germersheim corridor)
    // and 80702 is in no GTFS line list at all, so both need this article's overrides —
    // otherwise the notice fails to parse with a MultiLineMappingError.
    assert.deepEqual(routeOf(findTrip(trips, '84885')), {
      trainNumber: '84885',
      line: 'S51',
      fromStop: 'Germersheim Bahnhof',
      fromTime: '07:26',
      toStop: 'Karlsruhe Marktplatz',
      toTime: '08:26',
    });
    assert.deepEqual(routeOf(findTrip(trips, '80702')), {
      trainNumber: '80702',
      line: 'S51',
      fromStop: 'Karlsruhe Marktplatz',
      fromTime: '08:39',
      toStop: 'Karlsruhe Albtalbahnhof',
      toTime: '08:48',
    });
    assert.equal(trips.length, 14, 'every listed run must be parsed');
    assert.ok(
      trips.every(({ line }) => line === 'S5' || line === 'S51'),
      'every trip must resolve to one of the mentioned lines',
    );
  });

  test('parses trip rows whose train number carries a trailing colon', () => {
    const trips = parseArchivedArticle('Nettro_CMS_273364');

    // KVV keeps rewriting this notice in place — earlier revisions listed the morning runs
    // and later ones dropped them as they passed — so the list tracks the archive as stored.
    assert.deepEqual(trips.map(routeOf), [
      {
        trainNumber: '10047',
        line: 'S1',
        fromStop: 'Ettlingen Albgaubad',
        fromTime: '12:54',
        toStop: 'Hochstetten',
        toTime: '14:06',
      },
      {
        trainNumber: '20044',
        line: 'S11',
        fromStop: 'Hochstetten',
        fromTime: '14:12',
        toStop: 'Ettlingen Stadt',
        toTime: '15:18',
      },
      {
        // GTFS knows 40014 only as an S12 — the reinforcement line on the S11 Ittersbach
        // corridor — which the S1/S11 article never mentions, so an override maps it to S11.
        trainNumber: '40014',
        line: 'S11',
        fromStop: 'KA Tullastraße',
        fromTime: '15:36',
        toStop: 'Ittersbach Rathaus',
        toTime: '16:29',
      },
    ]);
    assert.ok(
      trips.every(
        ({ cause, causeKeyword }) => cause === 'personnel' && causeKeyword === 'fahrpersonal',
      ),
      'the "S1/S11:" group header must not disturb the article classification',
    );
  });

  test('maps the S12-numbered S11 corridor run in the 2026-08-03 notice', () => {
    const trips = parseArchivedArticle('Nettro_CMS_273841');

    assert.deepEqual(trips.map(routeOf), [
      {
        trainNumber: '40015',
        line: 'S11',
        fromStop: 'Ittersbach Rathaus',
        fromTime: '07:36',
        toStop: 'Tullastrasse',
        toTime: '08:32',
      },
    ]);
  });

  test('parses "bis" rows that omit the "an" arrival marker', () => {
    const trips = parseArchivedArticle('Nettro_CMS_273728');

    assert.deepEqual(trips.map(normalizeCancellation), [
      {
        line: 'S7',
        date: '2026-07-31',
        stand: '2026-07-31T06:21:00.000Z',
        trainNumber: '85567',
        fromStop: 'Ka Tullastrasse',
        fromTime: '09:17',
        toStop: 'Achern',
        toTime: '10:25',
        cause: 'personnel',
        causeKeyword: 'fahrpersonal',
      },
      {
        line: 'S7',
        date: '2026-07-31',
        stand: '2026-07-31T06:21:00.000Z',
        trainNumber: '85568',
        fromStop: 'Achern',
        fromTime: '10:33',
        toStop: 'Ka Tullastrasse',
        toTime: '11:40',
        cause: 'personnel',
        causeKeyword: 'fahrpersonal',
      },
    ]);
  });

  test('parses an article mixing bare "bis" rows with parenthesized-time rows', () => {
    const trips = parseArchivedArticle('Nettro_CMS_273683');

    assert.equal(trips.length, 10, 'neither row layout may be dropped');
    assert.deepEqual(trips.slice(0, 3).map(routeOf), [
      {
        trainNumber: '84728',
        line: 'S5',
        fromStop: 'Berghausen Bf',
        fromTime: '11:05',
        toStop: 'Ka. Rheinbergstraße',
        toTime: '11:44',
      },
      {
        trainNumber: '84743',
        line: 'S5',
        fromStop: 'Ka. Rheinbergstraße',
        fromTime: '12:11',
        toStop: 'Ka Tullastrasse',
        toTime: '12:36',
      },
      {
        trainNumber: '84828',
        line: 'S5',
        fromStop: 'Karlsruhe Lameyplatz',
        fromTime: '12:28',
        toStop: 'Wörth (Rhein) Badepark',
        toTime: '12:53',
      },
    ]);
  });

  test('does not invent trips from an unnumbered multi-stop replacement-service notice', (t) => {
    t.mock.method(console, 'warn', () => undefined);
    assert.throws(() => parseArchivedArticle('100004264_KVV_ICSKVV'), ParseError);
  });
});
