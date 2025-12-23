import { DATA_DIR } from './config.js';
import { saveCancellations } from './storage.js';
import { generateSiteIndices } from './siteIndex.js';
import { fetchRelevantItems, collectTrips, type CollectTripsResult } from './workflow.js';

/**
 * Handles parse errors by logging them and exiting with error code.
 * This ensures CI fails while still allowing successful trips to be saved first.
 */
function handleParseErrors(result: CollectTripsResult): void {
  if (result.parseErrors.length === 0) {
    return;
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

  process.exit(1);
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

  if (result.cancellations.length === 0) {
    console.log('No cancellations parsed, nothing to save.');
    // Still (re)generate static index pages so the site reflects current files
    await generateSiteIndices(DATA_DIR);
    handleParseErrors(result);
    return;
  }

  // Write directly into docs/ so GitHub Pages can serve a single source of truth
  await saveCancellations(DATA_DIR, result.cancellations);

  // Update indices after writing files
  await generateSiteIndices(DATA_DIR);

  console.log('Done');

  // Exit with error after saving if there were parse errors
  handleParseErrors(result);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
