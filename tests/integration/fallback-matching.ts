#!/usr/bin/env tsx
/**
 * Integration test for train line fallback matching.
 *
 * WARNING: This test will modify train line definition files!
 * Only run this test if you want to test the actual fallback behavior.
 *
 * Usage:
 *   tsx tests/integration/fallback-matching.test.ts <trainNumber>
 *   OR
 *   npm run test:fallback <trainNumber>
 *
 * Example:
 *   npm run test:fallback 10004
 */

import { lookupLineForTrain } from '../../src/train-lines.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCurrentFahrplanYear } from '../../src/fahrplan.js';

const trainNumber = process.argv[2];

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
} as const;

function printHeader(text: string): void {
  console.log(`\n${colors.blue}${text}${colors.reset}`);
}

function printSuccess(text: string): void {
  console.log(`${colors.green}✓${colors.reset} ${text}`);
}

function printError(text: string): void {
  console.log(`${colors.red}✗${colors.reset} ${text}`);
}

function printWarning(text: string): void {
  console.log(`${colors.yellow}⚠${colors.reset} ${text}`);
}

function printInfo(text: string): void {
  console.log(`ℹ️  ${text}`);
}

if (!trainNumber) {
  printError('Please provide a train number');
  console.log('\nUsage: npm run test:fallback <trainNumber>');
  console.log('Example: npm run test:fallback 10004');
  process.exit(1);
}

printHeader(`Testing fallback matching for train number: ${trainNumber}`);

try {
  const result = lookupLineForTrain(trainNumber);

  if (result) {
    printSuccess('Exact match found!');
    console.log(`   Train number: ${trainNumber}`);
    console.log(`   Line: ${result}`);
    console.log();
    printInfo('This train number already exists in the definitions.');
    printInfo('No fallback matching was triggered.');
  }
} catch (error: any) {
  printWarning('Fallback matching triggered!');
  console.log();
  console.log('Error message:');
  console.log('━'.repeat(60));
  console.log(error.message);
  console.log('━'.repeat(60));
  console.log();

  // Extract the line from the error message
  const lineMatch = error.message.match(/Selected line: (\w+)/);
  if (lineMatch) {
    const line = lineMatch[1];
    const year = getCurrentFahrplanYear();

    if (year) {
      const filePath = join(
        process.cwd(),
        'docs',
        String(year),
        'train-line-definitions',
        `${line.toLowerCase()}.json`,
      );

      try {
        const fileContent = readFileSync(filePath, 'utf-8');
        const definition = JSON.parse(fileContent);

        printHeader('Updated definition file:');
        console.log(`   File: ${filePath}`);
        console.log(`   Line: ${definition.line}`);
        console.log(`   Total train numbers: ${definition.trainNumbers.length}`);
        console.log();

        // Find the newly added train number
        const index = definition.trainNumbers.indexOf(trainNumber);
        if (index !== -1) {
          const start = Math.max(0, index - 2);
          const end = Math.min(definition.trainNumbers.length, index + 3);
          const snippet = definition.trainNumbers.slice(start, end);

          console.log('   Train numbers around the new entry:');
          snippet.forEach((num: string, i: number) => {
            const actualIndex = start + i;
            const isNew = num === trainNumber;
            const marker = isNew ? '→' : ' ';
            console.log(`   ${marker} [${actualIndex}] ${num} ${isNew ? '← NEW' : ''}`);
          });
        }

        console.log();
        printSuccess('Train number successfully added to definition file');
        console.log('   Please review and verify the match is correct.');
      } catch (readError) {
        printError(`Error reading updated definition file: ${readError}`);
      }
    }
  }

  printHeader('Next steps:');
  console.log('   1. Review the matched train numbers');
  console.log('   2. Verify the selected line is correct');
  console.log('   3. Check the updated definition file');
  console.log('   4. If correct: commit the changes');
  console.log('   5. If incorrect: revert and manually update definitions');
  console.log();

  // Exit with error code to signal the fallback was triggered
  process.exit(1);
}
