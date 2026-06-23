# Script Agents

Guidance in this file applies to `scripts/**`.
This is the most specific guidance for maintenance scripts.

## Scope

- One-off or utility scripts that help maintain parser data and mappings.
- Scripts may read/update repository files; keep side effects explicit.

## Scripts

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
