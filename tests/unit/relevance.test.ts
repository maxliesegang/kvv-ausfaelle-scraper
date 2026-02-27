import { describe, it } from 'node:test';
import assert from 'node:assert';
import { analyzeDetailPage, analyzeRssItem } from '../../src/relevance.js';

describe('Relevance - Construction False Positives', () => {
  it('should exclude RSS items that are cancellations due to construction work', () => {
    const result = analyzeRssItem({
      title: 'Linie 116 - Gaistal: Fahrtausfall wegen Bauarbeiten',
      contentSnippet: 'Fahrtausfall wegen Bauarbeiten',
      content: '',
      link: 'test://construction-rss',
    });

    assert.strictEqual(result.isRelevant, false);
    assert.match(
      result.reasons.join(' '),
      /construction-related notice without personnel shortage signal/i,
    );
  });

  it('should exclude detail pages where cancellation is caused by construction', () => {
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
    assert.strictEqual(result.isRelevant, false);
    assert.match(
      result.reasons.join(' '),
      /construction-related notice without personnel shortage signal/i,
    );
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
});
