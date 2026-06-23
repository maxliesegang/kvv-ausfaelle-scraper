#!/usr/bin/env tsx
/**
 * Seed train-number → line definitions from a GTFS feed.
 *
 * GTFS expresses exactly the relation we need:
 *   trips.trip_short_name  = the train number (Zugnummer)
 *   trips.route_id → routes.route_short_name = the line (S1, S31, …)
 * We join them, keep KVV/AVG S-lines, and collect the distinct train numbers per line
 * as a flat list (docs/<year>/train-line-definitions/<line>.json: { line, trainNumbers }).
 *
 * Input:  a GTFS `.zip` (read directly via fflate). Recommended source: NVBW open data
 *         "Fahrplandaten ohne Liniennetz" (Baden-Württemberg) — it is the verified feed
 *         whose trips.txt actually carries trip_short_name for the Karlsruhe S-Bahn:
 *         https://www.nvbw.de/fileadmin/user_upload/service/open_data/fahrplandaten_ohne_liniennetz/bw_rp_sl.zip
 *         (Datenlizenz Deutschland – Namensnennung 2.0, direct download, ~80 MB).
 *         ⚠️ gtfs.de and DELFI GTFS exports drop trip_short_name and cannot be used.
 * Output: docs/<fahrplan-year>/train-line-definitions/<line>.json (overwritten).
 *
 * The seeded files are the pure GTFS train-number lists — a number is kept on every line
 * GTFS runs it on. There is no learning/merge step. Disambiguation and corrections happen
 * at lookup time (`src/train-lines.ts` + `src/train-line-definitions/overrides.ts`): a
 * multi-line article reports a cancellation under every mentioned line the number runs on,
 * and a number that maps to none of the mentioned lines is a hard parse error.
 *
 * Usage:
 *   npm run seed-train-lines                     # reads gtfs-data/latest.zip by default
 *   npm run seed-train-lines -- <gtfs.zip> [--year=2026] [--agency=<regex>] [--dry-run]
 *
 *   <gtfs.zip>     Path to the feed. Defaults to gtfs-data/latest.zip (git-ignored).
 *   --year=N       Fahrplan year to write (default: current).
 *   --agency=RE    Case-insensitive regex matched against agency_name to pick the
 *                  operator(s) (default: karlsruhe|kvv|albtal|avg). Falls back to the
 *                  S-line pattern alone if no agency matches.
 *   --dry-run      Print the summary without writing any files.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { getCurrentFahrplanYear, getFahrplanYearDefinition } from '../src/fahrplan.js';
import { writeJsonFile } from '../src/utils/fs.js';
import type { TrainLineDefinition } from '../src/train-line-definitions/types.js';
import {
  AMBIGUOUS_TRIPS_FILENAME,
  type AmbiguousTripsFile,
  type DateRange,
  type TripSignature,
} from '../src/train-line-definitions/ambiguous-trips.js';

const S_LINE_PATTERN = /^S\d+$/i;
const DEFAULT_AGENCY_PATTERN = /karlsruhe|kvv|albtal|avg/i;
/** Default location for the GTFS zip, relative to the repo root. */
const DEFAULT_ZIP_PATH = 'gtfs-data/latest.zip';

/** Parses RFC 4180-ish GTFS CSV text into row objects keyed by header. */
export function parseCsv(content: string): Record<string, string>[] {
  const text = content.replace(/^﻿/, ''); // strip BOM
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Finish the row on LF or the LF of a CRLF; swallow a lone CR's partner.
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }

  if (rows.length === 0) return [];

  const header = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((key, idx) => {
      record[key] = (cells[idx] ?? '').trim();
    });
    return record;
  });
}

export interface SeedOptions {
  readonly agencyPattern?: RegExp;
  /**
   * Fahrplan year the sidecar is being seeded for. When set, the build warns if the feed's
   * service dates do not reach back to the Fahrplan period start — without that coverage,
   * early-period articles (mid-December onward) cannot be date-disambiguated.
   */
  readonly fahrplanYear?: number;
}

export interface SeedResult {
  readonly definitions: TrainLineDefinition[];
  readonly warnings: string[];
  readonly matchedAgencies: string[];
}

/** Reads a column from a parsed CSV row (`''` when absent). Values are already trimmed. */
function col(row: Record<string, string>, key: string): string {
  return row[key] ?? '';
}

/** agency_ids (and their names) whose agency_name matches the operator pattern. */
function resolveAgencies(
  agencyTxt: string | undefined,
  pattern: RegExp,
): { ids: Set<string>; names: string[] } {
  const ids = new Set<string>();
  const names: string[] = [];
  for (const agency of agencyTxt ? parseCsv(agencyTxt) : []) {
    if (pattern.test(col(agency, 'agency_name'))) {
      ids.add(col(agency, 'agency_id'));
      names.push(col(agency, 'agency_name'));
    }
  }
  return { ids, names };
}

/** route_id → line for every S-line route, optionally restricted to the given agencies. */
function mapRoutesToLines(routesTxt: string, agencyIds: ReadonlySet<string>): Map<string, string> {
  const filterByAgency = agencyIds.size > 0;
  const routeIdToLine = new Map<string, string>();
  for (const route of parseCsv(routesTxt)) {
    const shortName = col(route, 'route_short_name');
    if (!S_LINE_PATTERN.test(shortName)) continue;
    if (filterByAgency && !agencyIds.has(col(route, 'agency_id'))) continue;
    routeIdToLine.set(col(route, 'route_id'), shortName.toUpperCase());
  }
  return routeIdToLine;
}

/** Groups numeric trip_short_names (Zugnummern) by line; counts trips that lack one. */
function collectTrainNumbersByLine(
  trips: readonly Record<string, string>[],
  routeIdToLine: ReadonlyMap<string, string>,
): { numbersByLine: Map<string, Set<number>>; tripsWithoutShortName: number } {
  const numbersByLine = new Map<string, Set<number>>();
  let tripsWithoutShortName = 0;
  for (const trip of trips) {
    const line = routeIdToLine.get(col(trip, 'route_id'));
    if (!line) continue;
    const shortName = col(trip, 'trip_short_name');
    if (!/^\d+$/.test(shortName)) {
      if (shortName === '') tripsWithoutShortName++;
      continue;
    }
    let numbers = numbersByLine.get(line);
    if (!numbers) numbersByLine.set(line, (numbers = new Set()));
    numbers.add(Number.parseInt(shortName, 10));
  }
  return { numbersByLine, tripsWithoutShortName };
}

/**
 * Builds line definitions from the three relevant GTFS tables (as raw CSV text).
 * Pure and offline so it can be unit-tested without a real feed.
 */
export function buildLineDefinitions(
  input: { routesTxt: string; tripsTxt: string; agencyTxt?: string },
  options: SeedOptions = {},
): SeedResult {
  const agencyPattern = options.agencyPattern ?? DEFAULT_AGENCY_PATTERN;
  const warnings: string[] = [];

  // 1. Resolve operator agencies; without a match, fall back to the S-line pattern alone.
  const { ids: agencyIds, names: matchedAgencies } = resolveAgencies(
    input.agencyTxt,
    agencyPattern,
  );
  if (input.agencyTxt && agencyIds.size === 0) {
    warnings.push(
      `No agency in agency.txt matched ${agencyPattern} — falling back to the S-line pattern alone.`,
    );
  }

  // 2. Map S-line routes (within those agencies) to their line names.
  const routeIdToLine = mapRoutesToLines(input.routesTxt, agencyIds);

  // 3. Group train numbers per line. A feed with no trip_short_name column at all cannot
  //    supply Zugnummern (gtfs.de's and DELFI's GTFS exports are like this) — flag it up
  //    front so the failure is obvious instead of a silent "0 lines".
  const trips = parseCsv(input.tripsTxt);
  const hasShortNameColumn = trips.length > 0 && 'trip_short_name' in trips[0]!;
  if (!hasShortNameColumn) {
    warnings.push(
      'trips.txt has no trip_short_name column — this feed carries no train numbers ' +
        '(Zugnummern) and cannot seed the mapping. Use the NVBW "Fahrplandaten ohne ' +
        'Liniennetz" GTFS, which includes trip_short_name.',
    );
  }
  const { numbersByLine, tripsWithoutShortName } = collectTrainNumbersByLine(trips, routeIdToLine);
  if (hasShortNameColumn && tripsWithoutShortName > 0) {
    warnings.push(
      `${tripsWithoutShortName} trip(s) on matched routes had no trip_short_name ` +
        `(e.g. tram-train lines without Zugnummern).`,
    );
  }

  // 4. Emit one flat, numerically-sorted list of train numbers per line.
  const definitions: TrainLineDefinition[] = [];
  for (const line of [...new Set(routeIdToLine.values())].sort()) {
    const numbers = numbersByLine.get(line);
    if (!numbers || numbers.size === 0) {
      warnings.push(`Line ${line} matched a route but had no numeric train numbers.`);
      definitions.push({ line, trainNumbers: [] });
      continue;
    }
    const trainNumbers = [...numbers].sort((a, b) => a - b).map(String);
    definitions.push({ line, trainNumbers });
  }

  return { definitions, warnings, matchedAgencies };
}

// --- Ambiguous-trip sidecar -------------------------------------------------------------
// A ~10% minority of train numbers run on more than one line. The flat lists above cannot
// say which line a given cancellation belongs to; this sidecar records each shared number's
// per-trip { line, departure, arrival } + the dates it runs, so the parser can match the
// article's date/times and report exactly the line(s) of the one physical run. Built from
// the same feed, but additionally needs stop_times.txt for the departure/arrival times.

/** GTFS `HH:MM:SS` (hours may exceed 24) → `HH:MM` folded into a 24-hour clock. */
function gtfsTimeToHHMM(time: string): string {
  const [h, m] = time.split(':');
  const hh = (((Number(h) % 24) + 24) % 24).toString().padStart(2, '0');
  return `${hh}:${m}`;
}

/** Day after a `YYYYMMDD` date, as `YYYYMMDD` (used to detect contiguous date runs). */
function nextDay(date: string): string {
  const dt = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Collapses a set of `YYYYMMDD` dates into sorted, inclusive contiguous ranges. */
function compressDates(dates: Iterable<string>): DateRange[] {
  const sorted = [...new Set(dates)].sort();
  const ranges: [string, string][] = [];
  for (const date of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && nextDay(last[1]) === date) last[1] = date;
    else ranges.push([date, date]);
  }
  return ranges;
}

/** Decodes a (potentially multi-GB) byte buffer line by line without building one string. */
function* iterateLines(bytes: Uint8Array): Generator<string> {
  const decoder = new TextDecoder('utf-8');
  const CHUNK = 1 << 24; // 16 MiB
  let buffer = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    buffer += decoder.decode(bytes.subarray(offset, offset + CHUNK), { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) yield buffer;
}

export interface TripEndpoint {
  readonly dep: string;
  readonly arr: string;
}

/**
 * Streams stop_times.txt and returns first-stop departure / last-stop arrival per wanted
 * trip. Only the leading columns (trip_id, arrival_time, departure_time, stop_sequence)
 * are read; they are simple unquoted tokens, so a plain comma split is safe even though
 * later columns (stop_headsign) may be quoted.
 */
export function collectTripEndpoints(
  stopTimesBytes: Uint8Array,
  wantedTripIds: ReadonlySet<string>,
): Map<string, TripEndpoint> {
  const lines = iterateLines(stopTimesBytes);
  const header = lines.next().value;
  if (!header) return new Map();
  const cols = header.split(',').map((c: string) => c.trim().replace(/^"|"$/g, ''));
  const idx = (name: string) => cols.indexOf(name);
  const ti = idx('trip_id');
  const ai = idx('arrival_time');
  const di = idx('departure_time');
  const si = idx('stop_sequence');
  if (ti < 0 || ai < 0 || di < 0 || si < 0) {
    throw new Error(
      'stop_times.txt is missing one of trip_id/arrival_time/departure_time/stop_sequence',
    );
  }

  // GTFS values here are quoted (e.g. `"ovf-1-…","09:13:00",…`); strip the surrounding
  // quotes. The columns we read (trip_id, times, stop_sequence) precede any field that
  // could contain a comma, so a plain split is still safe.
  const unquote = (value: string | undefined): string => (value ?? '').replace(/^"|"$/g, '');

  const acc = new Map<string, { minSeq: number; maxSeq: number; dep: string; arr: string }>();
  for (const line of lines) {
    const f = line.split(',');
    const tripId = unquote(f[ti]);
    if (!tripId || !wantedTripIds.has(tripId)) continue;
    const seq = Number(unquote(f[si]));
    let entry = acc.get(tripId);
    if (!entry)
      acc.set(tripId, (entry = { minSeq: Infinity, maxSeq: -Infinity, dep: '', arr: '' }));
    if (seq < entry.minSeq) {
      entry.minSeq = seq;
      entry.dep = gtfsTimeToHHMM(unquote(f[di]) || unquote(f[ai]));
    }
    if (seq > entry.maxSeq) {
      entry.maxSeq = seq;
      entry.arr = gtfsTimeToHHMM(unquote(f[ai]) || unquote(f[di]));
    }
  }

  const endpoints = new Map<string, TripEndpoint>();
  for (const [tripId, e] of acc)
    if (e.dep && e.arr) endpoints.set(tripId, { dep: e.dep, arr: e.arr });
  return endpoints;
}

/** service_id → set of operating dates (added dates minus removed), from calendar_dates.txt. */
function serviceDates(calendarDatesTxt: string): Map<string, Set<string>> {
  const dates = new Map<string, Set<string>>();
  for (const row of parseCsv(calendarDatesTxt)) {
    if (col(row, 'exception_type') !== '1') continue;
    const id = col(row, 'service_id');
    (dates.get(id) ?? dates.set(id, new Set()).get(id)!).add(col(row, 'date'));
  }
  for (const row of parseCsv(calendarDatesTxt)) {
    if (col(row, 'exception_type') === '2')
      dates.get(col(row, 'service_id'))?.delete(col(row, 'date'));
  }
  return dates;
}

export interface AmbiguousResult {
  readonly trips: Record<string, TripSignature[]>;
  readonly sharedNumberCount: number;
  readonly warnings: string[];
}

/**
 * Train numbers (numeric Zugnummern) that GTFS runs on more than one of the mapped lines —
 * the only numbers the flat per-line lists cannot disambiguate, so the only ones the
 * sidecar needs to describe.
 */
function sharedTrainNumbers(
  routeIdToLine: ReadonlyMap<string, string>,
  trips: readonly Record<string, string>[],
): Set<string> {
  const linesByNumber = new Map<string, Set<string>>();
  for (const trip of trips) {
    const line = routeIdToLine.get(col(trip, 'route_id'));
    const number = col(trip, 'trip_short_name');
    if (!line || !/^\d+$/.test(number)) continue;
    (linesByNumber.get(number) ?? linesByNumber.set(number, new Set()).get(number)!).add(line);
  }
  return new Set(
    [...linesByNumber].filter(([, lines]) => lines.size > 1).map(([number]) => number),
  );
}

/**
 * Builds the ambiguous-trip signatures: for every train number that runs on more than one
 * line, the distinct `{ line, dep, arr }` signatures and the dates each is active. Pure
 * and offline (endpoints are precomputed) so it can be unit-tested without a real feed.
 */
export function buildAmbiguousTrips(
  input: { routesTxt: string; tripsTxt: string; calendarDatesTxt: string; agencyTxt?: string },
  endpoints: ReadonlyMap<string, TripEndpoint>,
  options: SeedOptions = {},
): AmbiguousResult {
  const warnings: string[] = [];
  const { ids: agencyIds } = resolveAgencies(
    input.agencyTxt,
    options.agencyPattern ?? DEFAULT_AGENCY_PATTERN,
  );
  const routeIdToLine = mapRoutesToLines(input.routesTxt, agencyIds);
  const trips = parseCsv(input.tripsTxt);
  const shared = sharedTrainNumbers(routeIdToLine, trips);

  const svcDates = serviceDates(input.calendarDatesTxt);
  if (shared.size > 0 && [...svcDates.values()].every((dates) => dates.size === 0)) {
    warnings.push(
      'calendar_dates.txt produced no service dates — this feed likely expresses regular ' +
        'service via calendar.txt (weekday flags), which the seeder does not read. The ' +
        'sidecar will be empty and lookup degrades to flat-list (no date/time ' +
        'disambiguation). Use a feed that enumerates dates in calendar_dates.txt.',
    );
  }

  // number → "line|dep|arr" → accumulated dates
  type Sig = { line: string; dep: string; arr: string; dates: Set<string> };
  const byNumber = new Map<string, Map<string, Sig>>();
  for (const trip of trips) {
    const number = col(trip, 'trip_short_name');
    if (!shared.has(number)) continue;
    const line = routeIdToLine.get(col(trip, 'route_id'));
    const endpoint = endpoints.get(col(trip, 'trip_id'));
    if (!line || !endpoint) continue;

    const key = `${line}|${endpoint.dep}|${endpoint.arr}`;
    const sigs = byNumber.get(number) ?? byNumber.set(number, new Map()).get(number)!;
    const sig = sigs.get(key) ?? { line, dep: endpoint.dep, arr: endpoint.arr, dates: new Set() };
    for (const date of svcDates.get(col(trip, 'service_id')) ?? []) sig.dates.add(date);
    sigs.set(key, sig);
  }

  const result: Record<string, TripSignature[]> = {};
  for (const number of [...byNumber.keys()].sort((a, b) => Number(a) - Number(b))) {
    const signatures = [...byNumber.get(number)!.values()]
      .filter((s) => s.dates.size > 0)
      .sort((a, b) => a.line.localeCompare(b.line) || a.dep.localeCompare(b.dep))
      .map((s) => ({ line: s.line, dep: s.dep, arr: s.arr, dates: compressDates(s.dates) }));
    if (signatures.length > 0) result[number] = signatures;
  }

  const withoutEndpoints = shared.size - Object.keys(result).length;
  if (withoutEndpoints > 0) {
    warnings.push(
      `${withoutEndpoints} shared number(s) had no usable stop_times and were skipped.`,
    );
  }

  // Warn if the feed's coverage starts after the Fahrplan period begins: dates before the
  // earliest signature cannot be date-disambiguated and fall back to all candidate lines.
  const periodStart = options.fahrplanYear
    ? getFahrplanYearDefinition(options.fahrplanYear)?.startDate.replace(/-/g, '')
    : undefined;
  if (periodStart) {
    const earliest = Object.values(result)
      .flat()
      .flatMap((s) => s.dates.map(([start]) => start))
      .sort()[0];
    if (earliest && earliest > periodStart) {
      warnings.push(
        `Feed coverage starts ${earliest}, after the Fahrplan ${options.fahrplanYear} start ` +
          `${periodStart}. Cancellations dated before ${earliest} cannot be date-disambiguated ` +
          `(they degrade to all candidate lines). Seed from a feed covering the period start.`,
      );
    }
  }

  return { trips: result, sharedNumberCount: shared.size, warnings };
}

const NEEDED_GTFS_FILES = new Set([
  'routes.txt',
  'trips.txt',
  'agency.txt',
  'calendar_dates.txt',
  'stop_times.txt',
]);

function readGtfsFromZip(zipPath: string): {
  routesTxt: string;
  tripsTxt: string;
  calendarDatesTxt: string;
  stopTimesBytes: Uint8Array;
  agencyTxt?: string;
} {
  // Decompress only the tables we use — skips shapes.txt and keeps memory bounded.
  const unzipped = unzipSync(new Uint8Array(readFileSync(zipPath)), {
    filter: (file) => NEEDED_GTFS_FILES.has(file.name.split('/').pop()!),
  });
  // Index by basename so nested paths (e.g. "gtfs/routes.txt") still resolve.
  const byName = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(unzipped)) {
    byName.set(path.split('/').pop()!, bytes);
  }
  const read = (name: string): string | undefined => {
    const bytes = byName.get(name);
    return bytes ? strFromU8(bytes) : undefined; // safe: these tables are well under 512 MB
  };

  const routesTxt = read('routes.txt');
  const tripsTxt = read('trips.txt');
  const stopTimesBytes = byName.get('stop_times.txt'); // kept as bytes; it can exceed 1 GB
  if (!routesTxt) throw new Error(`routes.txt not found in ${zipPath}`);
  if (!tripsTxt) throw new Error(`trips.txt not found in ${zipPath}`);
  if (!stopTimesBytes) throw new Error(`stop_times.txt not found in ${zipPath}`);

  return {
    routesTxt,
    tripsTxt,
    calendarDatesTxt: read('calendar_dates.txt') ?? '',
    stopTimesBytes,
    ...(read('agency.txt') ? { agencyTxt: read('agency.txt')! } : {}),
  };
}

function slugify(line: string): string {
  return line.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

interface CliArgs {
  zipPath: string;
  year: number;
  agencyPattern: RegExp;
  dryRun: boolean;
  skipSidecar: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let zipPath: string | undefined;
  let year = getCurrentFahrplanYear();
  let agencyPattern = DEFAULT_AGENCY_PATTERN;
  let dryRun = false;
  let skipSidecar = false;

  for (const arg of argv) {
    if (arg.startsWith('--year=')) year = Number.parseInt(arg.slice('--year='.length), 10);
    else if (arg.startsWith('--agency='))
      agencyPattern = new RegExp(arg.slice('--agency='.length), 'i');
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--skip-sidecar') skipSidecar = true;
    else if (!arg.startsWith('--')) zipPath = arg;
  }

  // Default to the git-ignored drop folder so the common case is just `npm run seed-train-lines`.
  zipPath = zipPath ?? join(process.cwd(), DEFAULT_ZIP_PATH);

  if (!existsSync(zipPath)) {
    throw new Error(
      `GTFS zip not found at ${zipPath}.\n` +
        `Put a feed at ${DEFAULT_ZIP_PATH} (see gtfs-data/README.md) or pass an explicit path:\n` +
        `  npm run seed-train-lines -- <path-to-gtfs.zip> [--year=N] [--agency=RE] [--dry-run]`,
    );
  }
  if (!year || Number.isNaN(year)) {
    throw new Error('Could not determine Fahrplan year. Pass --year=<n> (see src/fahrplan.ts).');
  }

  return { zipPath, year, agencyPattern, dryRun, skipSidecar };
}

/** The `trip_id`s of every trip whose number runs on more than one S-line. */
function sharedNumberTripIds(
  routeIdToLine: ReadonlyMap<string, string>,
  trips: readonly Record<string, string>[],
): Set<string> {
  const shared = sharedTrainNumbers(routeIdToLine, trips);
  const wanted = new Set<string>();
  for (const trip of trips) {
    if (shared.has(col(trip, 'trip_short_name'))) wanted.add(col(trip, 'trip_id'));
  }
  return wanted;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Reading GTFS from ${args.zipPath} …`);
  const gtfs = readGtfsFromZip(args.zipPath);

  const { definitions, warnings, matchedAgencies } = buildLineDefinitions(gtfs, {
    agencyPattern: args.agencyPattern,
  });

  if (matchedAgencies.length > 0) {
    console.log(`Matched agencies: ${matchedAgencies.join(', ')}`);
  }

  const outDir = join(process.cwd(), 'docs', String(args.year), 'train-line-definitions');
  console.log(
    `\nSeeding ${definitions.length} line(s) → ${outDir}${args.dryRun ? ' [dry run]' : ''}\n`,
  );

  for (const def of definitions) {
    // Skip lines with no train numbers (e.g. tram-train lines without Zugnummern) —
    // an empty definition adds nothing and only clutters the directory.
    if (def.trainNumbers.length === 0) {
      console.log(`  ${def.line.padEnd(5)} no train numbers — skipped`);
      continue;
    }

    console.log(`  ${def.line.padEnd(5)} ${def.trainNumbers.length} train number(s)`);
    if (!args.dryRun) {
      await writeJsonFile(join(outDir, `${slugify(def.line)}.json`), def);
    }
  }

  const sidecarWarnings = args.skipSidecar ? [] : await seedAmbiguousSidecar(gtfs, args, outDir);

  const allWarnings = [...warnings, ...sidecarWarnings];
  if (allWarnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of allWarnings) console.log(`  ⚠️  ${warning}`);
  }

  console.log(`\nDone${args.dryRun ? ' (no files written)' : ''}.`);
}

/** Builds and writes the ambiguous-trip sidecar; returns any warnings to surface. */
async function seedAmbiguousSidecar(
  gtfs: ReturnType<typeof readGtfsFromZip>,
  args: CliArgs,
  outDir: string,
): Promise<string[]> {
  const { ids: agencyIds } = resolveAgencies(gtfs.agencyTxt, args.agencyPattern);
  const routeIdToLine = mapRoutesToLines(gtfs.routesTxt, agencyIds);
  const wanted = sharedNumberTripIds(routeIdToLine, parseCsv(gtfs.tripsTxt));

  console.log(`\nScanning stop_times.txt for ${wanted.size} shared-number trips …`);
  const endpoints = collectTripEndpoints(gtfs.stopTimesBytes, wanted);

  const { trips, sharedNumberCount, warnings } = buildAmbiguousTrips(gtfs, endpoints, {
    agencyPattern: args.agencyPattern,
    fahrplanYear: args.year,
  });

  const numberCount = Object.keys(trips).length;
  const signatureCount = Object.values(trips).reduce((sum, sigs) => sum + sigs.length, 0);
  console.log(
    `Ambiguous sidecar: ${numberCount}/${sharedNumberCount} shared number(s), ` +
      `${signatureCount} signature(s)${args.dryRun ? ' [dry run]' : ''}`,
  );

  if (!args.dryRun) {
    const file: AmbiguousTripsFile = { version: 1, year: args.year, trips };
    await writeJsonFile(join(outDir, AMBIGUOUS_TRIPS_FILENAME), file);
  }
  return warnings;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
