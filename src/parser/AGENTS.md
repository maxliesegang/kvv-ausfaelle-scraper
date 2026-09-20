# Parser Agents

Guidance in this file applies to `src/parser/**`.
This is the most specific guidance for parser files.

## Scope

- Parse KVV detail-page text into structured trip cancellations.
- Compute the article-level cause via `classifyCauseWithEvidence` (`src/cause.ts`) and stamp both the `cause` and its `causeKeyword` (matched keyword, evidence) on every `Cancellation` produced from that article.
- Keep support for known format variants:
  - line-prefix trip format
  - stop/time variants
  - multiline/merged trip rows

## Vocabulary

- **row** = one line of article text (a candidate trip entry). **line** = a transit line (`S5`).
  Both meanings are unavoidable here — KVV lists one trip per row of text — so they are kept
  lexically distinct: `isValidTripRow`, `mergeTripRowsWithPositions`, `parseTripRow`, `rawRows` operate on
  text; `resolveLinesForTrip`, `mentionedLines`, `articleLine` operate on transit lines. Never
  name a text row `line`.

## Change Rules

- Every path into a detail page goes through `extractArticleRegion` (`text-extraction.ts`) before
  `stripHtml`. The site chrome around a notice is several times its length; judging it as article
  content couples every article's cause and relevance to KVV's navigation, and makes an archived
  body replay differently from the live page. `toArticleText` already does both — use it.
- A **diverted** train still runs. `isDiversionRow` keeps rerouting statements out of the
  unparsed-trip report (and therefore out of the hard-error tripwire), inspecting the following
  row because KVV writes the description there. Cancellation wording in the statement wins. The
  archive corpus audit imports the same predicate — never fork it into the test.
- **Unnumbered route rows stay unparsed.** Construction notices list trips as
  `• S8 KA Marktplatz (05:03) - Rastatt (05:38) - Gaggenau (05:51) - Freudenstadt`, with no
  Zugnummer. `isUnnumberedRouteRow` detects them so they surface as warnings, and that is
  deliberately as far as it goes: the row _shape_ is regular, but its meaning is not, and a
  `Cancellation` cannot express what the article says. Audited over the whole archive
  (33 such rows in 13 articles), the same shape carries:
  - cancellations (`100004264`, heading `Entfall Stadtbahn: der erste Zug je Richtung entfällt`);
  - **delays**, not cancellations (`100004232`, heading
    `Einschränkungen Stadtbahn: folgende Fahrten … fahren teilweise deutlich später`);
  - trips that still run but terminate early (`100004252`, `… endet am 07.08. bereits in Durlach`)
    or are merely retimed (`100004314`'s last row, `-> Zug fährt … 10 Minuten später`);
  - a non-exhaustive sample (`100004206`, `ca. jede zweite Verbindung`).

  Dating them is the harder half: these notices cover a _set_ of nights
  (`100004364`: `Nächte 11./12.09., 13./14.09. - 17./18.09. und 20./21.09. - 24./25.09.2026`),
  while a `Cancellation` carries one `date`. Picking one would invent a day KVV never named —
  the same failure `trip-dates.ts` exists to prevent. Per the rule above, leave the row
  unparsed rather than publish a guess; the workflow already skips these as `construction`.

- Prefer additive parsing improvements over breaking existing patterns.
- A corrupt value in the published text (not an unsupported layout) belongs in
  `article-corrections.ts`, which repairs the article text before parsing, scoped to one
  `detailID`. Add an entry only when an external source (GTFS) resolves the value _uniquely_ and
  the evidence is in the comment; if two readings are plausible, leave the row unparsed rather
  than publish a guess. Never correct the text archive — it stays a faithful copy of KVV's page.
- Keep regex updates paired with regression tests/fixtures.
- If relevance and parser behavior diverge, favor explicit relevance filtering over silent parser leniency.
- Name trip formats by their observable field layout and constraints, not by when KVV introduced
  them. Keep specific formats before permissive fallbacks in `TRIP_FORMATS`.
- Treat a new leading train number as a row boundary during multiline recovery; a malformed row
  must not consume the following valid row.
- KVV timestamps are Europe/Berlin wall-clock values. Trip dates are local calendar dates; `stand`
  is stored as UTC ISO time.
- Trip dating lives in `trip-dates.ts` and is a property of the **list**, not of a row: the
  article's publication timestamp dates the list, an explicit date row inside the list overrides
  it, and a late-evening → early-morning step opens an after-midnight tail. Never date a row from
  its own time being "in the past" — notices keep listing trips that have already departed, so
  that reads as tomorrow and invents cancellations on a day KVV never mentioned. Any change here
  must be checked against the whole text archive, not just fixtures.

## Required Validation

1. `npm run test:parser`
2. `npm run test:unit`
3. `npm run type-check`
4. `npm run format:check`
