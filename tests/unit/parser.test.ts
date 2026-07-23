/**
 * Parser unit tests using Node's built-in test runner.
 * Tests the HTML parsing logic for KVV cancellation articles.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseDetailPage } from '../../src/parser/index.js';
import { extractStand, parseGermanDateTime } from '../../src/parser/text-extraction.js';
import {
  extractTripLines,
  extractTripSectionCandidates,
  isValidTripLine,
  parseTripLine,
} from '../../src/parser/trip-parsing.js';
import type { TripParsingMetadata } from '../../src/types.js';
import { findMissedKnownTripsError } from '../../src/workflow.js';
import { loadAllFixtures, loadFixture } from '../helpers/fixture-loader.js';
import { assertCancellationsEqual, assertThrows } from '../helpers/test-utils.js';

/**
 * Parses a single trip line and returns just the extracted trip fields (line resolution is
 * exercised elsewhere). Uses single-line-mention metadata so the article line is used
 * directly without consulting the train-number mapping.
 */
function parseTripLineFields(
  line: string,
): { trainNumber: string; fromStop: string; fromTime: string; toStop: string; toTime: string }[] {
  const metadata: TripParsingMetadata = {
    line: 'S42',
    mentionedLines: ['S42'],
    lineMentionCount: 1,
    lineExplicitlyProvided: false,
    date: '2026-07-04',
    stand: '2026-07-04T12:30:00.000Z',
    sourceUrl: 'test://trip-line',
    capturedAt: '2026-07-04T12:30:00.000Z',
    cause: 'operational',
    causeKeyword: null,
  };
  return parseTripLine(line, metadata).map((t) => ({
    trainNumber: t.trainNumber,
    fromStop: t.fromStop,
    fromTime: t.fromTime,
    toStop: t.toStop,
    toTime: t.toTime,
  }));
}

describe('Parser - Detail Page Parsing', () => {
  describe('Real-world articles', () => {
    const fixtures = loadAllFixtures();

    for (const fixture of fixtures) {
      it(`should parse ${fixture.name}`, () => {
        const actual = parseDetailPage(fixture.html, `test://${fixture.name}`);
        assertCancellationsEqual(actual, fixture.expected, fixture.name);
      });
    }
  });

  describe('Error handling', () => {
    it('should throw when no trips can be extracted', () => {
      const html = `
        <html>
          <body>
            <p>Linie S1</p>
            <p>Nach aktuellem Stand 15.05.2024 12:00:00</p>
            <p>Betroffene Fahrten:</p>
            <p>keine konkreten Angaben</p>
          </body>
        </html>
      `;

      assertThrows(
        () => parseDetailPage(html, 'test://no-trips'),
        'Incorrect parse',
        'Should throw when no trips found',
      );
    });

    it('should throw on empty HTML', () => {
      assertThrows(
        () => parseDetailPage('', 'test://empty'),
        /Incorrect parse|No trips/i,
        'Should throw on empty HTML',
      );
    });

    it('should throw on malformed HTML', () => {
      const html = '<html><body><p>Invalid content</p></body></html>';

      assertThrows(
        () => parseDetailPage(html, 'test://malformed'),
        /Incorrect parse/i,
        'Should throw on malformed HTML',
      );
    });
  });

  describe('Format variations', () => {
    it('should handle old format articles', () => {
      const oldFormatFixtures = loadAllFixtures().filter((f) => f.name.includes('old-format'));

      for (const fixture of oldFormatFixtures) {
        const actual = parseDetailPage(fixture.html, `test://${fixture.name}`);
        assertCancellationsEqual(actual, fixture.expected, `Old format: ${fixture.name}`);
      }
    });

    it('should handle new format articles', () => {
      const newFormatFixtures = loadAllFixtures().filter((f) => f.name.includes('new-format'));

      for (const fixture of newFormatFixtures) {
        const actual = parseDetailPage(fixture.html, `test://${fixture.name}`);
        assertCancellationsEqual(actual, fixture.expected, `New format: ${fixture.name}`);
      }
    });

    it('should handle mixed format articles', () => {
      const mixedFormatFixtures = loadAllFixtures().filter((f) => f.name.includes('mixed-format'));

      for (const fixture of mixedFormatFixtures) {
        const actual = parseDetailPage(fixture.html, `test://${fixture.name}`);
        assertCancellationsEqual(actual, fixture.expected, `Mixed format: ${fixture.name}`);
      }
    });
  });

  describe('Special cases', () => {
    it('should handle articles with line prefix', () => {
      const linePrefixFixtures = loadAllFixtures().filter((f) => f.name.includes('line-prefix'));

      for (const fixture of linePrefixFixtures) {
        const actual = parseDetailPage(fixture.html, `test://${fixture.name}`);
        assertCancellationsEqual(actual, fixture.expected, `Line prefix: ${fixture.name}`);
      }
    });

    it('should handle articles with multiple lines', () => {
      const multiLineFixtures = loadAllFixtures().filter((f) => /s\d+-s\d+/.test(f.name));

      for (const fixture of multiLineFixtures) {
        const actual = parseDetailPage(fixture.html, `test://${fixture.name}`);
        assertCancellationsEqual(actual, fixture.expected, `Multi-line: ${fixture.name}`);
      }
    });
  });

  describe('Hardened format variants', () => {
    // Each of these appeared in a live article and previously matched no parser format.
    it('parses "ab/bis/an" rows with a trailing (LT) annotation', () => {
      const line = '85096 Söllingen Bf. ab 23:19 Uhr bis Tullastraße an 23:36 Uhr (LT)';
      assert.ok(isValidTripLine(line));
      const [trip] = parseTripLineFields(line);
      assert.deepStrictEqual(trip, {
        trainNumber: '85096',
        fromStop: 'Söllingen Bf.',
        fromTime: '23:19',
        toStop: 'Tullastraße',
        toTime: '23:36',
      });
    });

    it('parses stop/time rows with parentheses on only one side', () => {
      const line = '85879 Heilbronn Hbf/Willy-Brandt-Platz (23:50 Uhr) - Sinsheim Hbf  00:48 Uhr';
      assert.ok(isValidTripLine(line));
      const [trip] = parseTripLineFields(line);
      assert.deepStrictEqual(trip, {
        trainNumber: '85879',
        fromStop: 'Heilbronn Hbf/Willy-Brandt-Platz',
        fromTime: '23:50',
        toStop: 'Sinsheim Hbf',
        toTime: '00:48',
      });
    });

    it('parses the prose "entfällt zwischen X (t) und Y (t)" form with trailing prose', () => {
      const line =
        '84892 entfällt zwischen Karlsruhe Tullastraße (10:01 Uhr) und Karlsruhe ' +
        'Rheinbergstraße (10:26 Uhr). Dieser Zug wird verspätet ab Karlsruhe Albtalbahnhof ' +
        '(10:34 Uhr) über Karlsruhe West eingesetzt.';
      assert.ok(isValidTripLine(line));
      const [trip] = parseTripLineFields(line);
      assert.deepStrictEqual(trip, {
        trainNumber: '84892',
        fromStop: 'Karlsruhe Tullastraße',
        fromTime: '10:01',
        toStop: 'Karlsruhe Rheinbergstraße',
        toTime: '10:26',
      });
    });

    it('does not treat parenthesized date-ranges as trips (no leading train number)', () => {
      assert.equal(
        isValidTripLine('Donnerstag 30.07. (04:30 Uhr) bis Donnerstag 06.08.2026 (04:10 Uhr)'),
        false,
      );
      assert.equal(
        isValidTripLine('ab Donnerstag 06.08. (04:10 Uhr) bis Montag 17.08.2026 (04:30 Uhr)'),
        false,
      );
    });

    it('parses ab/bis rows when KVV omits the "ab" token', () => {
      assert.deepStrictEqual(
        parseTripLineFields('10075 Ettlingen Albgaubad 19:34 Uhr bis Hochstetten an 20:46 Uhr'),
        [
          {
            trainNumber: '10075',
            fromStop: 'Ettlingen Albgaubad',
            fromTime: '19:34',
            toStop: 'Hochstetten',
            toTime: '20:46',
          },
        ],
      );
    });

    it('parses lowercase Uhr and parentheses inside stop names', () => {
      assert.deepStrictEqual(
        parseTripLineFields(
          '85630 Bondorf (b. Herrenberg) (08:02 uhr) - Ka. Tullastrasse (11:00 Uhr)',
        ),
        [
          {
            trainNumber: '85630',
            fromStop: 'Bondorf (b. Herrenberg)',
            fromTime: '08:02',
            toStop: 'Ka. Tullastrasse',
            toTime: '11:00',
          },
        ],
      );
    });

    it('parses a parenthesized row whose separator is missing', () => {
      assert.deepStrictEqual(
        parseTripLineFields(
          '85029 Knielingen Rheinbergstr. (21:41 Uhr) Pforzheim Hbf. (22:50 Uhr)',
        ),
        [
          {
            trainNumber: '85029',
            fromStop: 'Knielingen Rheinbergstr.',
            fromTime: '21:41',
            toStop: 'Pforzheim Hbf.',
            toTime: '22:50',
          },
        ],
      );
    });

    it('never merges adjacent rows that each start with a train number', () => {
      const text = [
        'Betroffene Fahrten:',
        '99991 malformed row',
        '99992 Start (10:00 Uhr) - Ziel (11:00 Uhr)',
      ].join('\n');
      assert.deepStrictEqual(extractTripLines(text), [
        '99992 Start (10:00 Uhr) - Ziel (11:00 Uhr)',
      ]);
    });
  });

  describe('Stand date extraction', () => {
    it('keeps a midnight German article date independent of the process timezone', () => {
      assert.deepStrictEqual(extractStand('Nach aktuellem Stand 06.07.2026 00:17:00'), {
        standIso: '2026-07-05T22:17:00.000Z',
        dateForTrips: '2026-07-06',
        hasStand: true,
      });
    });

    it('applies the Europe/Berlin winter offset', () => {
      assert.strictEqual(parseGermanDateTime('06.01.2026', '12:17:00'), '2026-01-06T11:17:00.000Z');
    });
  });

  describe('Known-train-number tripwire', () => {
    // 85879 is a known 2026 S-line number; the second row is trip-like (two times) but
    // matches no format. It must be surfaced as an error WITHOUT discarding the good trip.
    const html = `
      <html><body>
        <p>Betriebsbedingte Fahrtausfälle auf der Linie S42</p>
        <p>Nach aktuellem Stand 04.07.2026 12:30:00</p>
        <p>Betroffene Fahrten:</p>
        <p>84957 Rheinbergstraße 05:02 Uhr - Pforzheim 06:11 Uhr</p>
        <p>85879 Heilbronn Hbf 10:00 Uhr nach Sinsheim Hbf 11:00 Uhr</p>
        <p>Ob deine Verbindung aktuell fährt</p>
      </body></html>
    `;

    it('keeps the good trip and still reports the dropped known-number row', () => {
      const trips = parseDetailPage(html, 'test://known-number-miss');
      // The parseable row is retained rather than thrown away.
      assert.equal(trips.length, 1);
      assert.equal(trips[0]?.trainNumber, '84957');

      // The dropped known-number row is surfaced so CI fails as a notification.
      const error = findMissedKnownTripsError(html, trips, 'test://known-number-miss');
      assert.ok(error, 'expected a ParseError for the dropped known-number row');
      assert.match(error.message, /known train number/i);
      assert.match(error.message, /85879/);
    });

    it('does not report a dropped row whose number is not in the official data', () => {
      // 99999 is not a known Zugnummer — absence is not proof it is not a trip, so it must
      // not fail CI (it only warns in parseDetailPage).
      const unknownHtml = html.replace('85879', '99999');
      const trips = parseDetailPage(unknownHtml, 'test://unknown-number-miss');
      assert.equal(
        findMissedKnownTripsError(unknownHtml, trips, 'test://unknown-number-miss'),
        undefined,
      );
    });
  });

  describe('Trip section extraction', () => {
    it('should detect trip section markers with flexible whitespace', () => {
      const text = `
        Linie S5
        Betroffene   Fahrten:
        84957 Rheinbergstraße 05:02 Uhr - Pforzheim 06:11 Uhr
        Ob deine Verbindung aktuell fährt
      `;

      const candidates = extractTripSectionCandidates(text);
      assert.deepStrictEqual(candidates, ['84957 Rheinbergstraße 05:02 Uhr - Pforzheim 06:11 Uhr']);
    });

    it('should fall back to scanning the full text when the trip marker section is empty', () => {
      const text = `
        Linie S5
        Betroffene Fahrten:

        Zusatzhinweis ohne konkrete Fahrten

        84957 Rheinbergstraße 05:02 Uhr - Pforzheim 06:11 Uhr
      `;

      const tripLines = extractTripLines(text);
      assert.deepStrictEqual(tripLines, ['84957 Rheinbergstraße 05:02 Uhr - Pforzheim 06:11 Uhr']);
    });
  });
});
