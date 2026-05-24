import type { Item } from './types.js';
import { stripHtml } from './parser/text-extraction.js';
import { extractTripLines } from './parser/trip-parsing.js';

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
  readonly tripLineSamples: string[];
  readonly tripLineCount: number;
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
    keywords: ['faellt aus', 'entfaellt', 'verkehrseinstellung', 'verkehrsunterbrechung'],
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

// Plain keyword lists for cause detection — not scored, only used for classification.

const CONSTRUCTION_CAUSE_KEYWORDS: readonly string[] = [
  'wegen bauarbeiten',
  'bauarbeiten',
  'baustelle',
  'baubedingt',
  'baumassnahme',
  'baumassnahmen',
  'gleisbauarbeiten',
  'gleisarbeiten',
  'kanalsanierung',
  'kanalsanierungsarbeiten',
  'sperrung',
];

// Signals that the disruption stems from personnel/operational shortages rather
// than construction. "fahrpersonal" covers phrasing like "Engpässen beim Fahrpersonal".
const PERSONNEL_CAUSE_KEYWORDS: readonly string[] = [
  'personalmangel',
  'personalausfall',
  'krankheitsbedingt',
  'krankheitsausfall',
  'betriebsbedingt',
  'fahrpersonal',
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

function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function matchesAny(text: string, keywords: readonly string[]): string[] {
  return keywords.filter((k) => text.includes(k));
}

/**
 * Returns true when the text signals a construction-caused disruption with no
 * personnel/operational shortage signals. Such notices are not trip cancellations
 * we want to track.
 */
function isConstructionOnlyNotice(text: string): boolean {
  const constructionHits = matchesAny(text, CONSTRUCTION_CAUSE_KEYWORDS);
  if (constructionHits.length === 0) return false;
  const personnelHits = matchesAny(text, PERSONNEL_CAUSE_KEYWORDS);
  return personnelHits.length === 0;
}

// ---------------------------------------------------------------------------
// Core scoring
// ---------------------------------------------------------------------------

interface TextScore {
  readonly score: number;
  readonly keywordMatches: string[];
  readonly structureMatches: string[];
  readonly isConstructionOnly: boolean;
  readonly reasons: string[];
  readonly normalizedText: string;
}

function scoreText(segments: string[]): TextScore {
  const normalizedText = normalizeForSearch(segments.join(' '));
  const reasons: string[] = [];

  const { score: kwScore, matches: keywordMatches } = collectMatches(
    normalizedText,
    CANCELLATION_KEYWORDS,
  );
  const { score: stScore, matches: structureMatches } = collectMatches(
    normalizedText,
    STRUCTURE_MARKERS,
  );

  let score = kwScore + stScore;

  if (keywordMatches.length > 0) reasons.push(`keywords: ${keywordMatches.join(', ')}`);
  if (structureMatches.length > 0) reasons.push(`structure: ${structureMatches.join(', ')}`);

  if (LINE_MENTION_PATTERN.test(normalizedText)) {
    score += 1;
    reasons.push('mentions a line identifier');
  }

  const isConstructionOnly = isConstructionOnlyNotice(normalizedText);
  if (isConstructionOnly) {
    reasons.push('excluded: construction-related notice without personnel shortage signal');
  }

  return { score, keywordMatches, structureMatches, isConstructionOnly, reasons, normalizedText };
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
      tripLineSamples: [],
      tripLineCount: 0,
    };
  }

  const { score, isConstructionOnly, reasons, keywordMatches, structureMatches } =
    scoreText(segments);

  return {
    score,
    isRelevant: score >= RSS_RELEVANCE_THRESHOLD && !isConstructionOnly,
    reasons,
    keywordMatches,
    structureMatches,
    tripLineSamples: [],
    tripLineCount: 0,
  };
}

export function analyzeDetailPage(html: string): RelevanceResult {
  const text = stripHtml(html);
  const {
    score: baseScore,
    isConstructionOnly,
    reasons: baseReasons,
    keywordMatches,
    structureMatches,
  } = scoreText([text]);

  const reasons = [...baseReasons];
  let score = baseScore;

  const tripLike = extractTripLines(text);

  if (tripLike.length > 0) {
    score += 3;
    reasons.push(`found ${tripLike.length} trip-like lines`);
  }

  return {
    score,
    isRelevant: (score >= DETAIL_RELEVANCE_THRESHOLD || tripLike.length > 0) && !isConstructionOnly,
    reasons,
    keywordMatches,
    structureMatches,
    tripLineSamples: tripLike.slice(0, 3),
    tripLineCount: tripLike.length,
  };
}
