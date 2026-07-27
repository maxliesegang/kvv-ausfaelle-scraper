import assert from 'node:assert';
import { describe, it } from 'node:test';
import { getBerlinWallClockMs } from '../../src/utils/berlin-time.js';

describe('Berlin wall clock', () => {
  it('should resolve a winter (CET, UTC+1) departure', () => {
    assert.strictEqual(
      getBerlinWallClockMs('2024-12-16', '08:00'),
      Date.parse('2024-12-16T07:00:00.000Z'),
    );
  });

  it('should resolve a summer (CEST, UTC+2) departure', () => {
    // The trips lost from Nettro_CMS_273340 on 2026-07-27.
    assert.strictEqual(
      getBerlinWallClockMs('2026-07-27', '05:02'),
      Date.parse('2026-07-27T03:02:00.000Z'),
    );
  });

  it('should resolve times on both sides of a DST transition', () => {
    // 2026-03-29: clocks jump 02:00 → 03:00 Berlin.
    assert.strictEqual(
      getBerlinWallClockMs('2026-03-29', '01:30'),
      Date.parse('2026-03-29T00:30:00.000Z'),
    );
    assert.strictEqual(
      getBerlinWallClockMs('2026-03-29', '03:30'),
      Date.parse('2026-03-29T01:30:00.000Z'),
    );
  });

  it('should handle midnight and end-of-day times', () => {
    assert.strictEqual(
      getBerlinWallClockMs('2026-07-27', '00:00'),
      Date.parse('2026-07-26T22:00:00.000Z'),
    );
    assert.strictEqual(
      getBerlinWallClockMs('2026-07-27', '23:59'),
      Date.parse('2026-07-27T21:59:00.000Z'),
    );
  });

  it('should return NaN for malformed input rather than a 1970 timestamp', () => {
    assert.ok(Number.isNaN(getBerlinWallClockMs('2026-07-27', '5:02 Uhr')));
    assert.ok(Number.isNaN(getBerlinWallClockMs('27.07.2026', '05:02')));
    assert.ok(Number.isNaN(getBerlinWallClockMs('', '')));
  });
});
