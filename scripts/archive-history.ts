/**
 * Reads and replays the git history of the article text archive.
 *
 * `src/article-archive.ts` overwrites `docs/<year>/articles/<id>.txt` in place, so the working
 * tree only holds KVV's latest wording; every earlier version the scraper captured lives in git.
 * KVV's pages are rolling "still upcoming" lists, so a later version routinely drops trips that
 * have since departed. A trip the store failed to keep at the time (a parser gap then, or the
 * pruning before forward-looking reconciliation) therefore survives only in an earlier revision.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { getCancellationKey, hasDeparted } from '../src/storage.js';
import type { Cancellation } from '../src/types.js';

/** One captured version of an archive file. */
export interface ArchiveRevision {
  /** Commit time of the scraper run that wrote this version. */
  readonly capturedAtMs: number;
  readonly content: string;
}

/** One captured version of an archived article, reparsed into trips. */
export interface ReparsedArchiveRevision {
  readonly capturedAtMs: number;
  readonly trips: readonly Cancellation[];
}

/** Archive history can exceed Node's default 1 MiB child-process buffer by orders of magnitude. */
const GIT_MAX_BUFFER_BYTES = 1024 * 1024 * 1024;

function runGit(args: readonly string[], input?: string): Buffer {
  const result = spawnSync('git', args, { input, maxBuffer: GIT_MAX_BUFFER_BYTES });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

/**
 * Splits `git cat-file --batch` output into blob contents, in request order. Each object is
 * framed as `<oid> <type> <size>\n<bytes>\n`; sizes are bytes, so the stream is cut as a Buffer
 * before decoding (stop names carry multi-byte umlauts).
 */
function splitCatFileBatch(output: Buffer, objectCount: number): string[] {
  const contents: string[] = [];
  let offset = 0;
  for (let index = 0; index < objectCount; index += 1) {
    const headerEnd = output.indexOf(0x0a, offset);
    const header = output.toString('utf8', offset, headerEnd);
    const size = Number(header.split(' ')[2]);
    if (!Number.isInteger(size)) throw new Error(`Unexpected git cat-file header: ${header}`);
    contents.push(output.toString('utf8', headerEnd + 1, headerEnd + 1 + size));
    offset = headerEnd + 1 + size + 1;
  }
  return contents;
}

/**
 * Every captured version of each archive file in a directory, keyed by filename, oldest first.
 * The working-tree copy is appended when it differs from the last commit (an uncommitted
 * correction). Costs two git processes per directory, whatever the history length.
 *
 * @throws When the checkout is shallow: a truncated history would silently look complete.
 */
export function readArchiveRevisionsByFilename(
  archiveDirectory: string,
  nowMs: number,
): Map<string, ArchiveRevision[]> {
  const repositoryRoot = runGit(['rev-parse', '--show-toplevel']).toString().trim();
  if (
    runGit(['-C', repositoryRoot, 'rev-parse', '--is-shallow-repository']).toString().trim() ===
    'true'
  ) {
    throw new Error('Archive history needs the full git history: run `git fetch --unshallow`.');
  }

  // One commit per `@` header, followed by the archive paths it added, modified or renamed in.
  const directoryPath = relative(repositoryRoot, resolve(archiveDirectory));
  const log = runGit([
    '-C',
    repositoryRoot,
    'log',
    '--reverse',
    '--diff-filter=AMR',
    '--name-only',
    '--format=@%H %cI',
    '--',
    directoryPath,
  ]).toString();
  const requests: { filename: string; capturedAtMs: number; object: string }[] = [];
  let commit = '';
  let capturedAtMs = Number.NaN;
  for (const row of log.split('\n')) {
    if (row.startsWith('@')) {
      const [hash = '', committedAt = ''] = row.slice(1).split(' ');
      commit = hash;
      capturedAtMs = Date.parse(committedAt);
    } else if (row.endsWith('.txt')) {
      requests.push({ filename: basename(row), capturedAtMs, object: `${commit}:${row}` });
    }
  }

  const contents = splitCatFileBatch(
    runGit(
      ['-C', repositoryRoot, 'cat-file', '--batch'],
      requests.map(({ object }) => `${object}\n`).join(''),
    ),
    requests.length,
  );
  const revisionsByFilename = new Map<string, ArchiveRevision[]>();
  requests.forEach(({ filename, capturedAtMs }, index) => {
    const revisions = revisionsByFilename.get(filename) ?? [];
    revisions.push({ capturedAtMs, content: contents[index] ?? '' });
    revisionsByFilename.set(filename, revisions);
  });

  for (const [filename, revisions] of revisionsByFilename) {
    let workingTreeContent: string;
    try {
      workingTreeContent = readFileSync(resolve(archiveDirectory, filename), 'utf8');
    } catch {
      continue; // moved to another Fahrplan year since; that directory replays it
    }
    if (revisions.at(-1)?.content !== workingTreeContent) {
      revisions.push({ capturedAtMs: nowMs, content: workingTreeContent });
    }
  }
  return revisionsByFilename;
}

/**
 * The trips an article's successive versions establish, replayed with the live store's rules.
 *
 * Applies `reconcileBucket`'s rule version by version: a trip a later version no longer lists is
 * a retraction only while it had not yet departed when that version was captured; a departed
 * trip stands. A later listing of the same trip replaces its fields, so KVV's corrections win.
 * Every archived version already passed the live one-hour age gate (`processRssItem` archives
 * only old-enough notices), so each is a version the scraper adopted, never a provisional one.
 *
 * Pass only versions that parsed: a version without trip rows is no evidence of a retraction,
 * just as the live store does not prune an article whose refetch yields no trips.
 */
export function replayArticleRevisions(
  revisions: readonly ReparsedArchiveRevision[],
): Cancellation[] {
  const tripsByKey = new Map<string, Cancellation>();
  const chronologicalRevisions = [...revisions].sort((a, b) => a.capturedAtMs - b.capturedAtMs);
  for (const { capturedAtMs, trips } of chronologicalRevisions) {
    const listedKeys = new Set(trips.map(getCancellationKey));
    for (const [key, trip] of tripsByKey) {
      if (!listedKeys.has(key) && !hasDeparted(trip, capturedAtMs)) tripsByKey.delete(key);
    }
    for (const trip of trips) tripsByKey.set(getCancellationKey(trip), trip);
  }
  return [...tripsByKey.values()];
}
