import type { Item } from './types.js';
import { extractArticleRegion, stripHtml } from './parser/text-extraction.js';
import { extractTripRows } from './parser/trip-parsing.js';
import { normalizeGermanText } from './utils/normalization.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KeywordGroup {
  readonly keywords: readonly string[];
  readonly weight: number;
}

export interface RelevanceResult {
  readonly score: number;
  readonly isRelevant: boolean;
  readonly reasons: string[];
  readonly keywordMatches: string[];
  readonly structureMatches: string[];
  readonly tripRowSamples: string[];
  readonly tripRowCount: number;
}

// ---------------------------------------------------------------------------
// Keyword definitions
// ---------------------------------------------------------------------------

const CANCELLATION_KEYWORDS: readonly KeywordGroup[] = [
  {
    weight: 3,
    keywords: [
      'betriebsbedingter ausfall',
      'betriebsbedingte ausfaelle',
      'betriebsbedingte fahrtausfaelle',
      'fahrtausfall',
      'fahrtausfaelle',
      'zugausfall',
      'zugausfaelle',
    ],
  },
  {
    weight: 2,
    // `entfallen` is the plural KVV uses whenever a notice lists several trips ("Einzelne
    // Fahrten der Linie S7 entfallen zwischen …"). It is not a superstring of `entfaellt`, so
    // without it such a notice scored below RSS_RELEVANCE_THRESHOLD on title + snippet alone and
    // was dropped before parsing — see the archive-backed regression in
    // tests/unit/archive-relevance.test.ts.
    keywords: [
      'faellt aus',
      'entfaellt',
      'entfallen',
      'verkehrseinstellung',
      'verkehrsunterbrechung',
    ],
  },
  {
    weight: 1,
    keywords: [
      'ausfall',
      'ausfaelle',
      'ersatzverkehr',
      'schienenersatzverkehr',
      'verkehrseinschraenkung',
      'stoerung im betriebsablauf',
    ],
  },
];

const STRUCTURE_MARKERS: readonly KeywordGroup[] = [
  {
    weight: 2,
    keywords: [
      'betroffene fahrten',
      'folgende fahrten',
      'fahrten betroffen',
      'fahrten von einem teil-ausfall betroffen',
      'teil-ausfall',
      'sind betroffen',
      'entfallen fahrten',
    ],
  },
];

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const RSS_RELEVANCE_THRESHOLD = 2;
const DETAIL_RELEVANCE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LINE_MENTION_PATTERN = /\blinie[n]?\s+[a-z]+\d{1,3}\b/;

function collectMatches(
  text: string,
  groups: readonly KeywordGroup[],
): { score: number; matches: string[] } {
  let score = 0;
  const matches = new Set<string>();
  for (const group of groups) {
    const hits = group.keywords.filter((k) => text.includes(k));
    if (hits.length > 0) {
      score += group.weight;
      hits.forEach((h) => matches.add(h));
    }
  }
  return { score, matches: Array.from(matches) };
}

// ---------------------------------------------------------------------------
// Core scoring
// ---------------------------------------------------------------------------

interface TextScore {
  readonly score: number;
  readonly keywordMatches: string[];
  readonly structureMatches: string[];
  readonly reasons: string[];
}

function scoreText(segments: string[]): TextScore {
  const normalizedText = normalizeGermanText(segments.join(' '));
  const reasons: string[] = [];

  const { score: keywordScore, matches: keywordMatches } = collectMatches(
    normalizedText,
    CANCELLATION_KEYWORDS,
  );
  const { score: structureScore, matches: structureMatches } = collectMatches(
    normalizedText,
    STRUCTURE_MARKERS,
  );

  let score = keywordScore + structureScore;

  if (keywordMatches.length > 0) reasons.push(`keywords: ${keywordMatches.join(', ')}`);
  if (structureMatches.length > 0) reasons.push(`structure: ${structureMatches.join(', ')}`);

  if (LINE_MENTION_PATTERN.test(normalizedText)) {
    score += 1;
    reasons.push('mentions a line identifier');
  }

  return { score, keywordMatches, structureMatches, reasons };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function analyzeRssItem(item: Item): RelevanceResult {
  const segments = [item.title, item.contentSnippet, item.content].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );

  if (segments.length === 0) {
    return {
      score: 0,
      isRelevant: false,
      reasons: ['empty RSS item'],
      keywordMatches: [],
      structureMatches: [],
      tripRowSamples: [],
      tripRowCount: 0,
    };
  }

  const { score, reasons, keywordMatches, structureMatches } = scoreText(segments);

  return {
    score,
    isRelevant: score >= RSS_RELEVANCE_THRESHOLD,
    reasons,
    keywordMatches,
    structureMatches,
    tripRowSamples: [],
    tripRowCount: 0,
  };
}

export function analyzeDetailPage(html: string): RelevanceResult {
  // Score the notice, not the site around it: the shared article region keeps KVV's navigation
  // and footer from contributing keywords, exactly as the parser and the archive do.
  const text = stripHtml(extractArticleRegion(html));
  const {
    score: baseScore,
    reasons: baseReasons,
    keywordMatches,
    structureMatches,
  } = scoreText([text]);

  const reasons = [...baseReasons];
  let score = baseScore;

  const tripLikeRows = extractTripRows(text);

  if (tripLikeRows.length > 0) {
    score += 3;
    reasons.push(`found ${tripLikeRows.length} trip-like rows`);
  }

  return {
    score,
    isRelevant: score >= DETAIL_RELEVANCE_THRESHOLD || tripLikeRows.length > 0,
    reasons,
    keywordMatches,
    structureMatches,
    tripRowSamples: tripLikeRows.slice(0, 3),
    tripRowCount: tripLikeRows.length,
  };
}
