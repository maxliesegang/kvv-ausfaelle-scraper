import assert from 'node:assert';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Item } from '../../src/types.js';
import { processRssItem } from '../../src/workflow.js';

const NOW_MS = Date.parse('2026-07-23T12:00:00Z');
const DETAIL_URL =
  'https://www.kvv.de/fahrplan/verkehrsmeldungen.html?' +
  'tx_ixkvvticker_list%5BdetailID%5D=Nettro_CMS_archive_test';
const ARCHIVE_PATH = ['2026', 'articles', 'Nettro_CMS_archive_test.txt'] as const;

describe('Workflow article archive eligibility', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kvv-workflow-archive-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('archives an old-enough article even when RSS relevance rejects it', async () => {
    const html =
      '<html><main><p>Allgemeine Fahrgastinformation.</p>' +
      '<p>Stand 23.07.2026 10:00:00</p></main></html>';
    const item: Item = {
      link: DETAIL_URL,
      pubDate: 'Thu, 23 Jul 2026 10:00:00 GMT',
    };

    const outcome = await processRssItem(item, {
      dataDir: tempDir,
      fetchDetail: async () => html,
      nowMs: NOW_MS,
    });

    assert.deepStrictEqual(outcome, { status: 'skipped', reason: 'low-rss-relevance' });
    const archived = await readFile(join(tempDir, ...ARCHIVE_PATH), 'utf-8');
    assert.match(archived, /Allgemeine Fahrgastinformation\./);
  });

  it('archives an old-enough article even when detail relevance rejects it', async () => {
    const html =
      '<html><main><p>Allgemeine Fahrgastinformation.</p>' +
      '<p>Stand 23.07.2026 10:00:00</p></main></html>';
    const item: Item = {
      title: 'Betriebsbedingte Fahrtausfälle',
      link: DETAIL_URL,
      pubDate: 'Thu, 23 Jul 2026 10:00:00 GMT',
    };

    const outcome = await processRssItem(item, {
      dataDir: tempDir,
      fetchDetail: async () => html,
      nowMs: NOW_MS,
    });

    assert.deepStrictEqual(outcome, { status: 'skipped', reason: 'low-detail-relevance' });
    const archived = await readFile(join(tempDir, ...ARCHIVE_PATH), 'utf-8');
    assert.match(archived, /Allgemeine Fahrgastinformation\./);
  });

  it('does not archive an article younger than one hour', async () => {
    const html =
      '<html><main><p>Linie S1: Folgende Fahrten fallen aus.</p>' +
      '<p>Stand 23.07.2026 11:30:00</p></main></html>';
    const item: Item = {
      link: DETAIL_URL,
      pubDate: 'Thu, 23 Jul 2026 11:30:00 GMT',
    };

    let detailFetched = false;
    const outcome = await processRssItem(item, {
      dataDir: tempDir,
      fetchDetail: async () => {
        detailFetched = true;
        return html;
      },
      nowMs: NOW_MS,
    });

    assert.deepStrictEqual(outcome, { status: 'skipped', reason: 'too-young' });
    assert.strictEqual(detailFetched, false, 'young articles should not be fetched');
    await assert.rejects(access(join(tempDir, ...ARCHIVE_PATH)));
  });
});
