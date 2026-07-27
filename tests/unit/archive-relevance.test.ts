/**
 * Archive-backed regression for the two relevance gates in `processRssItem`.
 *
 * Articles are archived *before* either gate runs (`src/workflow.ts`), precisely so the corpus
 * can audit them: it records what KVV published, independent of what the scraper decided to keep.
 * That makes `docs/<year>/articles/**` a labeled set — an archive that `parseDetailPage` turns
 * into trips is, by definition, a notice the gates must let through. A gate rejecting one is
 * silent data loss: the trips are never stored and nothing fails.
 *
 * The RSS gate scores the feed item. Archives now record the item's title verbatim (`Titel:`),
 * so for those the gate is replayed on its exact production input — the KVV feed carries no
 * `<description>`, making the title the whole of it. Archives written before that header field
 * existed cannot be backfilled (their notices have left the feed), so they fall back to a
 * reconstruction: KVV's ticker title is the headline plus the lead sentence, which are the first
 * two content lines of the archived body. That reconstruction reproduced the real
 * published/dropped outcome for 162 of 164 archives (the two exceptions are trips deduplicated
 * onto an earlier notice's source URL), so it is a faithful stand-in where it is still needed.
 *
 * This corpus caught one real loss: `Nettro_CMS_273185` ("Einzelne Fahrten der Linie S7
 * entfallen …") scored 1 of the required 2 because `CANCELLATION_KEYWORDS` carried `entfaellt`
 * but not the plural `entfallen`, so its two S7 trips were never published. See the pinned case
 * below.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { analyzeDetailPage, analyzeRssItem } from '../../src/relevance.js';
import { parseDetailPage } from '../../src/parser/index.js';
import type { Item } from '../../src/types.js';
import { loadAllArchivedArticles, type ArchivedArticle } from '../helpers/fixture-loader.js';

/** Site chrome the archived `<main>` region carries above the headline. */
const CHROME_LINE = /^(KVV|Fahrplan|Verkehrsmeldungen)$/;
/** Validity/Stand line ("Vom 22.09.2025 bis …", "27.07.2026, 02:09 Uhr") — not part of the item. */
const VALIDITY_LINE = /^(Vom |Ab |\d{2}\.\d{2}\.\d{4})/;
/** Affected-line header ("Linie 71", "Linien: 22") — metadata, not the headline. */
const LINE_HEADER_LINE = /^Linien?:?\s+[\dA-Za-z][\dA-Za-z, /]*$/;

/**
 * The RSS item an archived article was judged by: the recorded title when the archive carries
 * one, otherwise KVV's ticker shape rebuilt from the body — headline as title, lead sentence as
 * snippet. Scoring joins the fields, so the two shapes score identically for the same wording.
 */
function toRssItem(article: ArchivedArticle): Item {
  const { body, url, rssTitle } = article;
  if (rssTitle) {
    return { title: rssTitle, link: url };
  }

  const contentLines = body
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !CHROME_LINE.test(line) &&
        !VALIDITY_LINE.test(line) &&
        !LINE_HEADER_LINE.test(line),
    );

  return { title: contentLines[0] ?? '', contentSnippet: contentLines[1] ?? '', link: url };
}

interface GatedArticle {
  readonly article: ArchivedArticle;
  readonly item: Item;
  readonly rssRelevant: boolean;
  readonly detailRelevant: boolean;
  readonly rssScore: number;
  /** Trips the parser recovers from the archived body — the ground-truth "is a cancellation". */
  readonly tripCount: number;
}

const gatedArticles: GatedArticle[] = loadAllArchivedArticles().map((article) => {
  const item = toRssItem(article);
  const rss = analyzeRssItem(item);

  let tripCount = 0;
  try {
    tripCount = parseDetailPage(article.body, article.url).length;
  } catch {
    // An unparsable archive carries no ground truth either way; it is simply not a positive.
  }

  return {
    article,
    item,
    rssRelevant: rss.isRelevant,
    detailRelevant: analyzeDetailPage(article.body).isRelevant,
    rssScore: rss.score,
    tripCount,
  };
});

const parseableArticles = gatedArticles.filter(({ tripCount }) => tripCount > 0);

function describeRejection({ article, item, rssScore }: GatedArticle): string {
  return `${article.filePath}: RSS score ${rssScore} for "${item.title}" / "${item.contentSnippet}"`;
}

describe('archived articles vs the relevance gates', () => {
  test('audits the whole committed archive corpus', () => {
    assert.ok(
      gatedArticles.length >= 150,
      `expected at least 150 archived articles, found ${gatedArticles.length}`,
    );
    assert.ok(
      parseableArticles.length >= 60,
      `expected at least 60 archives to parse into trips, found ${parseableArticles.length}`,
    );
  });

  test('the RSS gate keeps every archived notice that parses into trips', () => {
    const rejected = parseableArticles
      .filter(({ rssRelevant }) => !rssRelevant)
      .map(describeRejection);

    assert.deepEqual(
      rejected,
      [],
      'an archive that parses into trips was dropped at the RSS gate — those cancellations are never published',
    );
  });

  test('the detail gate keeps every archived notice that parses into trips', () => {
    const rejected = parseableArticles
      .filter(({ detailRelevant }) => !detailRelevant)
      .map(({ article }) => article.filePath);

    assert.deepEqual(rejected, []);
  });

  test('plural "entfallen" phrasing stays relevant (Nettro_CMS_273185 regression)', () => {
    const lostNotice = gatedArticles.find(({ article }) => article.id === 'Nettro_CMS_273185');
    assert.ok(lostNotice, 'expected the archived S7 notice to still be committed');

    // The exact wording that scored below threshold: the headline names no cancellation term at
    // all, so the plural verb is the only cancellation signal there is. Asserted over the joined
    // item text, because the item is the recorded title once this archive is re-fetched and a
    // reconstruction until then — the wording is what matters, not which field carries it.
    const scoredText = [lostNotice.item.title, lostNotice.item.contentSnippet]
      .filter(Boolean)
      .join(' ');
    assert.match(scoredText, /Abweichungen im Betriebsablauf/);
    assert.match(scoredText, /Fahrten der Linie S7 entfallen/);
    assert.equal(lostNotice.tripCount, 2);
    assert.ok(
      lostNotice.rssRelevant,
      `notice must pass the RSS gate, scored ${lostNotice.rssScore}`,
    );
  });

  test('the gates still reject the bulk of archived non-cancellation notices', () => {
    // Precision guard, the counterweight to the recall assertions above: most archived notices
    // are stop relocations, diversions and event timetables that yield no trips, and at least one
    // gate must keep rejecting them. Widening a keyword until everything passes trips this.
    const withoutTrips = gatedArticles.filter(({ tripCount }) => tripCount === 0);
    const rejected = withoutTrips.filter(
      ({ rssRelevant, detailRelevant }) => !rssRelevant || !detailRelevant,
    );

    assert.ok(
      rejected.length > 0.7 * withoutTrips.length,
      `expected the gates to reject most trip-less notices, got ${rejected.length}/${withoutTrips.length}`,
    );
  });
});
