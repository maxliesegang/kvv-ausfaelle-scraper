/**
 * Archives the readable body text of each fetched detail page.
 *
 * Motivation: the structured JSON only keeps the trips we could parse. To keep a full,
 * auditable record of what KVV actually published — and how it changed — we also dump the
 * plain-text body of every old-enough linked RSS article we fetch to
 * `<baseDir>/<year>/articles/<id>.txt`.
 *
 * Because `docs/` is committed on every run, a *stable* filename (the article's KVV
 * `detailID`) plus *stable* file content turns git history into a timeline of KVV's
 * in-place edits: an unchanged article yields a byte-identical file and no commit diff,
 * while a real edit is the only thing that shows up. To preserve that property the file
 * deliberately omits any per-run value (e.g. a "captured at" timestamp) — the article's own
 * "Stand" line already lives in the body, and the header carries only the source URL and,
 * when the page states one, its parsed Stand.
 */

import { join } from 'node:path';
import { ISO_DATE_LENGTH } from './utils/constants.js';
import { writeTextFile } from './utils/fs.js';
import { getCurrentFahrplanYear, getFahrplanYear } from './fahrplan.js';
import { extractArticleRegion, extractStand, stripHtml } from './parser/text-extraction.js';
import { extractDetailId } from './utils/normalization.js';

/** Subdirectory (under `<baseDir>/<year>/`) that holds the per-article text archive. */
export const ARCHIVE_SUBDIR = 'articles';

/** Header field labels. Kept as constants so writing and reading stay in lock-step. */
const HEADER_QUELLE = 'Quelle: ';
const HEADER_STAND = 'Stand:  ';
const HEADER_TITEL = 'Titel:  ';
const HEADER_DATUM = 'Datum:  ';

/** Written for a header field the feed item did not supply. */
const HEADER_UNKNOWN = 'unbekannt';

/** Rule under the header, separating metadata from the archived body. */
const HEADER_RULE = '='.repeat(72);

/**
 * Reduces a detail page to the clean, readable body we archive: the article region only
 * (see {@link extractArticleRegion}), stripped to text and de-indented.
 *
 * Scoping to `<main>` keeps the archive to the notice itself — without it the file would
 * carry the site's navigation and footer, and a site-wide chrome change would diff *every*
 * archived article at once, destroying the "only real edits show up" property. It is the same
 * scoping the parser applies, so an archived body replays exactly like the live page did.
 */
function toArchiveBody(html: string): string {
  return stripHtml(extractArticleRegion(html))
    .replace(/^[ \t]+/gm, '') // drop source indentation so lines read cleanly
    .replace(/\n{2,}/g, '\n') // collapse the blank lines that de-indenting can open up
    .trim();
}

/**
 * Reduces an arbitrary string to a filesystem-safe slug: only `A-Za-z0-9_-`, no leading or
 * trailing separators, capped at 120 chars. Guards the archive path against stray characters
 * in a `detailID` or URL ever escaping the intended directory.
 */
function toSafeSlug(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

/**
 * Stable filesystem name for an article. Prefers its KVV `detailID` (a stable per-article
 * identifier), falling back to a slug of the whole URL when no id is present. Both paths are
 * sanitized so a filesystem-unsafe character can never break out of the archive directory.
 */
function toArchiveSlug(url: string): string {
  return toSafeSlug(extractDetailId(url) ?? url) || 'article';
}

/** Fahrplan year folder for the archive, falling back gracefully when the date is unknown. */
function resolveArchiveYear(dateIso: string): string {
  const year = getFahrplanYear(dateIso) ?? getCurrentFahrplanYear();
  return String(year ?? dateIso.slice(0, 4));
}

/**
 * The feed-item values recorded alongside the article. Both are optional: a legacy caller or a
 * feed item missing the field simply archives `unbekannt` rather than failing the run.
 */
export interface ArchiveItemMetadata {
  /** Raw RSS `<title>`; folded to one line on write. */
  readonly rssTitle?: string | undefined;
  /** RSS publication date, normalized to ISO so it sorts and compares like `Stand:`. */
  readonly rssPublishedIso?: string | undefined;
}

/**
 * Collapses the feed's multi-line `<title>` into one header line.
 *
 * The KVV ticker packs headline, lead sentence and validity range into a single `<title>`
 * element containing real newlines, but the header is a line-oriented `Label: value` format.
 * Folding to single spaces is lossless for every consumer that matters: relevance scoring
 * matches normalized substrings, so whitespace shape never changes a verdict.
 */
function foldToSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Header prepended to each archive file. Carries only stable values — the source URL, the
 * article's own Stand, and the feed item's title and publication date (each `unbekannt` when
 * absent) — so an unchanged article stays byte-identical run to run. A per-run value here
 * (e.g. a capture timestamp) would diff every file every run and drown out real edits.
 *
 * Title and pubDate are the *inputs the scraper judged the article by*: `analyzeRssItem` scores
 * the title (the KVV feed carries no `<description>`, so it is the entire RSS-gate input) and
 * the age gate reads pubDate. Recording them makes both decisions auditable after the fact and
 * replayable in tests, which a copy of the detail page alone cannot do. The trade-off is that a
 * re-worded ticker entry now diffs a file whose article body is unchanged — that is a real KVV
 * edit, but a different one than a body edit (see `docs/AGENTS.md`).
 */
function buildHeader(url: string, stand: string | undefined, item: ArchiveItemMetadata): string {
  // A title that folds to nothing (empty or whitespace-only) is as absent as a missing one.
  const title = foldToSingleLine(item.rssTitle ?? '');

  return [
    `${HEADER_QUELLE}${url}`,
    `${HEADER_STAND}${stand ?? HEADER_UNKNOWN}`,
    `${HEADER_TITEL}${title || HEADER_UNKNOWN}`,
    `${HEADER_DATUM}${item.rssPublishedIso ?? HEADER_UNKNOWN}`,
    HEADER_RULE,
    '',
  ].join('\n');
}

/** A rendered archive file: where it belongs and its full text content. */
export interface RenderedArchive {
  /** Fahrplan year folder the file belongs in. */
  readonly year: string;
  /** Filename stem (no extension) — the article's stable id. */
  readonly slug: string;
  /** Full file content (header + body), byte-stable for an unchanged article. */
  readonly content: string;
}

/**
 * Renders an article's archive file from its raw HTML — pure, no I/O. Splitting rendering
 * from writing lets the reparse tooling and tests exercise the exact archived text without
 * touching the filesystem.
 */
export function renderArchive(
  url: string,
  html: string,
  item: ArchiveItemMetadata = {},
): RenderedArchive {
  const body = toArchiveBody(html);

  // `standIso` is the article's Stand, or a current-time fallback when absent (`hasStand`
  // distinguishes them). The fallback is fine for foldering by year but must not appear in
  // the header, so only a real Stand is passed through.
  const { standIso, hasStand } = extractStand(body);
  const year = resolveArchiveYear(standIso.slice(0, ISO_DATE_LENGTH));

  return {
    year,
    slug: toArchiveSlug(url),
    content: `${buildHeader(url, hasStand ? standIso : undefined, item)}\n${body}\n`,
  };
}

/** An archive file split back into the parts the reparse tooling needs. */
export interface ParsedArchive {
  /** Source URL from the `Quelle:` header, or undefined if the header is missing. */
  readonly url: string | undefined;
  /**
   * Folded RSS title from the `Titel:` header, or undefined when the field is missing or
   * `unbekannt`. Archives written before the field existed never carry it, and their articles
   * have long left the feed, so it cannot be backfilled — consumers must handle its absence.
   */
  readonly rssTitle: string | undefined;
  /** ISO publication date from the `Datum:` header, absent under the same conditions. */
  readonly rssPublishedIso: string | undefined;
  /** The article body below the header rule — a valid input to `parseDetailPage`. */
  readonly body: string;
}

/** Reads one `Label: value` header field, treating `unbekannt` as absent. */
function readHeaderField(lines: readonly string[], label: string): string | undefined {
  const value = lines
    .find((line) => line.startsWith(label))
    ?.slice(label.length)
    .trim();
  return !value || value === HEADER_UNKNOWN ? undefined : value;
}

/**
 * Inverse of {@link renderArchive}: recovers the source URL, the recorded feed metadata and the
 * body from an archive file's content, so the body can be fed back through the parser. Falls
 * back to treating the whole content as the body when no header rule is present.
 */
export function parseArchive(content: string): ParsedArchive {
  const lines = content.split('\n');
  const ruleIndex = lines.indexOf(HEADER_RULE);
  // Scope field lookup to the header: `Titel:` could otherwise match a line of article prose.
  // With no rule the file predates the header entirely, so scanning it all changes nothing.
  const headerLines = ruleIndex >= 0 ? lines.slice(0, ruleIndex) : lines;
  const body =
    ruleIndex >= 0
      ? lines
          .slice(ruleIndex + 1)
          .join('\n')
          .trim()
      : content.trim();

  return {
    url: readHeaderField(headerLines, HEADER_QUELLE),
    rssTitle: readHeaderField(headerLines, HEADER_TITEL),
    rssPublishedIso: readHeaderField(headerLines, HEADER_DATUM),
    body,
  };
}

/**
 * Writes an article's plain-text body to `<baseDir>/<year>/articles/<id>.txt`.
 *
 * @param baseDir - Data directory root (e.g. `docs`)
 * @param url - Source detail-page URL (used for the filename and header)
 * @param html - Raw HTML of the detail page
 * @param item - Feed-item values to record alongside the article (title, publication date)
 */
export async function archiveArticleText(
  baseDir: string,
  url: string,
  html: string,
  item: ArchiveItemMetadata = {},
): Promise<void> {
  const { year, slug, content } = renderArchive(url, html, item);
  await writeTextFile(join(baseDir, year, ARCHIVE_SUBDIR, `${slug}.txt`), content);
}
