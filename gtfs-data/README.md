# GTFS drop folder

Put a GTFS `.zip` named **`latest.zip`** in this folder, then run:

```bash
npm run seed-train-lines              # reads gtfs-data/latest.zip, overwrites the year's files
npm run seed-train-lines -- --dry-run # preview without writing
```

Seeded files are the pure GTFS train-number lists (a number is kept on every line GTFS
runs it on). Disambiguation and the small `src/train-line-definitions/overrides.ts`
escape hatch are applied at lookup time, not baked into the files.

Pass an explicit path to use a different file:

```bash
npm run seed-train-lines -- some-other-feed.zip
```

The zip itself is git-ignored (it is large and licensed) — only this README and
`.gitignore` are tracked.

## Where to get the feed (use this one)

**NVBW "Fahrplandaten ohne Liniennetz" (Baden-Württemberg open data)** — the verified
feed whose `trips.txt` actually carries `trip_short_name` (Zugnummern) for the Karlsruhe
S-Bahn. Direct download, no registration:

<https://www.nvbw.de/fileadmin/user_upload/service/open_data/fahrplandaten_ohne_liniennetz/bw_rp_sl.zip>

- License: Datenlizenz Deutschland – Namensnennung 2.0, ~80 MB.
- The Karlsruhe S-Bahn is operated by AVG (`Albtal-Verkehrs-Gesellschaft`) and VBK
  (`Verkehrsbetriebe Karlsruhe`); the seeding script's default `--agency` filter picks
  these out and excludes the many same-named S-lines from Stuttgart, SBB, etc.

## Feeds that do NOT work (verified — they drop train numbers)

- gtfs.de "Regional Rail" de_rv (free tier) — `trips.txt` has no `trip_short_name`.
- DELFI nationwide GTFS — same, no `trip_short_name`.
- KVV's own EFA GTFS (`projekte.kvv-efa.de`) — no `trip_short_name`.

See `scripts/seed-train-lines-from-gtfs.ts` for all flags.
