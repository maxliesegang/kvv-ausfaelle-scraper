/**
 * Unit tests for the GTFS train-line seeding logic (offline, synthetic fixtures).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  parseCsv,
  buildLineDefinitions,
  buildAmbiguousTrips,
  collectTripEndpoints,
} from '../../scripts/seed-train-lines-from-gtfs.js';

describe('parseCsv', () => {
  it('parses headers and rows, trimming a BOM', () => {
    const rows = parseCsv('﻿a,b,c\n1,2,3\n4,5,6\n');
    assert.deepStrictEqual(rows, [
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('handles quoted fields with commas and CRLF line endings', () => {
    const rows = parseCsv('id,name\r\n1,"Karlsruhe, Hbf"\r\n2,"He said ""hi"""\r\n');
    assert.deepStrictEqual(rows, [
      { id: '1', name: 'Karlsruhe, Hbf' },
      { id: '2', name: 'He said "hi"' },
    ]);
  });
});

describe('buildLineDefinitions', () => {
  const agencyTxt = [
    'agency_id,agency_name',
    'kvv,Karlsruher Verkehrsverbund (KVV)',
    'db,DB Regio',
  ].join('\n');
  const routesTxt = [
    'route_id,agency_id,route_short_name',
    'r_s1,kvv,S1',
    'r_s31,kvv,S31',
    'r_re,kvv,RE2', // not an S-line → ignored
    'r_foreign,db,S1', // S-line but wrong agency → ignored
  ].join('\n');
  const tripsTxt = [
    'route_id,trip_short_name',
    'r_s1,10003',
    'r_s1,10001',
    'r_s1,10002',
    'r_s1,10001', // duplicate → deduped
    'r_s31,85696',
    'r_s31,', // missing short name
    'r_foreign,99999', // wrong agency route → must not leak into S1
  ].join('\n');

  it('joins routes+trips into a flat, sorted, deduped number list per S-line', () => {
    const { definitions, matchedAgencies } = buildLineDefinitions({
      routesTxt,
      tripsTxt,
      agencyTxt,
    });

    assert.deepStrictEqual(matchedAgencies, ['Karlsruher Verkehrsverbund (KVV)']);

    const s1 = definitions.find((d) => d.line === 'S1');
    assert.deepStrictEqual(s1?.trainNumbers, ['10001', '10002', '10003']);

    const s31 = definitions.find((d) => d.line === 'S31');
    assert.deepStrictEqual(s31?.trainNumbers, ['85696']);

    // RE2 and the foreign S1 route are excluded.
    assert.ok(!definitions.some((d) => d.line === 'RE2'));
    assert.ok(!s1?.trainNumbers.includes('99999'));
  });

  it('warns when trips.txt has no trip_short_name column', () => {
    const { warnings } = buildLineDefinitions({
      routesTxt,
      tripsTxt: 'route_id,trip_id\nr_s1,t1\n',
      agencyTxt,
    });
    assert.ok(warnings.some((w) => w.includes('no trip_short_name column')));
  });

  it('warns and skips agency filtering when no agency matches', () => {
    const { warnings } = buildLineDefinitions(
      { routesTxt, tripsTxt, agencyTxt },
      { agencyPattern: /nonexistent-operator/i },
    );
    assert.ok(warnings.some((w) => w.includes('No agency')));
  });
});

describe('collectTripEndpoints', () => {
  // GTFS-style quoted stop_times; columns before stop_headsign are simple tokens.
  const stopTimes = [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign',
    '"t1","05:40:00","05:40:00","a","1","Karlsruhe, Hbf"',
    '"t1","06:11:00","06:11:00","b","2","Karlsruhe, Hbf"',
    '"t2","25:10:00","25:10:00","c","1",""', // hours > 24 fold mod 24
    '"t2","25:40:00","25:40:00","d","2",""',
  ].join('\n');

  it('returns first-stop departure and last-stop arrival, folding 24h+ times', () => {
    const bytes = new TextEncoder().encode(stopTimes);
    const endpoints = collectTripEndpoints(bytes, new Set(['t1', 't2']));
    assert.deepStrictEqual(endpoints.get('t1'), { dep: '05:40', arr: '06:11' });
    assert.deepStrictEqual(endpoints.get('t2'), { dep: '01:10', arr: '01:40' });
  });

  it('ignores trips that are not wanted', () => {
    const bytes = new TextEncoder().encode(stopTimes);
    const endpoints = collectTripEndpoints(bytes, new Set(['t1']));
    assert.ok(!endpoints.has('t2'));
  });
});

describe('buildAmbiguousTrips', () => {
  const routesTxt = ['route_id,route_short_name', 'r5,S5', 'r53,S53', 'r6,S6'].join('\n');
  // 800 runs S5 and S53 (shared); 900 runs only S5 (not shared → excluded).
  const tripsTxt = [
    'route_id,trip_short_name,trip_id,service_id',
    'r5,800,t_s5,svc',
    'r53,800,t_s53,svc',
    'r5,900,t_only,svc',
  ].join('\n');
  const calendarDatesTxt = [
    'service_id,date,exception_type',
    'svc,20260110,1',
    'svc,20260111,1',
    'svc,20260112,1',
  ].join('\n');
  const endpoints = new Map([
    ['t_s5', { dep: '07:45', arr: '09:10' }],
    ['t_s53', { dep: '07:45', arr: '08:10' }],
    ['t_only', { dep: '06:00', arr: '06:30' }],
  ]);

  it('emits signatures only for shared numbers, with compressed date ranges', () => {
    const { trips, sharedNumberCount } = buildAmbiguousTrips(
      { routesTxt, tripsTxt, calendarDatesTxt },
      endpoints,
    );
    assert.strictEqual(sharedNumberCount, 1);
    assert.ok(!('900' in trips), 'single-line number must be excluded');
    assert.deepStrictEqual(trips['800'], [
      { line: 'S5', dep: '07:45', arr: '09:10', dates: [['20260110', '20260112']] },
      { line: 'S53', dep: '07:45', arr: '08:10', dates: [['20260110', '20260112']] },
    ]);
  });

  it('warns when calendar_dates.txt yields no service dates (calendar.txt-only feed)', () => {
    const { trips, warnings } = buildAmbiguousTrips(
      { routesTxt, tripsTxt, calendarDatesTxt: 'service_id,date,exception_type\n' },
      endpoints,
    );
    assert.deepStrictEqual(trips, {});
    assert.ok(warnings.some((w) => w.includes('calendar_dates.txt produced no service dates')));
  });

  it('warns when feed coverage starts after the Fahrplan period begins', () => {
    // Fahrplan 2026 starts 2025-12-14, but these signatures only run from 2026-01-10.
    const { warnings } = buildAmbiguousTrips({ routesTxt, tripsTxt, calendarDatesTxt }, endpoints, {
      fahrplanYear: 2026,
    });
    assert.ok(warnings.some((w) => w.includes('Feed coverage starts 20260110')));
  });

  it('does not warn about coverage when the Fahrplan year is not given', () => {
    const { warnings } = buildAmbiguousTrips({ routesTxt, tripsTxt, calendarDatesTxt }, endpoints);
    assert.ok(!warnings.some((w) => w.includes('Feed coverage starts')));
  });
});
