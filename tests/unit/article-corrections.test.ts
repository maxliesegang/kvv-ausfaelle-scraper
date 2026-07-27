/**
 * Tests for article-scoped source-text corrections.
 *
 * The point of the mechanism is that a correction is invisible everywhere except the one
 * article it names, and that the repaired row parses into the trip KVV meant to publish —
 * with the value an external source confirms, not the one a truncating parse would produce.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyArticleCorrections } from '../../src/parser/article-corrections.js';
import { parseDetailPage } from '../../src/parser/index.js';
import { loadArchivedArticle } from '../helpers/fixture-loader.js';

const CORRECTED_ARTICLE_ID = 'Nettro_CMS_273228';
const detailUrl = (detailId: string) =>
  'https://www.kvv.de/fahrplan/verkehrsmeldungen.html?tx_ixkvvticker_list%5Baction%5D=detail' +
  `&tx_ixkvvticker_list%5Bcontroller%5D=Ticker&tx_ixkvvticker_list%5BdetailID%5D=${detailId}`;

describe('article text corrections', () => {
  test('repairs the malformed clock time in the article it is scoped to', () => {
    const row = 'S5 84809 Wörth Badepark 08:05 Uhr - Söllingen Bahnhof 09:009 Uhr';

    assert.equal(
      applyArticleCorrections(row, detailUrl(CORRECTED_ARTICLE_ID)),
      'S5 84809 Wörth Badepark 08:05 Uhr - Söllingen Bahnhof 09:09 Uhr',
    );
  });

  test('leaves the same wording untouched in every other article', () => {
    const row = 'S5 84809 Wörth Badepark 08:05 Uhr - Söllingen Bahnhof 09:009 Uhr';

    // Scoping is the safeguard that keeps this from being a global find/replace over KVV text.
    assert.equal(applyArticleCorrections(row, detailUrl('Nettro_CMS_999999')), row);
    assert.equal(applyArticleCorrections(row, 'https://www.kvv.de/no-detail-id'), row);
  });

  test('recovers the dropped trip from the archived article, at the GTFS-confirmed arrival', () => {
    const article = loadArchivedArticle('2026', CORRECTED_ARTICLE_ID);
    const trips = parseDetailPage(article.body, article.url);

    const recovered = trips.find((trip) => trip.trainNumber === '84809');
    assert.ok(recovered, 'the repaired row must parse into a trip');
    assert.deepEqual(
      {
        line: recovered.line,
        date: recovered.date,
        fromStop: recovered.fromStop,
        fromTime: recovered.fromTime,
        toStop: recovered.toStop,
        toTime: recovered.toTime,
      },
      {
        line: 'S5',
        date: '2026-07-24',
        fromStop: 'Wörth Badepark',
        fromTime: '08:05',
        toStop: 'Söllingen Bahnhof',
        // 09:09 per GTFS, not the 09:00 a truncating parse of "09:009" would yield.
        toTime: '09:09',
      },
    );
    assert.equal(trips.length, 4, 'the notice lists four cancelled trips');
  });

  test('keeps the text archive faithful to what KVV published', () => {
    // The correction must never leak into the archive: its value is being an unedited record.
    const article = loadArchivedArticle('2026', CORRECTED_ARTICLE_ID);
    assert.match(article.body, /Söllingen Bahnhof 09:009 Uhr/);
  });
});
