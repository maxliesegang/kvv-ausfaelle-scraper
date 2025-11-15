import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseDetailPage } from './parser/index.js';
import type { Cancellation } from './types.js';

/** ANSI color codes for terminal output */
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
} as const;

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly errors: string[];
}

/**
 * Normalizes a cancellation object for comparison by removing dynamic fields.
 */
function normalizeCancellation(
  cancellation: Cancellation,
): Omit<Cancellation, 'sourceUrl' | 'capturedAt'> {
  const { sourceUrl, capturedAt, ...rest } = cancellation;
  return rest;
}

/**
 * Compares two cancellation objects for equality.
 */
function compareCancellations(actual: Cancellation, expected: Partial<Cancellation>): string[] {
  const errors: string[] = [];
  const normalized = normalizeCancellation(actual);

  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = normalized[key as keyof typeof normalized];
    if (actualValue !== expectedValue) {
      errors.push(`  ${key}: expected "${expectedValue}", got "${actualValue}"`);
    }
  }

  return errors;
}

/**
 * Tests a single article HTML file against its expected output.
 */
function testArticle(articlePath: string, expectedPath: string): TestResult {
  const name = basename(articlePath, '.html');
  const errors: string[] = [];

  try {
    // Read files
    const html = readFileSync(articlePath, 'utf-8');
    const expectedJson = readFileSync(expectedPath, 'utf-8');
    const expected: Partial<Cancellation>[] = JSON.parse(expectedJson);

    // Parse HTML
    const actual = parseDetailPage(html, 'test://test-url');

    // Compare counts
    if (actual.length !== expected.length) {
      errors.push(`Trip count mismatch: expected ${expected.length}, got ${actual.length}`);
    }

    // Compare each trip
    const minLength = Math.min(actual.length, expected.length);
    for (let i = 0; i < minLength; i++) {
      const tripErrors = compareCancellations(actual[i]!, expected[i]!);
      if (tripErrors.length > 0) {
        errors.push(`Trip ${i + 1} differences:`, ...tripErrors);
      }
    }

    return { name, passed: errors.length === 0, errors };
  } catch (error) {
    return {
      name,
      passed: false,
      errors: [`Test execution failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/**
 * Ensures parser fails loudly when no trips can be extracted.
 */
function testThrowsWhenNoTrips(): TestResult {
  const name = 'throws-when-no-trips';
  const html = `
    <html>
      <body>
        <p>Linie S1</p>
        <p>Nach aktuellem Stand 15.05.2024 12:00:00</p>
        <p>Betroffene Fahrten:</p>
        <p>keine konkreten Angaben</p>
      </body>
    </html>
  `;

  try {
    parseDetailPage(html, 'test://no-trips');
    return {
      name,
      passed: false,
      errors: ['Expected parser to throw when no trips are found, but it returned successfully'],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Incorrect parse')) {
      return {
        name,
        passed: false,
        errors: [`Expected "Incorrect parse" error, got: ${message}`],
      };
    }

    return { name, passed: true, errors: [] };
  }
}

/**
 * Runs all tests and reports results.
 */
function runTests(): void {
  const testDataDir = join(process.cwd(), 'test-data');
  const articlesDir = join(testDataDir, 'articles');
  const expectedDir = join(testDataDir, 'expected');

  console.log(`${colors.blue}Running parser tests...${colors.reset}\n`);

  // Get all HTML files
  const articleFiles = readdirSync(articlesDir).filter((f) => f.endsWith('.html'));

  if (articleFiles.length === 0) {
    console.log(`${colors.yellow}No test articles found in ${articlesDir}${colors.reset}`);
    return;
  }

  const results: TestResult[] = [];

  const noTripResult = testThrowsWhenNoTrips();
  results.push(noTripResult);
  if (noTripResult.passed) {
    console.log(`${colors.green}✓${colors.reset} ${noTripResult.name}`);
  } else {
    console.log(`${colors.red}✗${colors.reset} ${noTripResult.name}`);
    for (const error of noTripResult.errors) {
      console.log(`  ${colors.gray}${error}${colors.reset}`);
    }
  }

  // Run tests
  for (const articleFile of articleFiles) {
    const articlePath = join(articlesDir, articleFile);
    const expectedFile = articleFile.replace('.html', '.json');
    const expectedPath = join(expectedDir, expectedFile);

    const result = testArticle(articlePath, expectedPath);
    results.push(result);

    // Print result
    if (result.passed) {
      console.log(`${colors.green}✓${colors.reset} ${result.name}`);
    } else {
      console.log(`${colors.red}✗${colors.reset} ${result.name}`);
      for (const error of result.errors) {
        console.log(`  ${colors.gray}${error}${colors.reset}`);
      }
    }
  }

  // Print summary
  console.log();
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  if (failed === 0) {
    console.log(`${colors.green}All tests passed!${colors.reset} (${passed}/${total})`);
  } else {
    console.log(
      `${colors.red}${failed} test(s) failed${colors.reset}, ${colors.green}${passed} passed${colors.reset} (${total} total)`,
    );
    process.exit(1);
  }

  // Print coverage summary
  console.log(`\n${colors.blue}Coverage:${colors.reset}`);
  const formats = new Set<string>();
  for (const result of results) {
    if (result.name.includes('old-format')) formats.add('Old format');
    if (result.name.includes('new-format')) formats.add('New format');
    if (result.name.includes('mixed-format')) formats.add('Mixed format');
    if (result.name.includes('alternative-marker')) formats.add('Alternative marker');
  }
  for (const format of formats) {
    console.log(`  - ${format}`);
  }
}

// Run tests if this file is executed directly
runTests();
