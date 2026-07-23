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
        date: '2026-07-04',
        stand: '2026-07-04T10:30:00.000Z',
        trainNumber: '84945',
        fromStop: 'Tullastraße',
        fromTime: '00:37',
        toStop: 'Söllingen Bf.',
        toTime: '00:56',
        cause: 'personnel',
        causeKeyword: 'fahrpersonal',
      },
      'the after-midnight row must retain its train-number line mapping',
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

  test('does not invent trips from an unnumbered multi-stop replacement-service notice', (t) => {
    t.mock.method(console, 'warn', () => undefined);
    assert.throws(() => parseArchivedArticle('100004264_KVV_ICSKVV'), ParseError);
  });
});
