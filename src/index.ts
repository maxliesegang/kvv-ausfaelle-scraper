import type { Cancellation } from './types.js';
import { DATA_DIR } from './config.js';
import { saveCancellations } from './storage.js';
import { generateSiteIndices } from './siteIndex.js';
import { fetchRelevantItems, collectTrips } from './workflow.js';

/**
 * Main application entry point.
 * Fetches RSS feed, parses cancellations, saves to JSON, and generates HTML indices.
 */
async function main(): Promise<void> {
  console.log('Fetching RSS…');
  const relevant = await fetchRelevantItems();
  console.log(`Found ${relevant.length} relevant RSS items.`);

  // Fetch details concurrently; tolerate individual failures
  const allTrips: Cancellation[] = await collectTrips(relevant);

  if (allTrips.length === 0) {
    console.log('No cancellations parsed, nothing to save.');
    // Still (re)generate static index pages so the site reflects current files
    await generateSiteIndices(DATA_DIR);
    return;
  }

  // Write directly into docs/ so GitHub Pages can serve a single source of truth
  await saveCancellations(DATA_DIR, allTrips);

  // Update indices after writing files
  await generateSiteIndices(DATA_DIR);

  console.log('✓ Done');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
