# Test Article Repository

This directory contains test articles for validating the parser against different HTML variations encountered in KVV cancellation pages.

## Directory Structure

```
test-data/
├── articles/          # HTML files representing different article variations
│   ├── article-1-old-format.html
│   ├── article-2-new-format.html
│   ├── article-3-mixed-format.html
│   ├── article-4-alternative-marker.html
│   ├── article-5-real-s5-256933.html
│   └── article-6-real-s51-256942.html
├── expected/          # Expected parser output (JSON) for each article
│   ├── article-1-old-format.json
│   ├── article-2-new-format.json
│   ├── article-3-mixed-format.json
│   ├── article-4-alternative-marker.json
│   ├── article-5-real-s5-256933.json
│   └── article-6-real-s51-256942.json
└── README.md          # This file
```

## Test Article Variations

### 1. Old Format (`article-1-old-format.html`)

Tests the older trip format where times appear in parentheses after stop names:

```
84882 Karlsruhe Hbf (08:07 Uhr) - Achern (09:01 Uhr)
```

**Pattern:** `<trainNumber> <fromStop> (<time>) - <toStop> (<time>)`

### 2. New Format (`article-2-new-format.html`)

Tests the newer trip format where times appear before stop names:

```
84888 08:38 Uhr Söllingen Bahnhof - 10:07 Uhr Germersheim Bahnhof
```

**Pattern:** `<trainNumber> <time> Uhr <fromStop> - <time> Uhr <toStop>`

### 3. Mixed Format (`article-3-mixed-format.html`)

Tests a combination of both old and new formats within the same article, and variations with/without "Uhr":

```
11234 Hochstetten (14:22) - Karlsruhe Marktplatz (14:58 Uhr)
11235 15:30 Karlsruhe Marktplatz - 16:06 Uhr Hochstetten
```

### 4. Alternative Marker (`article-4-alternative-marker.html`)

Tests the alternative section marker "Betroffene Fahrten:" instead of "sind folgende Fahrten betroffen:"

**Markers tested:**

- Primary: `sind folgende Fahrten betroffen:`
- Alternative: `Betroffene Fahrten:`

### 5. Real Article - S5 (`article-5-real-s5-256933.html`)

**Real production article** from KVV website (ID: Nettro_CMS_256933) testing:

- Old trip format in production use
- Alternative date format: `DD.MM.YYYY, HH:MM Uhr` (without seconds)
- 8 cancelled trips on Line S5
- Published: 12.11.2025, 00:55 Uhr

### 6. Real Article - S51 (`article-6-real-s51-256942.html`)

**Real production article** from KVV website (ID: Nettro_CMS_256942) testing:

- Old trip format in production use
- Alternative date format: `DD.MM.YYYY, HH:MM Uhr` (without seconds)
- 2 cancelled trips on Line S51
- Published: 12.11.2025, 00:56 Uhr

## Adding New Test Articles

When you discover a new variation in the wild that isn't covered:

1. **Create HTML file** in `articles/`:
   - Use descriptive filename (e.g., `article-5-description.html`)
   - Include complete HTML structure
   - Ensure it contains the variation you want to test

2. **Create expected output** in `expected/`:
   - Use matching filename (e.g., `article-5-description.json`)
   - Format as JSON array of Cancellation objects
   - Do NOT include `sourceUrl` or `capturedAt` (these are dynamic)

3. **Expected JSON structure**:

   ```json
   [
     {
       "line": "S4",
       "date": "2025-11-11",
       "stand": "2025-11-11T14:30:45.000Z",
       "trainNumber": "84882",
       "fromStop": "Karlsruhe Hbf",
       "fromTime": "08:07",
       "toStop": "Achern",
       "toTime": "09:01"
     }
   ]
   ```

4. **Run tests**:
   ```bash
   npm run test:parser
   ```

## Running Tests

Use the test runner to validate all articles:

```bash
npm run test:parser
```

The test runner will:

- Parse each HTML file in `articles/`
- Compare results against expected JSON in `expected/`
- Report any mismatches or parsing failures
- Show coverage of different format variations

## Notes

- The test data uses future dates to avoid confusion with real data
- `sourceUrl` and `capturedAt` fields are excluded from expected JSON as they're runtime-dependent
- Tests focus on parser logic, not network or RSS feed fetching
- Keep HTML examples realistic to actual KVV website structure
