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
