import assert from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { saveCancellations } from '../../src/storage.js';
import type { Cancellation } from '../../src/types.js';
import { withTempDataDir } from '../helpers/test-utils.js';

function createCancellation(overrides: Partial<Cancellation> = {}): Cancellation {
  return {
    line: 'S1',
    date: '2024-12-16',
    stand: '2024-12-16T12:00:00.000Z',
    trainNumber: '10001',
    fromStop: 'Karlsruhe Hbf',
    fromTime: '08:00',
    toStop: 'Pforzheim Hbf',
    toTime: '09:00',
    sourceUrl: 'test://article',
    capturedAt: '2024-12-16T12:05:00.000Z',
    cause: 'operational',
    causeKeyword: 'betriebsbedingt',
    ...overrides,
  };
}

/**
 * Reconciliation instants for the 2024-12-16 fixtures, pinned so past-trip retention is
 * judged against a fixed clock. December is CET (UTC+1), so 08:00 Berlin is 07:00Z.
 */
const BEFORE_DEPARTURES_MS = Date.parse('2024-12-16T05:00:00.000Z'); // 06:00 Berlin
const MIDDAY_MS = Date.parse('2024-12-16T12:00:00.000Z'); // 13:00 Berlin

/** Every fixture here is a 2024-12-16 trip, which belongs to Fahrplan year 2025. */
const BUCKET = join('2025', 'S1.json');

/** Writes a bucket file as an earlier run would have left it, and returns its path. */
async function seedBucket(dir: string, trips: readonly unknown[]): Promise<string> {
  const filePath = join(dir, BUCKET);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(trips, null, 2));
  return filePath;
}

async function readBucket(filePath: string): Promise<Cancellation[]> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as Cancellation[];
}

describe('Storage', () => {
  it('should deduplicate existing trips and keep stored entries sorted', async () => {
    await withTempDataDir(async ({ dir }) => {
      // 10003 comes from a different article that is not re-fetched this run, so it
      // must persist; 10001 shares the source with the incoming batch and is deduped.
      const bucket = await seedBucket(dir, [
        createCancellation({
          trainNumber: '10003',
          fromTime: '10:00',
          toTime: '11:00',
          sourceUrl: 'test://older-article',
        }),
        createCancellation(),
      ]);

      await saveCancellations(dir, [
        createCancellation(),
        createCancellation({ trainNumber: '10002', fromTime: '07:30', toTime: '08:30' }),
        createCancellation({
          line: 'S2',
          date: '2025-12-15',
          trainNumber: '20001',
          fromStop: 'Ettlingen',
          fromTime: '06:00',
          toStop: 'Karlsruhe Tullastraße',
          toTime: '06:30',
        }),
      ]);

      assert.deepStrictEqual(
        (await readBucket(bucket)).map((trip) => ({
          date: trip.date,
          fromTime: trip.fromTime,
          trainNumber: trip.trainNumber,
        })),
        [
          { date: '2024-12-16', fromTime: '07:30', trainNumber: '10002' },
          { date: '2024-12-16', fromTime: '08:00', trainNumber: '10001' },
          { date: '2024-12-16', fromTime: '10:00', trainNumber: '10003' },
        ],
      );

      const secondBucket = await readBucket(join(dir, '2026', 'S2.json'));
      assert.strictEqual(secondBucket.length, 1);
      assert.strictEqual(secondBucket[0]?.trainNumber, '20001');
    });
  });

  it('should overwrite a stored cause when a re-parse reclassifies the same trip', async () => {
    await withTempDataDir(async ({ dir }) => {
      // Stored from an earlier run when the classifier could not categorize the article.
      const bucket = await seedBucket(dir, [createCancellation({ cause: 'unknown' })]);

      // Same trip (same key), re-parsed this run with an improved cause classification.
      await saveCancellations(dir, [createCancellation({ cause: 'operational' })]);

      const storedTrips = await readBucket(bucket);
      assert.strictEqual(storedTrips.length, 1);
      assert.strictEqual(storedTrips[0]?.cause, 'operational');
    });
  });

  it('should overwrite refined evidence when the cause category stays the same', async () => {
    await withTempDataDir(async ({ dir }) => {
      const bucket = await seedBucket(dir, [
        createCancellation({ cause: 'weather', causeKeyword: 'witterung' }),
      ]);

      await saveCancellations(dir, [
        createCancellation({ cause: 'weather', causeKeyword: 'witterungsbedingt' }),
      ]);

      const storedTrips = await readBucket(bucket);
      assert.strictEqual(storedTrips[0]?.cause, 'weather');
      assert.strictEqual(storedTrips[0]?.causeKeyword, 'witterungsbedingt');
    });
  });

  it('should prune ghost trips that vanished from a re-fetched source article', async () => {
    await withTempDataDir(async ({ dir }) => {
      // Existing data captured from an earlier version of the article: it listed
      // both 10001 and 10003. A second, unrelated article contributed 99999.
      const bucket = await seedBucket(dir, [
        createCancellation({ trainNumber: '10001', fromTime: '08:00' }),
        createCancellation({ trainNumber: '10003', fromTime: '10:00' }),
        createCancellation({
          trainNumber: '99999',
          fromTime: '20:00',
          sourceUrl: 'test://other-article',
        }),
      ]);

      // KVV edited the article in place: it now lists only 10001 (10003 is gone).
      // The other article was not re-fetched this run. Judged from before every
      // departure, so all three are still retractable.
      await saveCancellations(
        dir,
        [createCancellation({ trainNumber: '10001', fromTime: '08:00' })],
        BEFORE_DEPARTURES_MS,
      );

      // 10003 pruned (ghost from same source); 10001 kept (still listed);
      // 99999 kept (its article was not re-fetched, so never reconciled).
      assert.deepStrictEqual((await readBucket(bucket)).map((trip) => trip.trainNumber).sort(), [
        '10001',
        '99999',
      ]);
    });
  });

  it('should keep departed trips that a re-fetched article dropped from its rolling list', async () => {
    await withTempDataDir(async ({ dir }) => {
      // The Nettro_CMS_273340 shape: a morning trip that already ran, plus an
      // evening one still ahead, both from the same article.
      const bucket = await seedBucket(dir, [
        createCancellation({ trainNumber: '10001', fromTime: '08:00', toTime: '09:00' }),
        createCancellation({ trainNumber: '10003', fromTime: '18:00', toTime: '19:00' }),
      ]);

      // Midday re-fetch: KVV has rewritten the article down to trips still to come,
      // dropping the departed 10001 and the upcoming 10003 alike.
      await saveCancellations(
        dir,
        [createCancellation({ trainNumber: '10007', fromTime: '17:00', toTime: '17:45' })],
        MIDDAY_MS,
      );

      // 10001 kept: it had already departed, so un-listing it is garbage collection,
      // not a retraction. 10003 pruned: still in the future, so KVV un-listing it is
      // a genuine retraction and reconciliation must still act on it.
      assert.deepStrictEqual((await readBucket(bucket)).map((trip) => trip.trainNumber).sort(), [
        '10001',
        '10007',
      ]);
    });
  });

  it('should report a retained departed trip in the run log', async () => {
    await withTempDataDir(async ({ dir, logLines }) => {
      await seedBucket(dir, [createCancellation({ trainNumber: '10001', fromTime: '08:00' })]);

      await saveCancellations(
        dir,
        [createCancellation({ trainNumber: '10007', fromTime: '17:00', toTime: '17:45' })],
        MIDDAY_MS,
      );

      // Retention must be visible in a run: a silent keep is indistinguishable from
      // having had nothing to keep, which is what makes the rule auditable in CI logs.
      assert.ok(
        logLines.some((line) => line.includes('= kept') && line.includes('10001')),
        `expected a retained-trip log line, got:\n${logLines.join('\n')}`,
      );
      assert.ok(logLines.some((line) => line.includes('kept 1 departed entries')));
    });
  });

  it('should preserve restoredFrom when a re-parse reclassifies a recovered record', async () => {
    await withTempDataDir(async ({ dir }) => {
      // A hand-recovered record (see docs/AGENTS.md). The re-parse that follows knows
      // nothing about the recovery, so only the merge can keep the provenance.
      const bucket = await seedBucket(dir, [
        createCancellation({ cause: 'unknown', causeKeyword: null, restoredFrom: '372fdaba1a' }),
      ]);

      await saveCancellations(
        dir,
        [createCancellation({ cause: 'personnel', causeKeyword: 'fahrpersonal' })],
        BEFORE_DEPARTURES_MS,
      );

      const storedTrips = await readBucket(bucket);
      assert.strictEqual(storedTrips[0]?.cause, 'personnel');
      assert.strictEqual(storedTrips[0]?.restoredFrom, '372fdaba1a');
    });
  });

  it('should stamp legacy records that have no cause field as unknown', async () => {
    await withTempDataDir(async ({ dir }) => {
      // A record written before cause classification existed (no `cause` field).
      const { cause: _omitted, ...legacyRecord } = createCancellation({ trainNumber: '10009' });
      const bucket = await seedBucket(dir, [legacyRecord]);

      // Saving an unrelated trip (different source) triggers a load+merge+write of the
      // existing bucket without reconciling the legacy record out of it.
      await saveCancellations(dir, [
        createCancellation({
          trainNumber: '10010',
          fromTime: '07:30',
          toTime: '08:30',
          sourceUrl: 'test://other-article',
        }),
      ]);

      const legacy = (await readBucket(bucket)).find((trip) => trip.trainNumber === '10009');
      assert.strictEqual(legacy?.cause, 'unknown');
    });
  });
});
