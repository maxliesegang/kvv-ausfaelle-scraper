import type { Item } from './types.js';
import { stripHtml } from './parser/text-extraction.js';
import { buildTripCandidateLines, isValidTripLine } from './parser/trip-parsing.js';

interface KeywordGroup {
  readonly keywords: readonly string[];
  readonly weight: number;
}

interface TextAnalysis {
  readonly score: number;
  readonly keywordMatches: string[];
  readonly structureMatches: string[];
  readonly lineMentioned: boolean;
  readonly reasons: string[];
  readonly normalizedText: string;
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

const TRIP_SECTION_HINTS: readonly KeywordGroup[] = [
  { weight: 1, keywords: ['betroffene fahrten', 'folgende fahrten', 'fahrten betroffen'] },
];

const LINE_MENTION_PATTERN = /\blinie[n]?\s+[a-z]+\d{1,3}\b/;

const RSS_RELEVANCE_THRESHOLD = 2;
const DETAIL_RELEVANCE_THRESHOLD = 3;

function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectMatches(
  text: string,
  groups: readonly KeywordGroup[],
): {
  score: number;
  matches: string[];
} {
  let score = 0;
  const matches = new Set<string>();

  for (const group of groups) {
    const hits = group.keywords.filter((keyword) => text.includes(keyword));
    if (hits.length > 0) {
      score += group.weight;
      hits.forEach((hit) => matches.add(hit));
    }
  }

  return { score, matches: Array.from(matches) };
}

function analyzeTextSegments(segments: string[]): TextAnalysis {
  const normalizedText = normalizeForSearch(segments.join(' '));

  const keywordResult = collectMatches(normalizedText, CANCELLATION_KEYWORDS);
  const structureResult = collectMatches(normalizedText, STRUCTURE_MARKERS);

  const reasons: string[] = [];
  let score = keywordResult.score + structureResult.score;

  if (keywordResult.matches.length > 0) {
    reasons.push(`keywords: ${keywordResult.matches.join(', ')}`);
  }

  if (structureResult.matches.length > 0) {
    reasons.push(`structure: ${structureResult.matches.join(', ')}`);
  }

  const lineMentioned = LINE_MENTION_PATTERN.test(normalizedText);
  if (lineMentioned) {
    score += 1;
    reasons.push('mentions a line identifier');
  }

  return {
    score,
    keywordMatches: keywordResult.matches,
    structureMatches: structureResult.matches,
    lineMentioned,
    reasons,
    normalizedText,
  };
}

export function analyzeRssItem(item: Item): RelevanceResult {
  const segments = [item.title, item.contentSnippet, item.content].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
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

  const analysis = analyzeTextSegments(segments);

  return {
    score: analysis.score,
    isRelevant: analysis.score >= RSS_RELEVANCE_THRESHOLD,
    reasons: analysis.reasons,
    keywordMatches: analysis.keywordMatches,
    structureMatches: analysis.structureMatches,
    tripLineSamples: [],
    tripLineCount: 0,
  };
}

export function analyzeDetailPage(html: string): RelevanceResult {
  const text = stripHtml(html);
  const analysis = analyzeTextSegments([text]);

  const tripCandidates = buildTripCandidateLines(text);
  const tripLike = tripCandidates.filter(isValidTripLine);

  const detailStructure = collectMatches(analysis.normalizedText, TRIP_SECTION_HINTS);
  let score = analysis.score + detailStructure.score;
  const reasons = [...analysis.reasons];

  if (detailStructure.matches.length > 0) {
    reasons.push(`trip section markers: ${detailStructure.matches.join(', ')}`);
  }

  if (tripLike.length > 0) {
    score += 3;
    reasons.push(`found ${tripLike.length} trip-like lines`);
  }

  const isRelevant = score >= DETAIL_RELEVANCE_THRESHOLD || tripLike.length > 0;

  return {
    score,
    isRelevant,
    reasons,
    keywordMatches: analysis.keywordMatches,
    structureMatches: [...analysis.structureMatches, ...detailStructure.matches],
    tripLineSamples: tripLike.slice(0, 3),
    tripLineCount: tripLike.length,
  };
}
