# Script Agents

Guidance in this file applies to `scripts/**`.
This is the most specific guidance for maintenance scripts.

## Scope

- One-off or utility scripts that help maintain parser data and mappings.
- Scripts may read/update repository files; keep side effects explicit.

## Scripts

- `reparse-archives.ts` (`npm run reparse-archives`) — **read-only** report by default. Walks
  `docs/<fahrplan-year>/articles/*.txt` (the text archive written by `src/article-archive.ts`),
  feeds each body back through `parseDetailPage` + cause classification, and diffs the
  result against stored `docs/<fahrplan-year>/<line>.json`, matched by the `Quelle:` source
  URL. The base trip identity is `date|trainNumber|fromTime`; report/reconciliation lookups add
  the appropriate line or source scope when crossing files. Surfaces parser/classifier
  improvements and regressions. Flags: `--year=N`, `--verbose`, `--write`, and
  `--write-trips`. The two write flags are mutually exclusive.
  - No write flag: reports differences, writes nothing, and exits 0 regardless of findings.
  - `--write`: backfills only `cause`/`causeKeyword` for stored trips that reparse to the same
    identity. Pre-archive trips retain their stored classification.
  - `--write-trips`: fully reconciles each successfully parsed archived article with stored
    trips from the same source URL. It preserves an existing trip's `capturedAt` and uses the
    canonical storage ordering.
  - Safety: parse failures and articles without structured train-number rows never participate
    in deletion.
    The script reuses `renderArchive`/`parseArchive` from `src/article-archive.ts` so the archive
    format lives in one place; the `tests/unit/article-archive.test.ts` "reparse fidelity" suite
    locks the property that archived text reparses to the same trips as the original HTML.

- `seed-train-lines-from-gtfs.ts` (`npm run seed-train-lines`) — (re)generate
  `docs/<fahrplan-year>/train-line-definitions/*.json` from a GTFS `.zip`: a flat per-line list of
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
- Model mutually exclusive command behavior as one named operation internally rather than a set
  of overlapping booleans; preserve established CLI flags unless intentionally migrating them.

## Required Validation

1. Run the changed script against a safe/example input.
2. `npm run type-check`
3. `npm run format:check`
