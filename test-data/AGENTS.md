# Fixture Data Agents

Guidance in this file applies to `test-data/**`.
This is the most specific guidance for parser fixtures.

## Structure

- HTML fixtures: `test-data/articles/`
- Expected parser output: `test-data/expected/`
- Pinned article archives: `test-data/archives/` — frozen copies of `docs/<year>/articles/<id>.txt`
  for regressions that assert specific trip rows. `docs/` is mutable: KVV rewrites a notice in
  place and drops rows as they depart, so a regression written against today's roster can go red
  tomorrow with no code change. Pin the revision under test straight out of the archive's git
  history (`git show <commit>:docs/<year>/articles/<id>.txt > test-data/archives/<id>.txt`);
  `loadRegressionArticle` prefers the pinned copy and falls back to `docs/`. Corpus-wide audits
  keep reading the live archive on purpose — they assert properties that must hold for whatever
  KVV publishes.

## Fixture Rules

- Keep article and expected file names aligned by article id/prefix.
- Expected JSON represents the partial `Cancellation` shape asserted by parser tests. Include the
  article-level `cause`; include `causeKeyword` when the fixture is intended to assert classifier
  evidence. Newly generated fixtures include both.
- Add fixtures for previously unseen parser layouts and regressions.
