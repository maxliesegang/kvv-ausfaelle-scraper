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

## Change Rules

- Prefer additive parsing improvements over breaking existing patterns.
- Keep regex updates paired with regression tests/fixtures.
- If relevance and parser behavior diverge, favor explicit relevance filtering over silent parser leniency.
- Name trip formats by their observable field layout and constraints, not by when KVV introduced
  them. Keep specific formats before permissive fallbacks in `TRIP_FORMATS`.
- Treat a new leading train number as a row boundary during multiline recovery; a malformed row
  must not consume the following valid row.
- KVV timestamps are Europe/Berlin wall-clock values. Preserve the article's local calendar date
  for trip dates while storing `stand` as UTC ISO time.

## Required Validation

1. `npm run test:parser`
2. `npm run test:unit`
3. `npm run type-check`
4. `npm run format:check`
