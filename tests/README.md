# Test Guide

Tests use Node.js's built-in `node:test` runner and `node:assert`. TypeScript runs directly
through `tsx`.

## Commands

```bash
npm test
npm run test:unit
npm run test:integration
npm run test:parser
npm run test:train-lines
npm run test:watch
npm run test:coverage
```

## Organization

```text
tests/
├── unit/
│   ├── archive-corpus.test.ts
│   ├── archive-regressions.test.ts
│   ├── article-archive.test.ts
│   ├── cause.test.ts
│   ├── normalization.test.ts
│   ├── parser.test.ts
│   ├── relevance.test.ts
│   ├── seed-train-lines.test.ts
│   ├── site-index.test.ts
│   ├── storage.test.ts
│   └── train-lines.test.ts
├── integration/
└── helpers/
    ├── fixture-loader.ts
    └── test-utils.ts
```

Unit tests are deterministic and do not use the network. Some filesystem-oriented unit tests use
temporary directories or read committed repository fixtures; they must not mutate published
`docs/` data.

## Parser coverage

`parser.test.ts` loads matching HTML and expected JSON from `test-data/`. New parser syntax should
have a focused regression assertion or real fixture.

`article-archive.test.ts` verifies:

- stable archive paths and content;
- safe article identifiers;
- HTML/archive reparse fidelity.

`archive-corpus.test.ts` scans committed article archives under `docs/<fahrplan-year>/articles/`
and verifies that:

- every occurrence of a GTFS-known train number is represented in parsed output;
- every explicit numbered trip row is parsed, including numbers absent from GTFS.

This corpus audit is intentionally broader than the curated HTML fixture suite.

`archive-regressions.test.ts` uses selected committed archives for focused assertions that the
corpus audit cannot make reliably, such as exact stop names, line resolution, classification,
article metadata, cancellation counts, and false-positive boundaries. Prefer one of these focused
tests when the real notice is already archived; do not copy the same input into `test-data/`.

## Shared helpers

- `loadFixture(name)` loads one HTML/expected-JSON pair.
- `loadAllFixtures()` discovers all matching pairs.
- `loadArchivedArticle(year, id)` loads a committed text archive and its source URL.
- `assertCancellationsEqual(actual, expected, message?)` normalizes runtime-only fields before
  comparing records.
- `assertThrows(fn, pattern, message?)` checks expected parser failures.
- `assertSorted(array, comparator, message?)` verifies deterministic ordering.

## Adding a parser regression

When the notice already exists under `docs/<fahrplan-year>/articles/`, add a focused assertion to
`archive-regressions.test.ts` and load it with `loadArchivedArticle(year, id)`.

Create an HTML fixture only when the regression depends on source markup or the live notice has not
entered the committed archive:

```bash
npm run fetch-html-fixture -- "https://www.kvv.de/fahrplan/verkehrsmeldungen.html?..."
```

For an HTML fixture:

1. Review the saved HTML under `test-data/articles/`.
2. Review the matching expected JSON under `test-data/expected/`.
3. Ensure `cause` and `causeKeyword` reflect the article-level classification.
4. Run `npm run test:parser` and `npm run test:unit`.

See [../test-data/README.md](../test-data/README.md) for the fixture contract.

## Expectations

- Keep unit tests deterministic, fast, and independent.
- Test public behavior and domain invariants instead of private implementation details.
- Use descriptive domain terminology: article, trip, cancellation, classification, and Fahrplan
  year.
- Add a regression test whenever a parser pattern or cause rule changes.
- Document any integration-test side effects.
