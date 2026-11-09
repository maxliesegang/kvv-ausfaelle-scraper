/**
 * Archive/store consistency audit: every Fahrplan year's stored trips must be reproducible from
 * its text archive with the current parser, train-line definitions and cause classifier.
 *
 * The live scraper only (re)parses articles that are still in the RSS feed. A fix that lands
 * after a notice has left the feed — a train-number override, a new trip format, a classifier
 * keyword — therefore never reaches that notice's stored trips, and nothing fails. That is not
 * hypothetical: the S8 override for `Nettro_CMS_279494` (commit 2ed7227e) fixed the failing runs,
 * but the five trips it made parseable were never stored, because the article had already gone.
 *
 * This audit closes that gap. It plans exactly what `npm run reparse-archives -- --write-trips`
 * would change and fails while that plan is non-empty, so the fix and its backfill land together.
 * Because it reads `docs/`, it also catches the live and offline pipelines drifting apart.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { formatTrip, planYearTripReconciliation } from '../../scripts/reparse-archives.js';
import { listFahrplanYearDirectories } from '../../src/fahrplan.js';
import { DATA_DIR } from '../../src/config.js';

const fahrplanYearDirectories = await listFahrplanYearDirectories(DATA_DIR);

describe('archive/store consistency', () => {
  for (const fahrplanYear of fahrplanYearDirectories) {
    test(`stored trips of Fahrplan year ${fahrplanYear} are reproducible from its archive`, async () => {
      const reconciliation = await planYearTripReconciliation(join(DATA_DIR, fahrplanYear), {
        nowMs: Date.now(),
      });

      const differences = [...reconciliation.changesByLine].flatMap(
        ([line, { restored, corrected, removed }]) => [
          ...restored.map((trip) => `${line}: + ${formatTrip(trip)}`),
          ...corrected.map(({ reconciled }) => `${line}: ~ ${formatTrip(reconciled)}`),
          ...removed.map((trip) => `${line}: - ${formatTrip(trip)}`),
        ],
      );

      assert.deepStrictEqual(
        differences,
        [],
        `Stored data diverges from what the archive reparses to. Review with ` +
          `\`npm run reparse-archives -- --year=${fahrplanYear} --verbose\`, then apply with ` +
          `\`--write-trips\` (run \`--write-dates\` first if dates changed).`,
      );
    });
  }
});
