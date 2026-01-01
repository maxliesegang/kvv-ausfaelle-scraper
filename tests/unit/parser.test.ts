/**
 * Parser unit tests using Node's built-in test runner.
 * Tests the HTML parsing logic for KVV cancellation articles.
 */

import { describe, it } from 'node:test';
import { parseDetailPage } from '../../src/parser/index.js';
import { loadAllFixtures, loadFixture } from '../helpers/fixture-loader.js';
import { assertCancellationsEqual, assertThrows } from '../helpers/test-utils.js';

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
});
