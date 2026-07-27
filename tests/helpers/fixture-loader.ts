/**
 * Utilities for loading test fixtures (HTML files and expected JSON).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Cancellation } from '../../src/types.js';
import { parseArchive } from '../../src/article-archive.js';

const TEST_DATA_DIR = join(process.cwd(), 'test-data');
const ARTICLES_DIR = join(TEST_DATA_DIR, 'articles');
const EXPECTED_DIR = join(TEST_DATA_DIR, 'expected');
const DOCS_DIR = join(process.cwd(), 'docs');

export interface TestFixture {
  readonly name: string;
  readonly html: string;
  readonly expected: Partial<Cancellation>[];
  readonly htmlPath: string;
  readonly expectedPath: string;
}

export interface ArchivedArticle {
  readonly id: string;
  readonly year: string;
  readonly body: string;
  readonly url: string;
  readonly filePath: string;
  /** Recorded RSS title, absent for archives written before the header carried it. */
  readonly rssTitle: string | undefined;
  /** Recorded RSS publication date (ISO), absent under the same condition. */
  readonly rssPublishedIso: string | undefined;
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
 * Loads one committed, byte-stable article archive as parser input.
 *
 * Archive-backed regressions can use the real notice without duplicating it under test-data/.
 * The source URL is required because a missing archive header would weaken source identity tests.
 */
export function loadArchivedArticle(year: string, id: string): ArchivedArticle {
  const filePath = join(DOCS_DIR, year, 'articles', `${id}.txt`);
  const { body, url, rssTitle, rssPublishedIso } = parseArchive(readFileSync(filePath, 'utf-8'));

  if (!url) {
    throw new Error(`Archived article ${id} has no source URL: ${filePath}`);
  }

  return { id, year, body, url, filePath, rssTitle, rssPublishedIso };
}

/**
 * Loads every committed article archive across all Fahrplan year folders.
 *
 * Corpus-wide audits (classification, parser coverage) run against the real published record
 * rather than a hand-picked fixture set, so a wording KVV actually used cannot regress unnoticed.
 * Returned in a stable order (year, then id) so failures are reproducible.
 */
export function loadAllArchivedArticles(): ArchivedArticle[] {
  const articles: ArchivedArticle[] = [];

  for (const year of readdirSync(DOCS_DIR).sort()) {
    if (!/^\d{4}$/.test(year)) {
      continue;
    }

    const articlesDirectory = join(DOCS_DIR, year, 'articles');
    if (!existsSync(articlesDirectory)) {
      continue;
    }

    for (const filename of readdirSync(articlesDirectory).sort()) {
      if (filename.endsWith('.txt')) {
        articles.push(loadArchivedArticle(year, basename(filename, '.txt')));
      }
    }
  }

  return articles;
}
