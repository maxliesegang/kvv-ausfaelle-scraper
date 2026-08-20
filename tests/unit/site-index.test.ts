import assert from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  generateSiteIndices,
  ROOT_INDEX_SCHEMA_VERSION,
  type VerificationSummary,
} from '../../src/site-index.js';
import { PUBLIC_CAUSE_DEFINITIONS, type PublicCauseDefinition } from '../../src/cause.js';
import {
  PUBLIC_VERIFICATION_STATUS_DEFINITIONS,
  type PublicVerificationStatusDefinition,
} from '../../src/verification/verify.js';

interface RootIndexData {
  readonly schemaVersion: number;
  readonly years: readonly string[];
  readonly causes: readonly PublicCauseDefinition[];
  readonly verificationStatuses: readonly PublicVerificationStatusDefinition[];
  readonly generatedAt: string;
}

interface YearIndexData {
  readonly year: string;
  readonly files: readonly string[];
  readonly verification: VerificationSummary;
  readonly generatedAt: string;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as T;
}

describe('Site index generation', () => {
  it('should generate sorted root and year indices with one timestamp per run', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kvv-site-index-'));

    try {
      const year2025Dir = join(tempDir, '2025');
      const year2026Dir = join(tempDir, '2026');

      await mkdir(year2025Dir, { recursive: true });
      await mkdir(join(year2025Dir, 'train-line-definitions'), { recursive: true });
      await mkdir(year2026Dir, { recursive: true });

      await writeFile(join(year2025Dir, 'S2.json'), '[]\n');
      await writeFile(join(year2025Dir, 'S1.json'), '[]\n');
      await writeFile(join(year2025Dir, 'notes.txt'), 'ignore\n');
      await writeFile(join(year2026Dir, 'S5.json'), '[]\n');

      await generateSiteIndices(tempDir);

      const rootIndex = await readJsonFile<RootIndexData>(join(tempDir, 'index.json'));
      const year2025Index = await readJsonFile<YearIndexData>(join(year2025Dir, 'index.json'));
      const year2026Index = await readJsonFile<YearIndexData>(join(year2026Dir, 'index.json'));

      assert.strictEqual(rootIndex.schemaVersion, ROOT_INDEX_SCHEMA_VERSION);
      assert.deepStrictEqual(rootIndex.years, ['2025', '2026']);
      assert.deepStrictEqual(rootIndex.causes, PUBLIC_CAUSE_DEFINITIONS);
      assert.ok(
        rootIndex.causes.every(
          ({ label, description }) => label.length > 0 && description.length > 0,
        ),
      );
      assert.ok(rootIndex.causes.every((cause) => !('keywords' in cause)));
      assert.deepStrictEqual(year2025Index.files, ['S1.json', 'S2.json']);
      assert.deepStrictEqual(year2026Index.files, ['S5.json']);
      assert.strictEqual(year2025Index.generatedAt, rootIndex.generatedAt);
      assert.strictEqual(year2026Index.generatedAt, rootIndex.generatedAt);

      const rootHtml = await readFile(join(tempDir, 'index.html'), 'utf-8');
      assert.match(rootHtml, /<a href="\.\/2025\/">2025<\/a>/);
      assert.match(rootHtml, /<a href="\.\/2026\/">2026<\/a>/);
      assert.match(rootHtml, /<code>emergency<\/code> — Einsatz von Rettungskräften/);
      assert.match(rootHtml, /<code>unknown<\/code> — Unbekannt/);

      const yearHtml = await readFile(join(year2025Dir, 'index.html'), 'utf-8');
      assert.match(yearHtml, /<a href="\.\/S1\.json"><code>S1\.json<\/code><\/a>/);
      assert.match(yearHtml, /<a href="\.\/S2\.json"><code>S2\.json<\/code><\/a>/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // Verdicts stored per trip are invisible to anyone who has not already downloaded a line file.
  // The summary is what makes them discoverable — above all that some announced cancellations were
  // later observed to have run.
  it('should summarize stored verification verdicts per year', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kvv-site-index-verification-'));

    try {
      const yearDir = join(tempDir, '2026');
      await mkdir(yearDir, { recursive: true });
      const trip = (verificationStatus?: string): Record<string, unknown> => ({
        line: 'S1',
        date: '2026-08-13',
        trainNumber: '84805',
        ...(verificationStatus
          ? { verification: { status: verificationStatus, source: 'bahn.expert' } }
          : {}),
      });
      await writeFile(
        join(yearDir, 'S1.json'),
        JSON.stringify([trip('cancelled'), trip('ran'), trip()]),
      );
      await writeFile(join(yearDir, 'S2.json'), JSON.stringify([trip('cancelled'), trip()]));

      await generateSiteIndices(tempDir);

      const yearIndex = await readJsonFile<YearIndexData>(join(yearDir, 'index.json'));
      assert.strictEqual(yearIndex.verification.source, 'bahn.expert');
      assert.strictEqual(yearIndex.verification.totalTrips, 5);
      assert.strictEqual(yearIndex.verification.checkedTrips, 3);
      assert.deepStrictEqual(yearIndex.verification.statusCounts, { cancelled: 2, ran: 1 });
      // Published in taxonomy order rather than discovery order, so the summary always reads the
      // same way whichever line file happened to be scanned first.
      assert.deepStrictEqual(Object.keys(yearIndex.verification.statusCounts), [
        'cancelled',
        'ran',
      ]);

      const rootIndex = await readJsonFile<RootIndexData>(join(tempDir, 'index.json'));
      assert.deepStrictEqual(
        rootIndex.verificationStatuses,
        PUBLIC_VERIFICATION_STATUS_DEFINITIONS,
      );

      const yearHtml = await readFile(join(yearDir, 'index.html'), 'utf-8');
      assert.match(yearHtml, /<code>cancelled<\/code> — Cancelled: <strong>2<\/strong>/);
      assert.match(yearHtml, /<code>ran<\/code> — Ran: <strong>1<\/strong>/);
      assert.match(yearHtml, /3 of 5 stored trips carry a verdict/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should report an unverified year without claiming a verdict', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kvv-site-index-unverified-'));

    try {
      const yearDir = join(tempDir, '2026');
      await mkdir(yearDir, { recursive: true });
      await writeFile(join(yearDir, 'S1.json'), '[{"line":"S1"}]');
      // A malformed line file must cost the site nothing but that file's trips.
      await writeFile(join(yearDir, 'S2.json'), '{"not":"an array"}');

      await generateSiteIndices(tempDir);

      const yearIndex = await readJsonFile<YearIndexData>(join(yearDir, 'index.json'));
      assert.strictEqual(yearIndex.verification.checkedTrips, 0);
      assert.strictEqual(yearIndex.verification.totalTrips, 1);
      assert.deepStrictEqual(yearIndex.verification.statusCounts, {});

      const yearHtml = await readFile(join(yearDir, 'index.html'), 'utf-8');
      assert.match(yearHtml, /No trips in bahn\.expert's lookback window have been verified yet\./);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
