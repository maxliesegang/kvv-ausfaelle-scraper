import assert from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { saveCancellations } from '../../src/storage.js';
import type { Cancellation } from '../../src/types.js';

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
    cause: 'personnel',
    ...overrides,
  };
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as T;
}

describe('Storage', () => {
  it('should deduplicate existing trips and keep stored entries sorted', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kvv-storage-'));
    const originalConsoleLog = console.log;

    try {
      console.log = () => undefined;

      const existingTrips = [
        createCancellation({ trainNumber: '10003', fromTime: '10:00', toTime: '11:00' }),
        createCancellation(),
      ];
      const existingFilePath = join(tempDir, '2025', 'S1.json');
      await mkdir(join(tempDir, '2025'), { recursive: true });
      await writeFile(existingFilePath, JSON.stringify(existingTrips, null, 2));

      await saveCancellations(tempDir, [
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

      const storedTrips = await readJsonFile<Cancellation[]>(existingFilePath);
      assert.deepStrictEqual(
        storedTrips.map((trip) => ({
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

      const secondBucket = await readJsonFile<Cancellation[]>(join(tempDir, '2026', 'S2.json'));
      assert.strictEqual(secondBucket.length, 1);
      assert.strictEqual(secondBucket[0]?.trainNumber, '20001');
    } finally {
      console.log = originalConsoleLog;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should stamp legacy records that have no cause field as unknown', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kvv-storage-'));
    const originalConsoleLog = console.log;

    try {
      console.log = () => undefined;

      // A record written before cause classification existed (no `cause` field).
      const { cause: _omitted, ...legacyRecord } = createCancellation({ trainNumber: '10009' });
      const existingFilePath = join(tempDir, '2025', 'S1.json');
      await mkdir(join(tempDir, '2025'), { recursive: true });
      await writeFile(existingFilePath, JSON.stringify([legacyRecord], null, 2));

      // Saving an unrelated trip triggers a load+merge+write of the existing bucket.
      await saveCancellations(tempDir, [
        createCancellation({ trainNumber: '10010', fromTime: '07:30', toTime: '08:30' }),
      ]);

      const storedTrips = await readJsonFile<Cancellation[]>(existingFilePath);
      const legacy = storedTrips.find((trip) => trip.trainNumber === '10009');
      assert.strictEqual(legacy?.cause, 'unknown');
    } finally {
      console.log = originalConsoleLog;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
