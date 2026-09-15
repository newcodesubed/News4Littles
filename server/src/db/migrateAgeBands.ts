/**
 * One-off migration from one-version-per-age to one-version-per-band.
 *
 * Before AGE_BANDS a story held up to ten kid_articles rows, one per age 5-14
 * (or, earlier still, a single row at whatever the default age was). Reads now
 * match a band's anchor exactly, so in every band a story has rows for, this
 * keeps ONE row — the one already at the anchor, else the youngest — moves it
 * onto the anchor, and deletes the rest. The same re-keying is applied to the
 * per-age prompt overrides and drafts. prompt_versions is append-only history
 * and is left alone.
 *
 * Deleting versions is the whole point, so the CLI runs dry by default and
 * writes only with --apply. Every write happens in one transaction.
 */
import type { Database } from 'better-sqlite3';
import { AGE_BAND_ANCHORS, bandForAge, isAgeBandAnchor } from '../core/article.js';
import { createSettingsRepository } from './repositories/settingsRepository.js';

export interface AgeBandMigrationReport {
  /** Stories that had at least one row to move or delete. */
  storiesChanged: number;
  /** Rows re-labelled from a non-anchor age to their band's anchor. */
  rowsMoved: { id: string; from: number; to: number }[];
  /** Surplus rows in a band that already had a keeper. */
  rowsDeleted: { id: string; originalId: string; ageTarget: number }[];
  /** Prompt overrides re-keyed from an age to its band's anchor. */
  overridesMoved: { from: string; to: string }[];
  /** Overrides whose band already had one at the anchor. The text is lost. */
  overridesDropped: string[];
  draftsMoved: { from: number; to: number }[];
  draftsDropped: number[];
}

interface VersionRow { id: string; originalId: string; ageTarget: number }
interface DraftRow { target: string; age: number }

/** Plan the migration, and apply it only when asked. Always returns the plan. */
export function migrateAgeBands(db: Database, options: { apply: boolean }): AgeBandMigrationReport {
  const report: AgeBandMigrationReport = {
    storiesChanged: 0,
    rowsMoved: [], rowsDeleted: [],
    overridesMoved: [], overridesDropped: [],
    draftsMoved: [], draftsDropped: [],
  };

  // --- kid_articles ---------------------------------------------------------
  // Ascending by ageTarget within a story, so the first row seen per band is
  // the youngest — and an anchor row, being the youngest possible, comes first.
  const rows = db.prepare(
    `SELECT id, originalId, ageTarget FROM kid_articles ORDER BY originalId, ageTarget, id`,
  ).all() as VersionRow[];

  const keepers = new Map<string, VersionRow>();
  const changedStories = new Set<string>();
  for (const row of rows) {
    const anchor = bandForAge(row.ageTarget).minAge;
    const key = `${row.originalId}:${anchor}`;
    if (keepers.has(key)) {
      report.rowsDeleted.push(row);
      changedStories.add(row.originalId);
      continue;
    }
    keepers.set(key, row);
    if (row.ageTarget !== anchor) {
      report.rowsMoved.push({ id: row.id, from: row.ageTarget, to: anchor });
      changedStories.add(row.originalId);
    }
  }
  report.storiesChanged = changedStories.size;

  // --- prompt overrides ----------------------------------------------------
  const settings = createSettingsRepository(db);
  const config = settings.getPromptConfig();
  const overrides: Record<string, string> = {};
  // Anchors first, so an existing anchor override always wins over a re-key.
  const keys = Object.keys(config.ageOverrides)
    .sort((a, b) => Number(isAgeBandAnchor(Number(b))) - Number(isAgeBandAnchor(Number(a))));
  for (const key of keys) {
    const age = Number(key);
    const to = String(bandForAge(age).minAge);
    if (key === to) {
      overrides[key] = config.ageOverrides[key]!;
    } else if (overrides[to] === undefined) {
      overrides[to] = config.ageOverrides[key]!;
      report.overridesMoved.push({ from: key, to });
    } else {
      report.overridesDropped.push(key);
    }
  }

  // --- prompt drafts -------------------------------------------------------
  const drafts = db.prepare(
    `SELECT target, age FROM prompt_drafts WHERE age IS NOT NULL ORDER BY target, age`,
  ).all() as DraftRow[];
  const draftAnchorsTaken = new Set(
    drafts.filter((d) => isAgeBandAnchor(d.age)).map((d) => `${d.target}:${d.age}`),
  );
  // The report counts ages, but a draft is identified by target AND age, so
  // the writes are planned separately — otherwise re-keying an age would hit
  // every target holding it.
  const draftMoves: { target: string; from: number; to: number }[] = [];
  const draftDrops: { target: string; age: number }[] = [];
  for (const draft of drafts) {
    if (isAgeBandAnchor(draft.age)) continue;
    const to = bandForAge(draft.age).minAge;
    const key = `${draft.target}:${to}`;
    if (draftAnchorsTaken.has(key)) {
      report.draftsDropped.push(draft.age);
      draftDrops.push({ target: draft.target, age: draft.age });
    } else {
      draftAnchorsTaken.add(key);
      report.draftsMoved.push({ from: draft.age, to });
      draftMoves.push({ target: draft.target, from: draft.age, to });
    }
  }

  if (!options.apply) return report;

  db.transaction(() => {
    const move = db.prepare(`UPDATE kid_articles SET ageTarget = @to WHERE id = @id`);
    const remove = db.prepare(`DELETE FROM kid_articles WHERE id = ?`);
    // Deletes before moves: a move could otherwise briefly duplicate a
    // (story, anchor) pair, and nothing should observe that even mid-transaction.
    for (const row of report.rowsDeleted) remove.run(row.id);
    for (const row of report.rowsMoved) move.run(row);

    if (report.overridesMoved.length > 0 || report.overridesDropped.length > 0) {
      settings.savePromptConfig(
        { genericPrompt: config.genericPrompt, ageOverrides: overrides },
        new Date().toISOString(),
      );
    }

    const dropDraft = db.prepare(`DELETE FROM prompt_drafts WHERE target = @target AND age = @age`);
    const moveDraft = db.prepare(`UPDATE prompt_drafts SET age = @to WHERE target = @target AND age = @from`);
    for (const draft of draftDrops) dropDraft.run(draft);
    for (const draft of draftMoves) moveDraft.run(draft);
  })();

  return report;
}

/** The anchors, for the CLI's summary line. */
export const ANCHOR_LIST = AGE_BAND_ANCHORS.join(', ');
