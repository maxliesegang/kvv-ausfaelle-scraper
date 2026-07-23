# Testing

The project uses Node.js's built-in test runner with TypeScript loaded through `tsx`.

```bash
npm test                  # all tests
npm run test:unit         # unit suite
npm run test:integration  # integration suite
npm run test:parser       # parser fixtures and regressions
npm run test:train-lines  # train-number/line resolution
npm run test:watch        # watch mode
npm run test:coverage     # c8 coverage report
```

The unit suite covers:

- real-world parser fixtures and hardened format variants;
- preserved-article corpus auditing;
- stable article archives and HTML/archive reparse fidelity;
- cause classification and normalized evidence keywords;
- relevance, storage reconciliation, and site-index generation;
- Fahrplan-year train-line definitions, timing disambiguation, and GTFS seeding;
- text and identifier normalization.

See [tests/README.md](tests/README.md) for test structure and conventions. Parser fixtures live
under `test-data/`; see [test-data/README.md](test-data/README.md).
