import { DATA_DIR } from './config.js';
import { saveCancellations } from './storage.js';
import { generateSiteIndices } from './site-index.js';
import { fetchRelevantItems, collectTrips, type CollectTripsResult } from './workflow.js';

/**
 * Logs parse errors. Returns true if any were present.
 * Reporting is decoupled from exiting so valid data is always saved first and CI
 * fails afterwards (see {@link main}).
 */
function reportParseErrors(result: CollectTripsResult): boolean {
  if (result.parseErrors.length === 0) {
    return false;
  }

  const errorCount = result.parseErrors.length;
  const successCount = result.cancellations.length;

  console.error(`\nParser errors: ${errorCount} article(s) failed to parse`);
  console.error(`Successfully parsed: ${successCount} trip(s)\n`);

  result.parseErrors.forEach((err, index) => {
    console.error(`[Error ${index + 1}/${errorCount}]`);
    console.error(err.message);
    console.error('');
  });

  return true;
}

/**
 * Logs any cancellations whose cause could not be classified. An unknown cause never
 * invalidates the data — it's saved either way — but it signals the keyword lists in
 * `classifyCause` (`src/cause.ts`) need extending. Surfacing it lets CI fail as a
 * notification while the good data is still published. Returns true if any were present.
 */
function reportUnknownCauses(result: CollectTripsResult): boolean {
  const unknown = result.cancellations.filter((c) => c.cause === 'unknown');
  if (unknown.length === 0) {
    return false;
  }

  const sources = [...new Set(unknown.map((c) => c.sourceUrl))];
  console.error(
    `\nUnknown cause: ${unknown.length} cancellation(s) across ${sources.length} article(s) could not be classified.`,
  );
  console.error('Extend the keyword lists in src/cause.ts. Affected articles:');
  sources.forEach((url) => console.error(`  ${url}`));
  console.error('');

  return true;
}

/**
 * Main application entry point.
 * Fetches RSS feed, parses cancellations, saves to JSON, and generates HTML indices.
 */
async function main(): Promise<void> {
  console.log('Fetching RSS…');
  const relevant = await fetchRelevantItems();
  console.log(`Found ${relevant.length} relevant RSS items.`);

  // Fetch details concurrently; tolerate individual failures
  const result = await collectTrips(relevant);

  if (result.cancellations.length > 0) {
    // Write directly into docs/ so GitHub Pages can serve a single source of truth
    await saveCancellations(DATA_DIR, result.cancellations);
  } else {
    console.log('No cancellations parsed, nothing to save.');
  }

  // Always (re)generate static index pages so the site reflects current files
  await generateSiteIndices(DATA_DIR);

  console.log('Done');

  // Surface problems only AFTER persisting data: CI fails loudly (parse regressions, or
  // notices we couldn't classify) while good data is still saved and committed.
  const hadParseErrors = reportParseErrors(result);
  const hadUnknownCauses = reportUnknownCauses(result);
  if (hadParseErrors || hadUnknownCauses) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
