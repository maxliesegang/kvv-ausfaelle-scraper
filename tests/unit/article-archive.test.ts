/**
 * Unit tests for the per-article text archive.
 * Verifies stable filenames, stable content, and graceful year/Stand fallbacks.
 */

import assert from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { archiveArticleText, parseArchive, renderArchive } from '../../src/article-archive.js';
import { parseDetailPage } from '../../src/parser/index.js';
import { loadAllFixtures } from '../helpers/fixture-loader.js';

const DETAIL_URL =
  'https://www.kvv.de/fahrplan/verkehrsmeldungen.html?tx_ixkvvticker_list%5Baction%5D=detail' +
  '&tx_ixkvvticker_list%5Bcontroller%5D=Ticker&tx_ixkvvticker_list%5BdetailID%5D=Nettro_CMS_257073';

const HTML_WITH_STAND = `
  <html><body>
    <h1>Linie S1</h1>
    <p>Nach aktuellem Stand 05.01.2026 14:30:00 entfallen folgende Fahrten.</p>
  </body></html>`;

describe('Article archive', () => {
  let tempDir: string;
  let restoreConsole: () => void;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kvv-archive-'));
    const originalWarn = console.warn;
    console.warn = () => undefined;
    restoreConsole = () => {
      console.warn = originalWarn;
    };
  });

  after(async () => {
    restoreConsole();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes to <year>/articles/<detailID>.txt with a stable, source-describing header', async () => {
    await archiveArticleText(tempDir, DETAIL_URL, HTML_WITH_STAND);

    // Stand date 05.01.2026 falls in Fahrplan year 2026.
    const filePath = join(tempDir, '2026', 'articles', 'Nettro_CMS_257073.txt');
    const content = await readFile(filePath, 'utf-8');

    assert.match(
      content,
      new RegExp(`^Quelle: ${DETAIL_URL.replace(/[.?*+^$()[\]{}|\\]/g, '\\$&')}`, 'm'),
    );
    assert.match(content, /^Stand: {2}2026-01-05T/m);
    assert.match(content, /entfallen folgende Fahrten\./);
  });

  it('produces byte-identical output across runs for an unchanged article', async () => {
    const filePath = join(tempDir, '2026', 'articles', 'Nettro_CMS_257073.txt');
    const first = await readFile(filePath, 'utf-8');
    await archiveArticleText(tempDir, DETAIL_URL, HTML_WITH_STAND);
    const second = await readFile(filePath, 'utf-8');

    assert.strictEqual(first, second, 'unchanged article must not produce a new diff');
  });

  it('sanitizes a filesystem-unsafe detailID so it cannot escape the archive dir', async () => {
    // A detailID with a path separator must not write outside <year>/articles/.
    const url = DETAIL_URL.replace('Nettro_CMS_257073', 'Nettro/../escape');
    await archiveArticleText(tempDir, url, HTML_WITH_STAND);

    // `/` and `.` collapse to `_`, keeping the file a single safe basename.
    const content = await findArchivedFile(tempDir, 'Nettro_escape.txt');
    assert.match(content, /entfallen folgende Fahrten\./);
  });

  it('records the feed item title and publication date, folding the multi-line title', async () => {
    const url = DETAIL_URL.replace('257073', '257074');
    // KVV's ticker packs headline, lead and validity range into one multi-line <title>.
    await archiveArticleText(tempDir, url, HTML_WITH_STAND, {
      rssTitle:
        'Betriebsbedingte Fahrtausfälle auf der Linie S1 - Betriebsbedingte Fahrtausfälle\n' +
        'zwischen Ettlingen und Hochstetten\n  (05.01.2026 bis 05.01.2026)',
      rssPublishedIso: '2026-01-05T13:30:00.000Z',
    });

    const content = await findArchivedFile(tempDir, 'Nettro_CMS_257074.txt');
    assert.match(
      content,
      /^Titel: {2}Betriebsbedingte Fahrtausfälle auf der Linie S1 - Betriebsbedingte Fahrtausfälle zwischen Ettlingen und Hochstetten \(05\.01\.2026 bis 05\.01\.2026\)$/m,
    );
    assert.match(content, /^Datum: {2}2026-01-05T13:30:00\.000Z$/m);

    const parsed = parseArchive(content);
    assert.strictEqual(parsed.rssPublishedIso, '2026-01-05T13:30:00.000Z');
    assert.match(parsed.rssTitle ?? '', /^Betriebsbedingte Fahrtausfälle auf der Linie S1 - /);
    assert.doesNotMatch(parsed.rssTitle ?? '', /\n/, 'title must round-trip as a single line');
  });

  it('records "unbekannt" for feed fields the item did not supply, and reads them back as absent', async () => {
    const url = DETAIL_URL.replace('257073', '257075');
    await archiveArticleText(tempDir, url, HTML_WITH_STAND);

    const content = await findArchivedFile(tempDir, 'Nettro_CMS_257075.txt');
    assert.match(content, /^Titel: {2}unbekannt$/m);
    assert.match(content, /^Datum: {2}unbekannt$/m);

    const parsed = parseArchive(content);
    assert.strictEqual(parsed.rssTitle, undefined);
    assert.strictEqual(parsed.rssPublishedIso, undefined);
  });

  it('reads a legacy archive that predates the feed-metadata header', () => {
    // Committed archives written before `Titel:`/`Datum:` existed must still parse: their
    // articles have left the RSS feed, so the fields can never be backfilled.
    const legacy = [
      `Quelle: ${DETAIL_URL}`,
      'Stand:  2026-01-05T13:30:00.000Z',
      '='.repeat(72),
      '',
      'Linie S1',
      'Titel: this prose line must not be mistaken for a header field',
      '',
    ].join('\n');

    const parsed = parseArchive(legacy);
    assert.strictEqual(parsed.url, DETAIL_URL);
    assert.strictEqual(parsed.rssTitle, undefined);
    assert.strictEqual(parsed.rssPublishedIso, undefined);
    assert.match(parsed.body, /^Linie S1/);
  });

  it('records Stand "unbekannt" when the page states none', async () => {
    const url = DETAIL_URL.replace('257073', '999999');
    await archiveArticleText(tempDir, url, '<html><body><p>Linie S1 faellt aus.</p></body></html>');

    // No Stand → foldered by the current Fahrplan year; locate the file by its id.
    const content = await findArchivedFile(tempDir, 'Nettro_CMS_999999.txt');
    assert.match(content, /^Stand: {2}unbekannt$/m);
  });
});

/**
 * Locks the property the reparse tooling (`scripts/reparse-archives.ts`) relies on: the
 * archived body is a faithful parser input, yielding the same trips as the original HTML.
 * If archive normalization or `stripHtml` ever drifts and breaks this, CI fails here.
 */
describe('Article archive - reparse fidelity', () => {
  const tripIdentity = (
    trips: { line: string; trainNumber: string; fromTime: string; toTime: string }[],
  ) => trips.map((t) => `${t.line}|${t.trainNumber}|${t.fromTime}|${t.toTime}`).sort();

  for (const fixture of loadAllFixtures()) {
    it(`reparses ${fixture.name} to the same trips as its HTML`, () => {
      const url = `test://${fixture.name}`;
      const fromHtml = parseDetailPage(fixture.html, url);

      const { content } = renderArchive(url, fixture.html);
      const { body } = parseArchive(content);
      const fromArchive = parseDetailPage(body, url);

      assert.deepStrictEqual(
        tripIdentity(fromArchive),
        tripIdentity(fromHtml),
        `archived text for ${fixture.name} must reparse to the same trips`,
      );
    });
  }
});

/** Reads an archived file by name from whichever year folder it landed in. */
async function findArchivedFile(baseDir: string, fileName: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const years = await readdir(baseDir);
  for (const year of years) {
    try {
      return await readFile(join(baseDir, year, 'articles', fileName), 'utf-8');
    } catch {
      // try next year folder
    }
  }
  throw new Error(`archived file ${fileName} not found under ${baseDir}`);
}
