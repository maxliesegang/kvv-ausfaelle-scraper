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
- Captured feed journeys: `test-data/journeys/<journeyId>.json` — decoded bahn.expert
  `journey.detailsByJourneyId` responses, loaded by `loadJourneyFixture` for verification tests.
  They exist because the feed's encoding is what a hand-written journey literal gets wrong:
  `delay: 0` appears on stops that were never observed, `isRealTime` is set on some tracked runs
  and null on others, and a partial cancellation flags its boundary stop only on the arrival or
  departure, not on the stop. Both original verdict bugs passed a full suite of invented journeys.
  Capture new ones by calling `fetchJourneyDetails` and writing the decoded object verbatim;
  never hand-edit the stop list, since editing it back into what we expect is the failure mode
  these fixtures exist to prevent.

## Fixture Rules

- Keep article and expected file names aligned by article id/prefix.
- Expected JSON represents the partial `Cancellation` shape asserted by parser tests. Include the
  article-level `cause`; include `causeKeyword` when the fixture is intended to assert classifier
  evidence. Newly generated fixtures include both.
- Add fixtures for previously unseen parser layouts and regressions.
