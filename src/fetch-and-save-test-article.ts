import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDetailPage } from './parser/index.js';
import {
  createTrainLineObservationRecorder,
  updateTrainLineDefinitionsFromObservations,
} from './train-line-observations.js';

/**
 * Helper script to process a real KVV article HTML file and save it as test data.
 * Reads HTML from /tmp, parses it, and saves both HTML and expected JSON.
 */

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: tsx fetch-and-save-test-article.ts <temp-html-path> <test-name>');
  console.error(
    'Example: tsx fetch-and-save-test-article.ts /tmp/kvv-article.html article-5-real-s5',
  );
  process.exit(1);
}

const [tempHtmlPath, testName] = args;

try {
  // Read the HTML file
  console.log(`Reading HTML from ${tempHtmlPath}...`);
  const html = readFileSync(tempHtmlPath!, 'utf-8');

  // Parse it
  console.log('Parsing HTML...');
  const { observations, record } = createTrainLineObservationRecorder();
  const cancellations = parseDetailPage(html, `https://www.kvv.de/test/${testName}`, {
    onTrainLineObserved: record,
  });

  if (cancellations.length === 0) {
    console.warn('Warning: No cancellations parsed from HTML!');
  } else {
    console.log(`Parsed ${cancellations.length} cancellations`);
  }

  // Normalize cancellations (remove sourceUrl and capturedAt for expected output)
  const expectedOutput = cancellations.map(({ sourceUrl, capturedAt, ...rest }) => rest);

  // Save HTML to test-data/articles/
  const htmlOutputPath = join(process.cwd(), 'test-data', 'articles', `${testName}.html`);
  console.log(`Saving HTML to ${htmlOutputPath}...`);
  writeFileSync(htmlOutputPath, html, 'utf-8');

  // Save expected JSON to test-data/expected/
  const jsonOutputPath = join(process.cwd(), 'test-data', 'expected', `${testName}.json`);
  console.log(`Saving expected JSON to ${jsonOutputPath}...`);
  writeFileSync(jsonOutputPath, JSON.stringify(expectedOutput, null, 2) + '\n', 'utf-8');

  console.log('✓ Successfully saved test article!');
  console.log(`\nSummary:`);
  console.log(`  HTML: ${htmlOutputPath}`);
  console.log(`  JSON: ${jsonOutputPath}`);
  console.log(`  Trips: ${cancellations.length}`);

  await updateTrainLineDefinitionsFromObservations(observations);

  // Print first cancellation as sample
  if (cancellations.length > 0) {
    console.log(`\nFirst trip:`);
    console.log(`  Line: ${cancellations[0]!.line}`);
    console.log(`  Train: ${cancellations[0]!.trainNumber}`);
    console.log(
      `  Route: ${cancellations[0]!.fromStop} (${cancellations[0]!.fromTime}) → ${cancellations[0]!.toStop} (${cancellations[0]!.toTime})`,
    );
  }
} catch (error) {
  console.error('Error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
