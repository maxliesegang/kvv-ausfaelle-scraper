import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchText } from './rss.js';
import { parseDetailPage } from './parser/index.js';
import {
  createTrainLineObservationRecorder,
  updateTrainLineDefinitionsFromObservations,
} from './train-line-observations.js';
import { normalizeCancellationsForTest } from './utils/test-data.js';

/**
 * Automated script to fetch a KVV article from a URL, parse it, and save as test data.
 * Uses the naming format: article-<id>-<line>
 *
 * Usage:
 *   tsx src/fetch-article.ts <url>
 *   tsx src/fetch-article.ts "https://www.kvv.de/...detailID=Nettro_CMS_257073"
 */

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: tsx src/fetch-article.ts <url>');
  console.error(
    'Example: tsx src/fetch-article.ts "https://www.kvv.de/fahrplan/verkehrsmeldungen.html?tx_ixkvvticker_list%5Baction%5D=detail&tx_ixkvvticker_list%5Bcontroller%5D=Ticker&tx_ixkvvticker_list%5BdetailID%5D=Nettro_CMS_257073"',
  );
  process.exit(1);
}

const url = args[0]!;

/**
 * Extracts the article ID from a KVV detail URL.
 * Supports both URL-encoded and plain query parameters.
 */
function extractArticleId(url: string): string | null {
  // Try to match detailID parameter (both URL-encoded and plain)
  const patterns = [
    /detailID[=%5B%5D]*=([^&]+)/i, // Matches detailID= or detailID%5D= etc.
    /Nettro_CMS_(\d+)/i, // Direct match of the ID format
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      const rawId = match[1] || match[0] || '';
      // Extract just the numeric ID if it's in Nettro_CMS_XXXXX format
      const idMatch = rawId.match(/(\d+)/);
      return idMatch ? idMatch[1] || null : rawId || null;
    }
  }

  return null;
}

/**
 * Normalizes a line identifier for use in filenames.
 * Converts to lowercase and replaces special characters.
 */
function normalizeLineForFilename(line: string): string {
  return line.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

async function main() {
  try {
    // Extract article ID
    const articleId = extractArticleId(url);
    if (!articleId) {
      console.error('Error: Could not extract article ID from URL');
      console.error('URL must contain detailID parameter (e.g., detailID=Nettro_CMS_257073)');
      process.exit(1);
    }

    console.log(`Article ID: ${articleId}`);
    console.log(`Fetching HTML from ${url}...`);

    // Fetch HTML
    const html = await fetchText(url);
    console.log(`✓ Fetched ${html.length} bytes`);

    // Parse it
    console.log('Parsing HTML...');
    const { observations, record } = createTrainLineObservationRecorder();
    const cancellations = parseDetailPage(html, url, {
      onTrainLineObserved: record,
    });
    await updateTrainLineDefinitionsFromObservations(observations);

    if (cancellations.length === 0) {
      console.warn('Warning: No cancellations parsed from HTML!');
      console.warn('The article may not contain trip data, or the format may have changed.');
    } else {
      console.log(`✓ Parsed ${cancellations.length} cancellations`);
    }

    // Extract line(s) from parsed data
    const lines = new Set<string>();
    for (const c of cancellations) {
      lines.add(c.line);
    }

    // Generate filename
    const lineStr = lines.size > 0 ? normalizeLineForFilename([...lines].join('-')) : 'unknown';
    const testName = `article-${articleId}-${lineStr}`;

    console.log(`Test name: ${testName}`);

    // Normalize cancellations (remove sourceUrl and capturedAt for expected output)
    const expectedOutput = normalizeCancellationsForTest(cancellations);

    // Save HTML to test-data/articles/
    const htmlOutputPath = join(process.cwd(), 'test-data', 'articles', `${testName}.html`);
    console.log(`Saving HTML to ${htmlOutputPath}...`);
    writeFileSync(htmlOutputPath, html, 'utf-8');

    // Save expected JSON to test-data/expected/
    const jsonOutputPath = join(process.cwd(), 'test-data', 'expected', `${testName}.json`);
    console.log(`Saving expected JSON to ${jsonOutputPath}...`);
    writeFileSync(jsonOutputPath, JSON.stringify(expectedOutput, null, 2) + '\n', 'utf-8');

    console.log('\n✓ Successfully saved test article!');
    console.log(`\nSummary:`);
    console.log(`  ID: ${articleId}`);
    console.log(`  Lines: ${[...lines].join(', ') || 'UNKNOWN'}`);
    console.log(`  HTML: test-data/articles/${testName}.html`);
    console.log(`  JSON: test-data/expected/${testName}.json`);
    console.log(`  Trips: ${cancellations.length}`);

    // Print first cancellation as sample
    if (cancellations.length > 0) {
      console.log(`\nFirst trip:`);
      console.log(`  Line: ${cancellations[0]!.line}`);
      console.log(`  Train: ${cancellations[0]!.trainNumber}`);
      console.log(
        `  Route: ${cancellations[0]!.fromStop} (${cancellations[0]!.fromTime}) → ${cancellations[0]!.toStop} (${cancellations[0]!.toTime})`,
      );
      console.log(`  Date: ${cancellations[0]!.date}`);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
