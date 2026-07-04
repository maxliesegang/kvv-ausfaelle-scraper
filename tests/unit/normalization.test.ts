/**
 * Tests for German text normalization.
 *
 * Regression coverage for the umlaut-expansion bug: umlaut words such as "entfällt"
 * must normalize to their ASCII digraph form ("entfaellt") so they match keyword lists
 * written as ae/oe/ue. Before the fix, NFD decomposition turned "ä" into "a", so
 * "entfällt" became "entfallt" and never matched the keyword "entfaellt".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractDetailId, normalizeGermanText } from '../../src/utils/normalization.js';
import { analyzeDetailPage, analyzeRssItem } from '../../src/relevance.js';

describe('normalizeGermanText - umlaut expansion', () => {
  it('expands "entfällt" to contain "entfaellt"', () => {
    assert.ok(normalizeGermanText('entfällt').includes('entfaellt'));
  });

  it('expands "fällt aus" to "faellt aus"', () => {
    assert.ok(normalizeGermanText('Die Fahrt fällt aus').includes('faellt aus'));
  });

  it('expands all umlauts and ß', () => {
    assert.strictEqual(normalizeGermanText('Größe über Straße'), 'groesse ueber strasse');
  });
});

describe('extractDetailId', () => {
  it('extracts the detailID from a URL-encoded KVV detail URL', () => {
    const url =
      'https://www.kvv.de/fahrplan/verkehrsmeldungen.html?tx_ixkvvticker_list%5Baction%5D=detail' +
      '&tx_ixkvvticker_list%5Bcontroller%5D=Ticker&tx_ixkvvticker_list%5BdetailID%5D=Nettro_CMS_271521';
    assert.strictEqual(extractDetailId(url), 'Nettro_CMS_271521');
  });

  it('extracts the detailID from a plain (un-encoded) parameter', () => {
    assert.strictEqual(
      extractDetailId('https://x/?detailID=Nettro_CMS_999&foo=1'),
      'Nettro_CMS_999',
    );
  });

  it('stops at the next query parameter or fragment', () => {
    assert.strictEqual(extractDetailId('https://x/?detailID=ABC#frag'), 'ABC');
  });

  it('returns undefined when there is no detailID or no URL', () => {
    assert.strictEqual(extractDetailId('https://www.kvv.de/'), undefined);
    assert.strictEqual(extractDetailId(''), undefined);
    assert.strictEqual(extractDetailId(undefined), undefined);
  });
});

describe('relevance via umlaut-only wording (regression)', () => {
  it('scores an RSS item worded only with "entfällt" as relevant', () => {
    const result = analyzeRssItem({
      title: 'Linie S5: Die Fahrt um 08:00 Uhr entfällt heute',
      contentSnippet: 'Die Fahrt entfällt',
      content: '',
      link: 'test://entfaellt-rss',
    });

    assert.strictEqual(result.isRelevant, true);
    assert.ok(result.keywordMatches.includes('entfaellt'));
  });

  it('scores a detail page worded only with "entfällt" as relevant', () => {
    const html = `
      <html>
        <body>
          <h2>Linie S5</h2>
          <p>Die folgende Fahrt entfällt heute:</p>
          <ul>
            <li>84957 Rheinbergstraße 05:02 Uhr - Pforzheim 06:11 Uhr</li>
          </ul>
        </body>
      </html>
    `;

    const result = analyzeDetailPage(html);
    assert.strictEqual(result.isRelevant, true);
    assert.ok(result.keywordMatches.includes('entfaellt'));
  });
});
