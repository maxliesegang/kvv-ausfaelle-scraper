# Parser Agents

Guidance in this file applies to `src/parser/**`.
This is the most specific guidance for parser files.

## Scope

- Parse KVV detail-page text into structured trip cancellations.
- Keep support for known format variants:
  - line-prefix trip format
  - stop/time variants
  - multiline/merged trip rows

## Change Rules

- Prefer additive parsing improvements over breaking existing patterns.
- Keep regex updates paired with regression tests/fixtures.
- If relevance and parser behavior diverge, favor explicit relevance filtering over silent parser leniency.

## Required Validation

1. `npm run test:parser`
2. `npm run test:unit`
3. `npm run type-check`
4. `npm run format:check`
