# Test Agents

Guidance in this file applies to `tests/**`.
This is the most specific guidance for test code.

## Test Layout

- Unit tests: `tests/unit/**`
- Integration tests: `tests/integration/**`
- Shared helpers: `tests/helpers/**`

## Expectations

- Parser and relevance logic changes should add/adjust unit tests.
- Cause classification (`src/cause.ts`) and `normalizeGermanText` umlaut handling have dedicated unit tests; update them when extending keyword lists or normalization.
- Construction-only notices are now expected to be relevant (kept, tagged `cause: 'construction'`), not filtered out.
- Keep tests deterministic and fast in `tests/unit/**`.
- `tests/unit/archive-corpus.test.ts` audits every preserved archive for GTFS-known and explicit
  train-number rows. Parser changes must keep this corpus audit green, not only fixture tests.
- `tests/unit/article-archive.test.ts` verifies byte-stable archives and HTML/archive reparse
  fidelity.
- Integration tests may be slower or interact with real files; document side effects clearly.

## Useful Commands

- `npm test`
- `npm run test:unit`
- `npm run test:parser`
- `npm run test:train-lines`
- `npm run test:integration`
