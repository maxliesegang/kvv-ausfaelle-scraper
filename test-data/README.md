# Parser Fixtures

This directory contains preserved KVV detail-page HTML and the structured cancellations expected
from the parser.

```text
test-data/
├── articles/
│   └── <fixture-name>.html
└── expected/
    └── <fixture-name>.json
```

HTML and expected JSON filenames must share the same stem. The test loader discovers matching
pairs automatically.

## Covered article shapes

The fixture corpus includes:

- stop-then-time rows, with required or optional parentheses;
- time-then-stop rows;
- line-prefixed and multi-line notices;
- `ab`/`bis`/`an` wording and prose `entfällt zwischen` wording;
- multiline rows and narrowly tolerated source typos;
- alternative article timestamps and section markers;
- real KVV notices used for regression coverage.

Some older fixture labels use `old-format`, `new-format`, or `mixed-format`. These are historical
filenames only. Parser code names formats by their observable field layout and constraints.

## Expected cancellation shape

Expected files contain arrays of partial `Cancellation` records:

```json
[
  {
    "line": "S4",
    "date": "2025-11-11",
    "stand": "2025-11-11T13:30:45.000Z",
    "trainNumber": "84882",
    "fromStop": "Karlsruhe Hbf",
    "fromTime": "08:07",
    "toStop": "Achern",
    "toTime": "09:01",
    "cause": "operational",
    "causeKeyword": "betriebsbedingt"
  }
]
```

`sourceUrl` and `capturedAt` are runtime-dependent and are omitted from expected JSON. Include
`cause` in every new fixture. The fetch helper also includes `causeKeyword`; older fixtures may
omit it because expected records are partial. Keep `causeKeyword` whenever classifier evidence is
part of the regression being tested.

`stand` is stored as a UTC ISO timestamp. `date` remains the Europe/Berlin article date even when
the UTC representation falls on the preceding calendar day.

## Adding a fixture

```bash
npm run fetch-article -- "https://www.kvv.de/fahrplan/verkehrsmeldungen.html?..."
```

Review both generated files before committing them:

1. Keep the original source HTML realistic and complete enough to preserve the regression.
2. Verify every parsed trip and its line resolution.
3. Verify the Fahrplan-year-independent trip date, UTC `stand`, `cause`, and `causeKeyword`.
4. Run `npm run test:parser` and `npm run test:unit`.

When creating files manually, use a descriptive shared filename stem and preserve the same
contract.
