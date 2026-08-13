import { describe, it } from 'node:test';
import assert from 'node:assert';
import { analyzeDetailPage, analyzeRssItem } from '../../src/relevance.js';
import { classifyCause } from '../../src/cause.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('Relevance - Construction Notices', () => {
  it('should now keep RSS items that are cancellations due to construction work', () => {
    const result = analyzeRssItem({
      title: 'Linie 116 - Gaistal: Fahrtausfall wegen Bauarbeiten',
      contentSnippet: 'Fahrtausfall wegen Bauarbeiten',
      content: '',
      link: 'test://construction-rss',
    });

    // Cause is no longer used for filtering: construction cancellations are relevant.
    assert.strictEqual(result.isRelevant, true);
    // The intent of the old veto is now expressed via cause classification instead.
    assert.strictEqual(classifyCause('Fahrtausfall wegen Bauarbeiten'), 'construction');
  });

  it('should now keep detail pages where cancellation is caused by construction', () => {
    const html = `
      <html>
        <body>
          <h2>Linie 116</h2>
          <h3>Gaistal: Fahrtausfall wegen Bauarbeiten</h3>
          <p>Folgende Fahrten sind davon betroffen und entfallen ersatzlos:</p>
          <ul>
            <li>08:02 Uhr Bad Herrenalb Bahnhof - 08:25 Uhr Gaistal Oberes Gaistal</li>
            <li>08:35 Uhr Gaistal Oberes Gaistal - 08:58 Uhr Bad Herrenalb Falkensteinschule</li>
          </ul>
        </body>
      </html>
    `;

    const result = analyzeDetailPage(html);
    assert.strictEqual(result.isRelevant, true);
    assert.strictEqual(classifyCause(html), 'construction');
  });

  it('should keep personnel-related cancellations relevant', () => {
    const result = analyzeRssItem({
      title: 'Linie S5: Betriebsbedingter Fahrtausfall wegen Personalmangel',
      contentSnippet: 'Betriebsbedingte Fahrtausfälle',
      content: '',
      link: 'test://personnel-rss',
    });

    assert.strictEqual(result.isRelevant, true);
  });

  it('should keep an item whose only cancellation signal is the plural "entfallen"', () => {
    // A headline naming no cancellation term at all, with the plural verb carrying the whole
    // signal — the wording that silently lost two S7 trips before `entfallen` was a keyword.
    const result = analyzeRssItem({
      title: 'S7: Abweichungen im Betriebsablauf',
      contentSnippet:
        'Einzelne Fahrten der Linie S7 entfallen zwischen Karlsruhe Poststraße und ' +
        'Karlsruhe Tullastraße/Alter Schlachthof',
      content: '',
      link: 'test://entfallen-plural-rss',
    });

    assert.strictEqual(result.isRelevant, true);
  });
});

describe('Relevance - Real Article Fixtures', () => {
  const fixtures = [
    {
      name: 'article-269057-s4',
      description: 'S4 operational cancellations (betriebsbedingt)',
      expectedTripCount: 2,
    },
    {
      name: 'article-269033-s7',
      description: 'S7 operational cancellation (betriebsbedingt)',
      expectedTripCount: 1,
    },
    {
      name: 'article-269025-s5-s52-s6',
      description: 'S5/S52/S6 multi-line cancellations caused by Fahrpersonal shortage',
      expectedTripCount: 8,
    },
  ];

  for (const { name, description, expectedTripCount } of fixtures) {
    it(`should detect ${description} as relevant`, () => {
      const { html } = loadFixture(name);
      const result = analyzeDetailPage(html);

      assert.strictEqual(result.isRelevant, true, `${name} should be relevant`);
      assert.strictEqual(
        result.tripRowCount,
        expectedTripCount,
        `${name} should have ${expectedTripCount} trip lines`,
      );
    });
  }
});

describe('Relevance - Article Region Scoping', () => {
  // KVV wraps every notice in ~38k characters of navigation and footer. Scoring those would let
  // a single site-wide menu change re-gate every article at once, so only <main> is scored.
  const CHROME = `
    <header><nav><ul>
      <li><a href="/bauarbeiten">Bauarbeiten und Sperrungen</a></li>
      <li><a href="/stoerungen">Störungen: Fahrtausfälle und Zugausfälle</a></li>
    </ul></nav></header>`;

  it('ignores cancellation keywords that appear only in the site chrome', () => {
    const html = `<html><body>${CHROME}
      <main><h2>Allgemeine Fahrgastinformation</h2>
      <p>Die Aufzüge am Hauptbahnhof werden gewartet.</p></main>
    </body></html>`;

    assert.strictEqual(analyzeDetailPage(html).isRelevant, false);
  });

  it('still scores a notice whose page has no main region', () => {
    const html = `<html><body><h2>Linie S1</h2>
      <p>Betroffene Fahrten: folgende Fahrten entfallen.</p>
      <p>85879 Heilbronn Hbf 10:00 Uhr - Sinsheim Hbf 11:00 Uhr</p></body></html>`;

    assert.strictEqual(analyzeDetailPage(html).isRelevant, true);
  });
});
