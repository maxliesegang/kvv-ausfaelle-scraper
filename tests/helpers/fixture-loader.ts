/**
 * Utilities for loading test fixtures (HTML files and expected JSON).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Cancellation } from '../../src/types.js';

const TEST_DATA_DIR = join(process.cwd(), 'test-data');
const ARTICLES_DIR = join(TEST_DATA_DIR, 'articles');
const EXPECTED_DIR = join(TEST_DATA_DIR, 'expected');

export interface TestFixture {
  readonly name: string;
  readonly html: string;
  readonly expected: Partial<Cancellation>[];
  readonly htmlPath: string;
  readonly expectedPath: string;
}

/**
 * Loads a single test fixture by name.
 */
export function loadFixture(articleName: string): TestFixture {
  const htmlPath = join(ARTICLES_DIR, `${articleName}.html`);
  const expectedPath = join(EXPECTED_DIR, `${articleName}.json`);

  const html = readFileSync(htmlPath, 'utf-8');
  const expected = JSON.parse(readFileSync(expectedPath, 'utf-8')) as Partial<Cancellation>[];

  return {
    name: articleName,
    html,
    expected,
    htmlPath,
    expectedPath,
  };
}

/**
 * Loads all test fixtures from the test-data directory.
 */
export function loadAllFixtures(): TestFixture[] {
  const articleFiles = readdirSync(ARTICLES_DIR).filter((f) => f.endsWith('.html'));

  return articleFiles.map((file) => {
    const articleName = basename(file, '.html');
    return loadFixture(articleName);
  });
}

/**
 * Gets the path to the test-data directory.
 */
export function getTestDataDir(): string {
  return TEST_DATA_DIR;
}

/**
 * Gets the path to the articles directory.
 */
export function getArticlesDir(): string {
  return ARTICLES_DIR;
}

/**
 * Gets the path to the expected directory.
 */
export function getExpectedDir(): string {
  return EXPECTED_DIR;
}
