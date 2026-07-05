# Script Agents

Guidance in this file applies to `scripts/**`.
This is the most specific guidance for maintenance scripts.

## Scope

- One-off or utility scripts that help maintain parser data and mappings.
- Scripts may read/update repository files; keep side effects explicit.

## Scripts

- `reparse-archives.ts` (`npm run reparse-archives`) — **read-only** report by default. Walks
  `docs/<year>/articles/*.txt` (the text archive written by `src/article-archive.ts`),
  feeds each body back through `parseDetailPage` + cause classification, and diffs the
  result against the stored `docs/<year>/<line>.json` (matched by the `Quelle:` source URL,
  keyed by `date|trainNumber|fromTime`). Surfaces parser/classifier improvements (archive
  now yields trips/causes the stored data lacks) and regressions (archive no longer yields
  stored trips). Flags: `--year=N`, `--verbose`, and `--write`. Without `--write` it writes
  nothing and always exits 0. With `--write` it **backfills**: re-stamps `cause`/`causeKeyword`
  on every stored trip whose article is archived and reparses to the same trip key — the
  channel by which a cause-taxonomy change reaches history, but only as far as the archive
  reaches (pre-archive trips keep their stored cause). It touches only those two fields, never
  trip identity/order, so unaffected files stay byte-identical. Reuses
  `renderArchive`/`parseArchive` from `src/article-archive.ts` so the archive format lives
  in one place; the `tests/unit/article-archive.test.ts` "reparse fidelity" suite locks the
  property that archived text reparses to the same trips as the original HTML.

- `seed-train-lines-from-gtfs.ts` (`npm run seed-train-lines`) — (re)generate
  `docs/<year>/train-line-definitions/*.json` from a GTFS `.zip`: a flat per-line list of
  train numbers (`<line>.json`, a number kept on every line GTFS runs it on) **plus** the
  `ambiguous-trips.json` timing sidecar for numbers that run on more than one line (per-trip
  `{ line, dep, arr, dates }` from `stop_times.txt` + `calendar_dates.txt`, used to
  disambiguate at lookup time). Overwrites the year's files with pure GTFS data. Offline
  (reads the zip via `fflate`); pure logic (`parseCsv`, `buildLineDefinitions`,
  `collectTripEndpoints`, `buildAmbiguousTrips`) is exported for unit testing. It warns when
  the feed lacks `trip_short_name`, expresses service via `calendar.txt` instead of
  `calendar_dates.txt`, or starts after the Fahrplan period begins. Usage:
  `npm run seed-train-lines -- <gtfs.zip> [--year=N] [--agency=RE] [--dry-run]`.
  Source the zip from NVBW "Fahrplandaten ohne Liniennetz" (Baden-Württemberg open data),
  the verified feed that carries `trip_short_name` for the Karlsruhe S-Bahn. gtfs.de /
  DELFI GTFS exports and KVV's own EFA GTFS all lack `trip_short_name` and cannot be used.

## Change Rules

- Prefer idempotent behavior where possible.
- Document expected inputs/outputs in script header comments.
- Avoid hidden writes outside intended targets.

## Required Validation

1. Run the changed script against a safe/example input.
2. `npm run type-check`
3. `npm run format:check`
