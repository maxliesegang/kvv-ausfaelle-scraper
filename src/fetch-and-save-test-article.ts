import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDetailPage } from './parser.js';

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
  const observedTrainLines = new Map<string, Set<string>>();
  const cancellations = parseDetailPage(html, `https://www.kvv.de/test/${testName}`, {
    onTrainLineObserved: (line, trainNumber) => {
      if (!observedTrainLines.has(line)) {
        observedTrainLines.set(line, new Set());
      }
      observedTrainLines.get(line)!.add(trainNumber);
    },
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

  updateTrainLineDefinitionsFromObservations(observedTrainLines);

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

const TRAIN_LINE_DATA_DIR = join(process.cwd(), 'src', 'train-line-definitions', 'data');

function slugifyLineId(line: string): string {
  return line
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function updateTrainLineDefinitionsFromObservations(observations: Map<string, Set<string>>): void {
  if (observations.size === 0) {
    return;
  }

  if (!existsSync(TRAIN_LINE_DATA_DIR)) {
    mkdirSync(TRAIN_LINE_DATA_DIR, { recursive: true });
  }

  for (const [line, trainNumbers] of observations) {
    if (trainNumbers.size === 0) continue;

    const slug = slugifyLineId(line);
    if (!slug) continue;

    const filePath = join(TRAIN_LINE_DATA_DIR, `${slug}.json`);
    let existing: { line: string; trainNumbers: string[] } = { line, trainNumbers: [] };

    if (existsSync(filePath)) {
      try {
        existing = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch (error) {
        console.warn(`⚠️  Failed to read ${filePath}:`, error);
        continue;
      }
    }

    if (existing.line && existing.line !== line) {
      console.warn(
        `⚠️  Skipping train line update for ${line} because ${filePath} already defines ${existing.line}`,
      );
      continue;
    }

    const merged = new Set(existing.trainNumbers ?? []);
    const newlyAdded: string[] = [];
    for (const trainNumber of trainNumbers) {
      if (!merged.has(trainNumber)) {
        merged.add(trainNumber);
        newlyAdded.push(trainNumber);
      }
    }

    if (newlyAdded.length === 0) {
      continue;
    }

    const updated = {
      line,
      trainNumbers: Array.from(merged).sort((a, b) => a.localeCompare(b, 'de', { numeric: true })),
    };

    writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    console.log(`  ↳ Added ${newlyAdded.join(', ')} to train-line mapping (${line} → ${filePath})`);
  }
}
