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
    `journeyStops` / `journeyCancelledStops` / `journeyTrackedStops` for the whole run.
    `trackedOutsideSegment` retains the exact control evidence behind an inferred cancellation.
    These make a segment count readable and auditable after the short-lived feed expires.
  - **The record carries only what is read or unrecoverable.** Verification is stamped on every
    departed trip, so a field costing a few bytes costs them ~1800 times per Fahrplan year and in
    every commit diff. Fields are dropped when nothing reads them and they can be re-derived
    (`journeyId` pointed into a feed that forgets after seven days, so it is a dead pointer before
    anyone could follow it), stored only when anomalous when their whole
    purpose is spotting the exception (`feedLine`, `feedOperator`), and stored only while live when
    they are run bookkeeping (`attempts`, provisional verdicts only). `checkedAt` is a Berlin-local
    **date**: everything it guards is measured in days. The counts stay in full — they decide the
    verdict, and the feed cannot be asked again once the window closes.
  - **`source` is the deliberate exception to that rule.** It is a constant today (`bahn.expert`,
    the `VerificationSource` union in `src/verification/verify.ts`) and is stored anyway, because
    provenance is the one thing about a verdict that cannot be recovered afterwards. A trip the
    feed never observed — `S5 84957 2026-08-13` carries realtime on none of its 39 stops — is
    permanently unverifiable _by that feed_, and if a second source is ever added its answer must
    be distinguishable from this one rather than silently replacing it. Stamping provenance from
    the start keeps published records comparable across that change instead of splitting them into
    a before and an after. It is **not** a confidence ranking: `retainStrongerVerdict` compares
    observed stops, and comparing counts across feeds that watch different things would need its
    own rule, never an implicit preference for whichever source ran last.
  - **Advisory only.** It writes `verification` and nothing else. A stored cancellation means
    "KVV announced this trip would not run", which stays true whatever the train did;
    verification adds the separate fact "it did / did not actually run". The disagreement
    between the two is the signal, so this must never prune or rewrite trip identity — that
    would collapse two datasets into one and destroy the thing worth measuring.
  - **Segment scoping is the core rule.** A notice names the _affected segment_ of a longer run
    (`20019 Ittersbach Rathaus (09:21) - Ettlingen Stadt (09:45)` is one leg of a journey
    continuing to 10:31), so verdicts are computed over `fromTime` → `toStop` only. Judging the
    whole journey reports "ran" for trips whose announced leg was never served. Both endpoints
    are located by normalized stop name first and scheduled time second. Time alone is never
    identity on dense Stadtbahn corridors: several adjacent stops can fall inside a two-minute
    tolerance, while KVV's endpoint time can itself differ from the feed by ten minutes or more.
    The stop matcher normalizes `KA`/`Karlsruhe`, station and street abbreviations, distinctive
    terminal street names behind locality/district prefixes, and one-character source typos.
    Names are strong evidence but not an absolute gate: when they fail, an exact train/date/operator
    may still resolve through one unique ordered pair of endpoint times within two minutes. A
    name-confirmed pair normally allows 15 minutes; one endpoint may differ by up to 30 minutes only
    when both names are strong and the other time is within two minutes. Boundary evidence is
    directional: only departure
    belongs to the origin and only arrival to the destination, so adjacent legs cannot manufacture
    tracking or cancellation inside the announced segment.
  - **Unresolved segments retain safe journey evidence.** If no segment pair survives, a candidate
    on the exact stored line with the exact train number, service date, and AVG operator may still
    contribute whole-journey cancellation/tracking counts. Its status stays `unresolved` unless
    the source explicitly marks the entire journey cancelled; that statement necessarily covers
    every segment even when malformed notice times hide its bounds. Segment counts stay zero, and
    `trackedOutsideSegment` stays zero because no stop can honestly be placed inside or outside
    unknown bounds. This deliberately excludes line aliases: without endpoint confirmation, an S5
    response must not become evidence for an unrelated S4 notice typo.
  - **A propagated delay forecast is not an observation.** Tracking is read from `isRealTime`, and
    where the feed leaves that flag null a time deviating from the schedule stands in for it — some
    genuinely observed runs report nothing else. But a run the feed only knows to be _late_ gets one
    delay applied to every remaining stop, and every one of those times then deviates without the
    train having been seen anywhere. So `isRealTime` is authoritative **wherever the feed uses it at
    all**: on a journey carrying the flag anywhere, its absence on a stop is an answer, not a gap to
    paper over. The fallback applies only to journeys with no flag on any event, and then only when
    the deviations resolve to more than one delay value — several delays are a vehicle being
    watched, one restated number is a forecast. Two shapes were being read as tracking, and both
    published `ran`: the whole-journey forecast (`20260822-604a4ebb`, `20260822-82743995`,
    `20260822-d6b912ae` — the Freudenstadt shuttle, `delay: 59` throughout, `lastKnownPosition`
    empty, on a day KVV had announced the whole S8 cancelled for lack of staff), and the forecast
    _tail_ that follows a journey's last real sighting (`20260822-d413a3fe` flags eleven events from
    Rastatt onward and leaves the announced Forbach → Rastatt leg on a flat `delay: 41`). `ran` is
    the strongest claim this classifier makes and the one a forecast most easily manufactures, since
    a forecast covers _every_ stop and so always reads as a fully tracked segment.
  - **Absence of realtime is not evidence of cancellation.** A segment with no realtime counts as
    cancelled only when the _rest of the same run_ was tracked, which proves the feed had
    coverage; otherwise the verdict is `no-data`. `partial`, `no-data`, and `unresolved` are
    re-checked on later Berlin calendar days; `cancelled` and `ran` are settled.
    A trip first becomes eligible only after the announced segment's arrival plus the settling
    grace period, not after departure; otherwise a long trip is necessarily read mid-run and can
    be settled from incomplete evidence.
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
  - **The operator is the key the line only pretends to be** (`matchesNetworkOperator` in
    `src/verification/verify.ts`). A Zugnummer is reused across Europe — 20019 returns eleven
    journeys spanning VIAS at Arnhem, ÖBB near Vienna, a Nuremberg U-Bahn and buses in Leipzig,
    Worms and Losheim — and identity is otherwise confirmed only by finding _a stop_ at the
    announced date and time (±2 min), which an unrelated all-day service satisfies by coincidence:
    `S7 85586 2026-08-13 19:55 Achern → Karlsruhe Hbf` was verified against an SNCF Rennes → Brest
    run and published as `no-data`. A journey whose operator is named and is not AVG is rejected,
    and the caller falls through to the next candidate — which is how that trip then found its
    real run (feed line `S71`, segment fully cancelled). Match on what the feed actually _says_ —
    `train.operator` (`Albtal…`) and `administration.operatorCode` (`AVG`) — with the opaque
    `train.admin` ID (`A6`, `A6S1`, `A6S11`) only corroborating and matched exactly, never by
    prefix, which would accept an unrelated `A60`. A journey naming **no** operator is accepted;
    silence is not evidence of a foreign train. Note `journey.find` omits the operator entirely,
    so this confirms a candidate _after_ its details arrive and cannot pre-filter the list.
    The operator behind a verdict is stored as `feedOperator` **only when it is not the network
    operator**, so auditing which train answered is a grep rather than a re-fetch of every journey —
    and a hit _is_ the anomaly instead of something to filter down to. Same present-means-unusual
    rule as `feedLine`; a rejected foreign journey never reaches the field, so what it catches is the
    mixed response whose `train.operator` is unexpected but whose segment-level tokens vouched for
    it. Operator evidence is scoped to the announced segment: KVV has unrelated S6 corridors run by
    AVG and DB, and a through journey can change operators, so neither the line text nor an AVG leg
    elsewhere in the journey may vouch for the affected segment.
  - **Retries are bounded and date-spaced** (`MAX_ATTEMPTS` in
    `src/verification/selection.ts`). `partial`, `no-data`, and `unresolved` are provisional and
    retried at most once per Berlin calendar day, but only a few times: some trips never resolve —
    KVV occasionally publishes a train number on a line no feed knows — and an unbounded retry
    would re-ask throughout the seven-day window. Date spacing is load-bearing with the four-hour
    workflow schedule: without it, a trip spends all three attempts in eight hours and cannot
    benefit from next-day realtime. `--recheck` ignores both spacing and budget. An older
    `methodVersion` is also rechecked once regardless of status or spent budget, so matcher fixes
    reach still-live historical records without requiring a manual migration. Once written, the
    current version switches that path off. A recheck that retains stronger stored evidence still
    refreshes `checkedAt`; otherwise later workflow runs on the same day consume the remaining
    attempt budget immediately. Trip selection
    (`isVerifiable`, `needsCheck`, `withAttemptCount`) lives in `selection.ts` so the policy is pure
    and unit-tested, leaving the script as orchestration.
  - **Evidence only ratchets up** (`retainStrongerVerdict` in `src/verification/selection.ts`).
    bahn.expert thins realtime detail out of a journey as the day recedes, so a re-check can see
    strictly less than the first check did and the same trip re-reads as less served — measured on
    2026-08-13, where a next-morning recheck turned four `ran` verdicts into `no-data`/`partial`.
    Explicit cancellation flags are compared first and tracked stops second: new cancellation
    flags always win, removed flags never erase stronger stored evidence, and tracking is compared
    only when cancellation evidence is equal. A fresh unresolved lookup cannot erase a located
    segment. Changed non-zero segment denominators are accepted as corrected scope rather than
    compared as if their raw counts described the same stops. A retained result is logged as
    `= kept` like `storage.ts` logs its retentions. The attempt count is bumped either way, so a
    permanently decaying trip is not re-asked forever.
    `methodVersion` makes deliberate classifier migrations possible: a newer method can replace
    old evidence during `--recheck`, including an explicit `journey-mismatch`, while a mere
    `journey-not-found` cannot erase a segment the expiring feed previously resolved. A newer
    method may also revise its _tracking_ downwards, because tracking is this classifier's own
    inference from the feed's timestamps — without that, the ratchet reads a correction as decay
    and preserves precisely the verdicts the new version exists to withdraw. Cancellation flags are
    never revised this way: those are the feed's own statements and ratchet up across every version.
  - **An absent journey is not a failed match.** `journey-not-in-network` means the feed returned
    journeys carrying that number but none of them is an AVG run — a Zugnummer is reused freely, and
    `S8 85610 2026-08-22` returns exactly one journey, a Köln tram. Nothing about the matching can
    be improved there. `journey-mismatch` is the actionable one: the AVG journey _was_ identified
    and the announced segment could not be located inside it, so KVV's endpoint names or times and
    the feed's stop list disagree. Collapsing the two makes the reason unactionable — half the
    stored `journey-mismatch` records were absent journeys. Unresolved verdicts that reached a
    journey record its `journeyId`, so even a verdict that concluded nothing says what from.
  - **Best-effort.** Network/decode failures are counted and reported, never thrown; the script
    always exits 0 and the workflow step is `continue-on-error`. A third-party outage must never
    turn the data pipeline red — unlike `src/index.ts`'s exit codes, which flag _scraper_ gaps a
    maintainer can act on.
  - The feed answers for a rolling **seven days** (`MAX_LOOKBACK_DAYS`), and realtime survives that
    whole window, so a missed run self-heals instead of losing trips. The cutoff was measured at
    the instant level: a request exactly seven days old worked while one two hours older returned 400. Older trips are permanently unverifiable. Wire-format details (devalue encoding,
    mandatory browser `User-Agent`) live in `src/verification/`.

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
