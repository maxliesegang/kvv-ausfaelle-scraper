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
  improvements and regressions. Flags: `--year=N`, `--verbose`, `--write`, `--write-dates`, and
  `--write-trips`. The three write flags are mutually exclusive.
  - No write flag: reports differences, writes nothing, and exits 0 regardless of findings.
  - `--write`: backfills only `cause`/`causeKeyword` for stored trips that reparse to the same
    identity. Pre-archive trips retain their stored classification.
  - `--write-dates`: re-stamps only `date`, matching a stored trip to its reparsed self by
    line + train number + departure time — the identity that survives a date correction — and
    collapsing records the new date makes identical. A redate that would leave the directory's
    Fahrplan year is reported and skipped, never written into the wrong year. Run this _before_
    `--write-trips` after a dating change: a changed `date` is a changed identity, so
    reconciliation alone would keep the old (departed, hence retained) record and add the
    corrected one beside it.
  - `--write-trips`: fully reconciles each successfully parsed archived article with stored
    trips from the same source URL. It preserves an existing trip's `capturedAt` and uses the
    canonical storage ordering.
  - Safety: parse failures and articles without structured train-number rows never participate
    in deletion. Nor do already-departed trips — the same forward-looking rule the live
    reconciler applies (`hasDeparted` in `src/storage.ts`), so the script and the scraper
    cannot undo each other. The default report
    splits those out as "past trip(s) retained" instead of counting them as would-be removals.
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

- `verify-trips.ts` (`npm run verify-trips`) — **read-only** report by default. Back-verifies
  stored cancellations against bahn.expert's realtime feed and stamps the advisory
  `verification` field on each trip; `--write` persists, `--year=N` / `--date=YYYY-MM-DD` narrow
  the scope, `--recheck` re-fetches settled verdicts, `--verbose` lists every verdict.
  - Verdict counts are recorded at two scopes: `segmentStops` / `segmentCancelledStops` /
    `segmentTrackedStops` for the announced segment (these decide the verdict), and
    `journeyStops` / `journeyCancelledStops` for the whole run. The journey scope is what makes a
    segment count readable — `18/30 cancelled` means something different on a 30-stop run than on
    a 132-stop one, and it reveals a disruption that spilled past the segment KVV named.
  - **Advisory only.** It writes `verification` and nothing else. A stored cancellation means
    "KVV announced this trip would not run", which stays true whatever the train did;
    verification adds the separate fact "it did / did not actually run". The disagreement
    between the two is the signal, so this must never prune or rewrite trip identity — that
    would collapse two datasets into one and destroy the thing worth measuring.
  - **Segment scoping is the core rule.** A notice names the _affected segment_ of a longer run
    (`20019 Ittersbach Rathaus (09:21) - Ettlingen Stadt (09:45)` is one leg of a journey
    continuing to 10:31), so verdicts are computed over `fromTime` → `toStop` only. Judging the
    whole journey reports "ran" for trips whose announced leg was never served.
  - **Absence of realtime is not evidence of cancellation.** A segment with no realtime counts as
    cancelled only when the _rest of the same run_ was tracked, which proves the feed had
    coverage; otherwise the verdict is `no-data`. `no-data` and `unresolved` are re-checked on
    later runs, settled verdicts are not.
  - **Line names are a hint, not a key.** KVV and the feed name the same run differently _by
    design_: KVV publishes the corridor a rider recognises (`S51`, `S7`) while the feed follows
    GTFS's operational short-workings (`S52`, `S71`), or has no line at all for a depot run (`E`).
    The scraper sides with KVV deliberately — a single-line article uses its own line directly, and
    `src/train-line-definitions/overrides.ts` forces specific numbers onto the mentioned corridor.
    So candidates on the stored line are tried first, then the rest, and identity is confirmed by
    finding the announced departure on the right date. A differing feed line is recorded as
    `feedLine`: a naming-convention marker whose value is longitudinal, **never** a reason to
    rewrite `line` — doing so would file trips under lines KVV never mentioned and silently undo
    the override decisions.
  - **Retries are bounded** (`MAX_ATTEMPTS` in `src/verification/selection.ts`). `no-data` and
    `unresolved` are provisional and retried on later runs, but only a few times: some trips never
    resolve — KVV occasionally publishes a train number on a line no feed knows — and an unbounded
    retry would re-ask on every run for the whole six-day window. `--recheck` ignores the budget.
    Trip selection (`isVerifiable`, `needsCheck`, `withAttemptCount`) lives in `selection.ts` so
    the policy is pure and unit-tested, leaving the script as orchestration.
  - **Best-effort.** Network/decode failures are counted and reported, never thrown; the script
    always exits 0 and the workflow step is `continue-on-error`. A third-party outage must never
    turn the data pipeline red — unlike `src/index.ts`'s exit codes, which flag _scraper_ gaps a
    maintainer can act on.
  - The feed answers for roughly the **last six days** (`MAX_LOOKBACK_DAYS`), and realtime
    survives that whole window, so a missed run self-heals instead of losing trips. Older trips
    are permanently unverifiable. Wire-format details (devalue encoding, mandatory browser
    `User-Agent`) live in `src/verification/`.

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
