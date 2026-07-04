/**
 * Train lines resolution unit tests.
 * Covers the loaded-definition lookup plus the multi-line resolution policy against
 * synthetic definitions (deterministic, no disk dependency).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  lookupLinesForTrip,
  buildTrainLineIndex,
  resolveLinesInIndex,
  resolveLines,
} from '../../src/train-lines.js';
import {
  resolveAmbiguousTrip,
  type TripSignature,
} from '../../src/train-line-definitions/ambiguous-trips.js';
import type { TrainLineDefinition } from '../../src/train-line-definitions/types.js';
import { getCurrentFahrplanYear } from '../../src/fahrplan.js';

describe('Train Lines - Loaded definitions', () => {
  it('maps a known train number to its line when that line is mentioned', () => {
    assert.deepStrictEqual(lookupLinesForTrip({ trainNumber: '10001' }, ['S1']), ['S1']);
  });

  it('returns empty when the train number is unknown', () => {
    assert.deepStrictEqual(lookupLinesForTrip({ trainNumber: '99999' }, ['S1']), []);
  });

  it('returns empty when the line the number runs on is not mentioned', () => {
    assert.deepStrictEqual(lookupLinesForTrip({ trainNumber: '10001' }, ['S9']), []);
  });
});

describe('Train Lines - Article-scoped overrides (real data)', () => {
  // Article Nettro_CMS_271521 (2026 S5/S51 notice) forces 85758/85855/85096 onto S5, which
  // GTFS does NOT list them on for that year. Guarded so it self-skips once 2026 is stale.
  const is2026 = getCurrentFahrplanYear() === 2026;
  const detailId = 'Nettro_CMS_271521';
  const mentioned = ['S5', 'S51'];

  it('forces the number onto S5 for the exact article that needs it', { skip: !is2026 }, () => {
    assert.deepStrictEqual(lookupLinesForTrip({ trainNumber: '85758' }, mentioned, detailId), [
      'S5',
    ]);
  });

  it('does not apply the override without the detailID', { skip: !is2026 }, () => {
    // 85758 is only on S41 in GTFS, which the article does not mention → unresolved.
    assert.deepStrictEqual(lookupLinesForTrip({ trainNumber: '85758' }, mentioned), []);
  });

  it('does not apply the override for a different article', { skip: !is2026 }, () => {
    assert.deepStrictEqual(
      lookupLinesForTrip({ trainNumber: '85758' }, mentioned, 'Nettro_CMS_000000'),
      [],
    );
  });
});

describe('Train Lines - Multi-line resolution', () => {
  // 84872 is reused across S5/S51/S52; 70003 belongs only to S5.
  const definitions: TrainLineDefinition[] = [
    { line: 's5', trainNumbers: ['84872', '70003'] },
    { line: 'S51', trainNumbers: ['84872'] },
    { line: 'S52', trainNumbers: ['84872'] },
  ];
  const index = buildTrainLineIndex(definitions);

  it('returns the single mentioned line a number runs on', () => {
    assert.deepStrictEqual(resolveLinesInIndex(index, '70003', ['S5', 'S6']), ['S5']);
  });

  it('normalizes line definition casing while building the index', () => {
    assert.deepStrictEqual(index.exact['70003'], ['S5']);
  });

  it('normalizes train numbers before lookup', () => {
    assert.deepStrictEqual(resolveLinesInIndex(index, ' 70003 ', ['S5']), ['S5']);
  });

  it('returns every mentioned line a reused number runs on', () => {
    assert.deepStrictEqual(resolveLinesInIndex(index, '84872', ['S5', 'S52', 'S6']), ['S5', 'S52']);
  });

  it('intersects with mentioned lines (ignores unmentioned ones)', () => {
    assert.deepStrictEqual(resolveLinesInIndex(index, '84872', ['S51']), ['S51']);
  });

  it('returns empty when the number maps to none of the mentioned lines', () => {
    assert.deepStrictEqual(resolveLinesInIndex(index, '84872', ['S6', 'S7']), []);
  });

  it('returns empty for an unknown number', () => {
    assert.deepStrictEqual(resolveLinesInIndex(index, '99999', ['S5']), []);
  });

  it('uses a curated override when the override line is mentioned', () => {
    assert.deepStrictEqual(resolveLinesInIndex(index, '99999', ['S5'], { '99999': 'S5' }), ['S5']);
  });

  it('ignores a curated override when the override line is not mentioned', () => {
    assert.deepStrictEqual(resolveLinesInIndex(index, '99999', ['S6'], { '99999': 'S5' }), []);
  });
});

describe('Train Lines - Ambiguous-trip resolution', () => {
  // 85055 is reused the same day: a recycled S53 run (Wörth 07:45 → KA 08:10) and a
  // separate S6 run (Pforzheim 09:17 → 09:48). 85411 is one through-running train,
  // S7 (05:40 → 06:11) continuing as S4 (06:15 → 08:04). Dates: full Fahrplan year.
  const year: TripSignature['dates'] = [['20260101', '20261231']];
  const sigs: Record<string, TripSignature[]> = {
    '85055': [
      { line: 'S53', dep: '07:45', arr: '08:10', dates: year },
      { line: 'S5', dep: '07:45', arr: '09:10', dates: year },
      { line: 'S6', dep: '09:17', arr: '09:48', dates: year },
    ],
    '85411': [
      { line: 'S7', dep: '05:40', arr: '06:11', dates: year },
      { line: 'S4', dep: '06:15', arr: '08:04', dates: year },
    ],
    // 70010 runs S5 on weekdays, S8 on a different date window — date alone disambiguates.
    '70010': [
      { line: 'S5', dep: '08:00', arr: '08:30', dates: [['20260101', '20260630']] },
      { line: 'S8', dep: '08:00', arr: '08:30', dates: [['20260701', '20261231']] },
    ],
  };

  it('collapses a recycled run to the one line its times anchor', () => {
    const r = resolveAmbiguousTrip(sigs['85055']!, {
      fromTime: '07:45',
      toTime: '08:10',
      date: '2026-05-23',
    });
    assert.deepStrictEqual(r, { lines: ['S53'], confident: true });
  });

  it('reports every line of a through-running train spanning the time window', () => {
    const r = resolveAmbiguousTrip(sigs['85411']!, {
      fromTime: '05:40',
      toTime: '08:04',
      date: '2026-05-23',
    });
    assert.deepStrictEqual(r, { lines: ['S7', 'S4'], confident: true });
  });

  it('reports just the cancelled segment of a through-run (partial)', () => {
    const r = resolveAmbiguousTrip(sigs['85055']!, {
      fromTime: '09:17',
      toTime: '09:48',
      date: '2026-05-23',
    });
    assert.deepStrictEqual(r, { lines: ['S6'], confident: true });
  });

  it('resolves by date alone when the lines run on different days', () => {
    const r = resolveAmbiguousTrip(sigs['70010']!, {
      fromTime: '08:00',
      toTime: '08:30',
      date: '2026-03-15',
    });
    assert.deepStrictEqual(r, { lines: ['S5'], confident: true });
  });

  it('does not fabricate a run for a date outside the seeded year', () => {
    // 2025 article against 2026 signatures: the number is not in service then, so it must
    // degrade to all candidate lines UNCONFIDENTLY (not merge non-coexisting periods).
    const r = resolveAmbiguousTrip(sigs['85055']!, {
      fromTime: '07:45',
      toTime: '08:10',
      date: '2025-11-15',
    });
    assert.strictEqual(r.confident, false);
    assert.deepStrictEqual(r.lines.sort(), ['S5', 'S53', 'S6']);
  });

  it('falls back unconfidently when times anchor no run', () => {
    const r = resolveAmbiguousTrip(sigs['85055']!, {
      fromTime: '12:00',
      toTime: '12:30',
      date: '2026-05-23',
    });
    assert.strictEqual(r.confident, false);
    assert.deepStrictEqual(r.lines.sort(), ['S5', 'S53', 'S6']);
  });

  it('tolerates an off-by-one-minute article time when anchoring a run', () => {
    // GTFS S6 arrival 09:48 reported as 09:49 — still anchors the recycled S6 run.
    const r = resolveAmbiguousTrip(sigs['85055']!, {
      fromTime: '09:17',
      toTime: '09:49',
      date: '2026-05-23',
    });
    assert.deepStrictEqual(r, { lines: ['S6'], confident: true });
  });

  it('resolves a partial cancellation inside one run by containment', () => {
    // The article cancels only the first leg of the S5 run (06:45 → 07:26), so its end is
    // an intermediate stop, not the GTFS arrival. The window lies inside S5 alone → S5.
    const partial: TripSignature[] = [
      { line: 'S5', dep: '06:45', arr: '08:10', dates: year },
      { line: 'S6', dep: '08:17', arr: '08:52', dates: year },
    ];
    const r = resolveAmbiguousTrip(partial, {
      fromTime: '06:45',
      toTime: '07:26',
      date: '2026-05-23',
    });
    assert.deepStrictEqual(r, { lines: ['S5'], confident: true });
  });

  it('stays unconfident when a partial window sits inside several overlapping runs', () => {
    // Sibling runs share identical times: a sub-window cannot tell them apart.
    const siblings: TripSignature[] = [
      { line: 'S5', dep: '07:45', arr: '09:10', dates: year },
      { line: 'S51', dep: '07:45', arr: '09:10', dates: year },
    ];
    const r = resolveAmbiguousTrip(siblings, {
      fromTime: '08:00',
      toTime: '08:30',
      date: '2026-05-23',
    });
    assert.strictEqual(r.confident, false);
    assert.deepStrictEqual(r.lines.sort(), ['S5', 'S51']);
  });

  it('anchors a window that crosses midnight against a midnight-crossing run', () => {
    // 85099 runs a late S5 (22:42 → 23:50) and an S6 that crosses midnight (23:57 → 00:32).
    // The cancellation window also crosses midnight; it must pin the S6 run, not stay
    // ambiguous because fromTime > toTime.
    const nightly: TripSignature[] = [
      { line: 'S5', dep: '22:42', arr: '23:50', dates: year },
      { line: 'S6', dep: '23:57', arr: '00:32', dates: year },
    ];
    const r = resolveAmbiguousTrip(nightly, {
      fromTime: '23:57',
      toTime: '00:32',
      date: '2026-05-23',
    });
    assert.deepStrictEqual(r, { lines: ['S6'], confident: true });
  });

  it('resolveLines trusts a confident signature over the mentioned lines', () => {
    // The article mentioned S5/S52/S6 but the trip is really the S53 run.
    const index = buildTrainLineIndex([{ line: 'S5', trainNumbers: ['85055'] }]);
    const lines = resolveLines(
      index,
      sigs,
      { trainNumber: '85055', fromTime: '07:45', toTime: '08:10', date: '2026-05-23' },
      ['S5', 'S52', 'S6'],
    );
    assert.deepStrictEqual(lines, ['S53']);
  });

  it('resolveLines intersects with mentioned lines when not confident', () => {
    const index = buildTrainLineIndex([{ line: 'S5', trainNumbers: ['85055'] }]);
    const lines = resolveLines(
      index,
      sigs,
      { trainNumber: '85055', fromTime: '12:00', toTime: '12:30', date: '2026-05-23' },
      ['S5', 'S6'],
    );
    assert.deepStrictEqual(lines.sort(), ['S5', 'S6']);
  });

  it('resolveLines falls back to the flat index for non-shared numbers', () => {
    const index = buildTrainLineIndex([{ line: 'S1', trainNumbers: ['10001'] }]);
    const lines = resolveLines(index, sigs, { trainNumber: '10001' }, ['S1']);
    assert.deepStrictEqual(lines, ['S1']);
  });
});

describe('Train Lines - Data Validation', () => {
  it('should sort train numbers numerically, not lexicographically', () => {
    const numbers = ['10001', '10002', '10010', '10003'];
    const sorted = numbers.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    assert.deepStrictEqual(
      sorted,
      ['10001', '10002', '10003', '10010'],
      'Numbers should be sorted numerically',
    );
  });
});
