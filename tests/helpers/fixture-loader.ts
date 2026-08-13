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
const PINNED_ARCHIVES_DIR = join(TEST_DATA_DIR, 'archives');
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
 * Loads an article for a regression that asserts specific trip rows, preferring a **pinned** copy
 * under `test-data/archives/` and falling back to the live archive under `docs/`.
 *
 * `docs/` is mutable: KVV rewrites a notice in place, dropping rows as they depart, so a
 * regression written against today's roster can go red tomorrow with no code change — which is
 * exactly what happened to `Nettro_CMS_274370` when the 12:58 rewrite removed the morning runs
 * this suite pins. A regression that names train numbers therefore needs a frozen copy of the
 * revision it was written against.
 *
 * Pin an article by copying the revision under test out of the archive's git history:
 * `git show <commit>:docs/<year>/articles/<id>.txt > test-data/archives/<id>.txt`.
 *
 * Corpus-wide audits keep reading `docs/` through {@link loadAllArchivedArticles} — those assert
 * properties that must hold for whatever KVV publishes, so they *should* track the live record.
 */
export function loadRegressionArticle(year: string, id: string): ArchivedArticle {
  const pinnedPath = join(PINNED_ARCHIVES_DIR, `${id}.txt`);
  if (!existsSync(pinnedPath)) return loadArchivedArticle(year, id);

  const { body, url, rssTitle, rssPublishedIso } = parseArchive(readFileSync(pinnedPath, 'utf-8'));
  if (!url) {
    throw new Error(`Pinned article ${id} has no source URL: ${pinnedPath}`);
  }
  return { id, year, body, url, filePath: pinnedPath, rssTitle, rssPublishedIso };
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
