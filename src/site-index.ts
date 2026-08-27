import { join } from 'node:path';
import { ensureDirectory, listFiles, readJsonFile, writeTextFile } from './utils/fs.js';
import { listFahrplanYearDirectories } from './fahrplan.js';
import { PUBLIC_CAUSE_DEFINITIONS } from './cause.js';
import type { Cancellation } from './types.js';
import {
  PUBLIC_VERIFICATION_STATUS_DEFINITIONS,
  VERIFICATION_SOURCE,
  type VerificationStatus,
} from './verification/verify.js';

/** Version of the public root-index contract. Increment only for breaking changes. */
export const ROOT_INDEX_SCHEMA_VERSION = 1;

const BASE_PAGE_STYLES = `
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 2rem; line-height: 1.5; }
      h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
      nav { margin-bottom: 1rem; }
      ul { padding-left: 1.25rem; }
      code { background: #f6f8fa; padding: 0.1rem 0.3rem; border-radius: 4px; }
      .desc { color: #444; margin-bottom: 1rem; }
      .hint { color: #555; margin-top: 1rem; font-size: .95rem; }
      footer { margin-top: 2rem; font-size: 0.9rem; color: #666; }
`;

interface PageDefinition {
  readonly title: string;
  readonly body: string;
}

/**
 * Escapes special HTML characters.
 */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildList(
  items: readonly string[],
  renderItem: (item: string) => string,
  empty: string,
): string {
  return items.length > 0 ? items.map(renderItem).join('\n') : empty;
}

function renderPage({ title, body }: PageDefinition): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
${BASE_PAGE_STYLES}
    </style>
  </head>
  <body>
${body}
  </body>
</html>
`;
}

function buildIndexJson<T extends object>(data: T, generatedAt: string): string {
  return JSON.stringify({ ...data, generatedAt }, null, 2);
}

/**
 * Verdict tally for one Fahrplan year, published so the realtime evidence attached to individual
 * trips is discoverable at all. Stored per trip, it is invisible to anyone who has not already
 * downloaded and searched a line file — including the two facts most worth seeing, that some
 * announced cancellations were later observed to have run and that others could not be checked.
 *
 * `checkedTrips` is deliberately reported against `totalTrips`: providers answer only inside
 * short rolling lookback windows, so most stored trips carry no verdict and never will. Without
 * the denominator the counts read as a claim about the year rather than about recent trips.
 */
export interface VerificationSummary {
  /** Legacy single-source summary; `multiple` when selected evidence comes from several feeds. */
  readonly source: string;
  readonly sources: readonly string[];
  readonly checkedTrips: number;
  readonly totalTrips: number;
  /** Verdict counts, keyed by status. Statuses with no trips are omitted. */
  readonly statusCounts: Readonly<Partial<Record<VerificationStatus, number>>>;
}

/** Statuses in published order, so a summary reads the same way everywhere it appears. */
const VERIFICATION_STATUS_ORDER: readonly VerificationStatus[] =
  PUBLIC_VERIFICATION_STATUS_DEFINITIONS.map(({ id }) => id);

/**
 * Tally the verdicts stored in a year's line files.
 *
 * Reads the same per-line JSON the site publishes rather than any intermediate state, so the
 * summary cannot drift from the files a consumer downloads. A malformed or non-array file counts
 * as no trips instead of failing index generation: a broken data file must not cost the site its
 * index pages.
 */
async function summarizeVerification(
  fahrplanYearDirectory: string,
  files: readonly string[],
): Promise<VerificationSummary> {
  const statusCounts: Partial<Record<VerificationStatus, number>> = {};
  let checkedTrips = 0;
  let totalTrips = 0;
  const sources = new Set<string>();

  for (const file of files) {
    if (file.startsWith('index')) continue;
    const trips = await readJsonFile<Cancellation[]>(join(fahrplanYearDirectory, file));
    if (!Array.isArray(trips)) continue;
    for (const trip of trips) {
      totalTrips += 1;
      const status = trip?.verification?.status;
      if (!status) continue;
      sources.add(trip.verification.source);
      for (const source of Object.keys(trip.verification.checks ?? {})) sources.add(source);
      checkedTrips += 1;
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }
  }

  const orderedCounts: Partial<Record<VerificationStatus, number>> = {};
  for (const status of VERIFICATION_STATUS_ORDER) {
    const count = statusCounts[status];
    if (count !== undefined) orderedCounts[status] = count;
  }

  return {
    source: sources.size > 1 ? 'multiple' : ([...sources][0] ?? VERIFICATION_SOURCE),
    sources: [...sources].sort(),
    checkedTrips,
    totalTrips,
    statusCounts: orderedCounts,
  };
}

/**
 * Builds the root index HTML page listing all available years.
 */
function buildRootIndex(years: readonly string[]): string {
  const sortedYears = years.slice().sort();
  const yearLinks = buildList(
    sortedYears,
    (year) => `      <li><a href="./${htmlEscape(year)}/">${htmlEscape(year)}</a></li>`,
    '      <li><em>No years yet</em></li>',
  );
  const verificationStatusDefinitions = PUBLIC_VERIFICATION_STATUS_DEFINITIONS.map(
    ({ id, label, description }) =>
      `      <dt><code>${htmlEscape(id)}</code> — ${htmlEscape(label)}</dt>\n` +
      `      <dd>${htmlEscape(description)}</dd>`,
  ).join('\n');
  const causeDefinitions = PUBLIC_CAUSE_DEFINITIONS.map(
    ({ id, label, description }) =>
      `      <dt><code>${htmlEscape(id)}</code> — ${htmlEscape(label)}</dt>\n` +
      `      <dd>${htmlEscape(description)}</dd>`,
  ).join('\n');

  return renderPage({
    title: 'KVV Ausfälle — Data Index',
    body: `
    <h1>KVV Ausfälle — Data Index</h1>
    <p class="desc">
      Static data files generated by the scraper. Browse into a year to see available JSON files.
    </p>

    <h2>Years</h2>
    <ul>
${yearLinks}
    </ul>

    <h2>Verification statuses</h2>
    <p class="desc">
      Trips carry an optional advisory <code>verification</code> field recording what external
      realtime sources later observed. It never changes the record's primary meaning — that KVV
      announced the trip as cancelled — and is absent for trips outside every provider's rolling
      lookback window. Fallback routing data is provided by
      <a href="https://transitous.org/sources/">Transitous and its listed sources</a>.
    </p>
    <dl>
${verificationStatusDefinitions}
    </dl>

    <h2>Cancellation causes</h2>
    <p class="desc">
      Ordered cause taxonomy published in <code>index.json</code> for downstream consumers.
    </p>
    <dl>
${causeDefinitions}
    </dl>

    <footer>
      <p>Site root is <code>docs/</code>. If a directory doesn't list files, try navigating directly by URL.</p>
    </footer>
`,
  });
}

/**
 * Builds a year index HTML page listing all JSON files for that year.
 */
function buildVerificationSection(summary: VerificationSummary): string {
  const sourceLabel = summary.sources.length > 0 ? summary.sources.join(', ') : summary.source;
  if (summary.checkedTrips === 0) {
    return `    <p class="hint">No trips in the configured verification lookback windows have been verified yet.</p>`;
  }
  const rows = PUBLIC_VERIFICATION_STATUS_DEFINITIONS.flatMap(({ id, label }) => {
    const count = summary.statusCounts[id];
    return count === undefined
      ? []
      : [
          `      <li><code>${htmlEscape(id)}</code> — ${htmlEscape(label)}: ` +
            `<strong>${count}</strong></li>`,
        ];
  }).join('\n');

  return `    <ul>
${rows}
    </ul>
    <p class="hint">
      ${summary.checkedTrips} of ${summary.totalTrips} stored trips carry a verdict from
      <code>${htmlEscape(sourceLabel)}</code>. The rest departed outside all configured rolling
      lookback windows and cannot be checked.
    </p>`;
}

function buildYearIndex(
  year: string,
  files: readonly string[],
  summary: VerificationSummary,
): string {
  const sortedFiles = files.slice().sort();
  const fileLinks = buildList(
    sortedFiles,
    (file) =>
      `      <li><a href="./${encodeURIComponent(file)}"><code>${htmlEscape(file)}</code></a></li>`,
    '      <li><em>No files yet</em></li>',
  );

  return renderPage({
    title: `KVV Ausfälle — ${htmlEscape(year)}`,
    body: `
    <nav><a href="../">← Back to index</a></nav>
    <h1>KVV Ausfälle — ${htmlEscape(year)}</h1>
    <p>JSON data files generated by the scraper for ${htmlEscape(year)}.</p>

    <h2>Files</h2>
    <ul>
${fileLinks}
    </ul>

    <h2>Verification</h2>
    <p>Advisory realtime evidence stored on individual trips (see <a href="../">status
    definitions</a>).</p>
${buildVerificationSection(summary)}

    <p class="hint">If additional files are added (e.g., for other lines), they will appear automatically on next run.</p>
`,
  });
}

/**
 * Builds the root index JSON listing all available years.
 */
function buildRootIndexJson(years: readonly string[], generatedAt: string): string {
  return buildIndexJson(
    {
      schemaVersion: ROOT_INDEX_SCHEMA_VERSION,
      years: years.slice().sort(),
      causes: PUBLIC_CAUSE_DEFINITIONS,
      verificationStatuses: PUBLIC_VERIFICATION_STATUS_DEFINITIONS,
    },
    generatedAt,
  );
}

/**
 * Builds a year index JSON listing all JSON files for that year.
 */
function buildYearIndexJson(
  year: string,
  files: readonly string[],
  verification: VerificationSummary,
  generatedAt: string,
): string {
  return buildIndexJson({ year, files: files.slice().sort(), verification }, generatedAt);
}

/**
 * Lists all JSON files in a directory.
 */
async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await listFiles(dir);
  return entries.filter((name) => name.toLowerCase().endsWith('.json'));
}

/**
 * Generates HTML and JSON index pages for the site.
 * Creates a root index listing all years and per-year indices listing JSON files.
 */
export async function generateSiteIndices(baseDir: string): Promise<void> {
  // Ensure base directory exists
  await ensureDirectory(baseDir);

  const years = await listFahrplanYearDirectories(baseDir);
  const generatedAt = new Date().toISOString();

  // Generate root indices (HTML and JSON)
  const rootHtml = buildRootIndex(years);
  const rootJson = buildRootIndexJson(years, generatedAt);
  await Promise.all([
    writeTextFile(join(baseDir, 'index.html'), rootHtml),
    writeTextFile(join(baseDir, 'index.json'), rootJson),
  ]);

  // Generate per-year indices (HTML and JSON)
  await Promise.all(
    years.map(async (year) => {
      const fahrplanYearDirectory = join(baseDir, year);
      const files = await listJsonFiles(fahrplanYearDirectory);
      const verification = await summarizeVerification(fahrplanYearDirectory, files);
      const html = buildYearIndex(year, files, verification);
      const json = buildYearIndexJson(year, files, verification, generatedAt);
      await Promise.all([
        writeTextFile(join(fahrplanYearDirectory, 'index.html'), html),
        writeTextFile(join(fahrplanYearDirectory, 'index.json'), json),
      ]);
    }),
  );
}
