/**
 * Contract audit over every published cancellation in `docs/<fahrplan-year>/<line>.json`.
 *
 * Fixture tests prove what the code does today; this proves what the published files actually
 * hold, including records written by older code that no reparse reaches (most of the backlog
 * predates the text archive). Each invariant here was violated in committed data before it was
 * pinned:
 * - unpadded clock times ("0:05"), which also gave one trip a second identity;
 * - 26 trips of 14./15.12.2025 filed under Fahrplan year 2025 although 2026 starts 2025-12-14,
 *   four of them duplicated in the 2026 file.
 *
 * Stop-name hygiene is deliberately not asserted here: some pre-archive records carry text two
 * merged rows left behind and have no source left to repair them from. Parser output is held to
 * that standard instead (`archive-corpus.test.ts`), and `archive-store-consistency.test.ts` ties
 * every archive-backed record to it.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { PUBLIC_CAUSE_DEFINITIONS } from '../../src/cause.js';
import { getFahrplanYear } from '../../src/fahrplan.js';
import { getCancellationKey } from '../../src/storage.js';
import type { Cancellation } from '../../src/types.js';

const DOCS_DIR = join(process.cwd(), 'docs');
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CAUSE_IDS = new Set<string>(PUBLIC_CAUSE_DEFINITIONS.map(({ id }) => id));

interface PublishedRecord {
  readonly location: string;
  readonly fahrplanYear: string;
  readonly fileLine: string;
  readonly trip: Cancellation;
}

function loadPublishedRecords(): PublishedRecord[] {
  const records: PublishedRecord[] = [];
  for (const fahrplanYear of readdirSync(DOCS_DIR).filter((name) => /^\d{4}$/.test(name))) {
    const yearDirectory = join(DOCS_DIR, fahrplanYear);
    for (const filename of readdirSync(yearDirectory)) {
      if (!filename.endsWith('.json') || filename === 'index.json') continue;
      const trips = JSON.parse(
        readFileSync(join(yearDirectory, filename), 'utf8'),
      ) as Cancellation[];
      for (const trip of trips) {
        records.push({
          location: `${fahrplanYear}/${filename} ${trip.date} ${trip.trainNumber} ${trip.fromTime}`,
          fahrplanYear,
          fileLine: filename.slice(0, -'.json'.length),
          trip,
        });
      }
    }
  }
  return records;
}

const records = loadPublishedRecords();

/** Asserts no record violates `isViolation`, listing every offender in the failure message. */
function assertNoViolations(
  description: string,
  isViolation: (record: PublishedRecord) => boolean,
) {
  const offenders = records.filter(isViolation).map(({ location }) => location);
  assert.deepStrictEqual(offenders, [], `${offenders.length} record(s) ${description}`);
}

describe('published cancellation contract', () => {
  test('the corpus is not empty', () => {
    assert.ok(records.length > 0);
  });

  test('clock times use the HH:MM form', () => {
    assertNoViolations(
      'have a time outside HH:MM',
      ({ trip }) => !CLOCK_TIME.test(trip.fromTime) || !CLOCK_TIME.test(trip.toTime),
    );
  });

  test('every record lives in its own Fahrplan year and line file', () => {
    assertNoViolations('have a malformed date', ({ trip }) => !ISO_DATE.test(trip.date));
    assertNoViolations(
      'are filed under the wrong Fahrplan year',
      ({ trip, fahrplanYear }) => String(getFahrplanYear(trip.date)) !== fahrplanYear,
    );
    assertNoViolations(
      'are filed under another line',
      ({ trip, fileLine }) => trip.line !== fileLine,
    );
  });

  test('every record carries a published cause with consistent evidence', () => {
    assertNoViolations(
      'have a cause outside the taxonomy',
      ({ trip }) => !CAUSE_IDS.has(trip.cause),
    );
    assertNoViolations(
      "carry keyword evidence for an 'unknown' cause",
      ({ trip }) => trip.cause === 'unknown' && trip.causeKeyword !== null,
    );
  });

  test('core fields are present and trimmed', () => {
    assertNoViolations(
      'have a malformed train number',
      ({ trip }) => !/^\d+$/.test(trip.trainNumber),
    );
    assertNoViolations('have an empty or untrimmed stop name', ({ trip }) =>
      [trip.fromStop, trip.toStop].some((stop) => stop.length === 0 || stop !== stop.trim()),
    );
    assertNoViolations('have no source URL', ({ trip }) => !trip.sourceUrl);
  });

  test('a trip identity appears once per line file', () => {
    const seen = new Set<string>();
    assertNoViolations(
      'duplicate an identity in their file',
      ({ trip, fahrplanYear, fileLine }) => {
        const key = `${fahrplanYear}/${fileLine}|${getCancellationKey(trip)}`;
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      },
    );
  });

  test('a trip identity is filed in one Fahrplan year only', () => {
    const yearsByIdentity = new Map<string, Set<string>>();
    for (const { trip, fahrplanYear, fileLine } of records) {
      const key = `${fileLine}|${getCancellationKey(trip)}`;
      yearsByIdentity.set(key, (yearsByIdentity.get(key) ?? new Set()).add(fahrplanYear));
    }
    const duplicated = [...yearsByIdentity]
      .filter(([, years]) => years.size > 1)
      .map(([key]) => key);
    assert.deepStrictEqual(duplicated, []);
  });
});
