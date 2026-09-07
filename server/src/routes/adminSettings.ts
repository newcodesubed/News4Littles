/**
 * Admin settings API — PRD §4.4, §5.1, §6, §8.5, §8.7.
 *
 * NO LLM calls. The translation-prompt and prompt-guard fields are stored and
 * returned, but nothing reads them yet — that arrives with §9.1.
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';

const TRUST_LEVELS = ['high', 'medium', 'low'] as const;

class BadRequest extends Error {}
class Conflict extends Error {}

/** Source slugs are used in URLs and in the review-queue filter. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseJsonColumn<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function createAdminSettingsRouter(db: Database): Router {
  const router = Router();

  const handle = (fn: () => void, res: import('express').Response) => {
    try {
      fn();
    } catch (error: unknown) {
      if (error instanceof BadRequest) res.status(400).json({ error: error.message });
      else if (error instanceof Conflict) res.status(409).json({ error: error.message });
      else throw error;
    }
  };

  // ─── §5.1 sources CRUD ──────────────────────────────────────────────────
  const selectSources = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM raw_articles r WHERE r.sourceId = s.id) AS articleCount
    FROM sources s ORDER BY s.name`);

  router.get('/sources', (_req, res) => {
    res.json(
      (selectSources.all() as Record<string, unknown>[]).map((row) => ({
        ...row,
        enabled: row.enabled === 1,
      })),
    );
  });

  router.post('/sources', (req, res) =>
    handle(() => {
      const body = (req.body ?? {}) as Record<string, unknown>;

      const id = String(body.id ?? '').trim().toLowerCase();
      if (!SLUG.test(id)) {
        throw new BadRequest('id must be a slug: lowercase letters, digits and hyphens.');
      }
      if (db.prepare(`SELECT 1 FROM sources WHERE id = ?`).get(id)) {
        throw new Conflict(`A source with id '${id}' already exists.`);
      }

      const name = String(body.name ?? '').trim();
      if (!name) throw new BadRequest('name is required.');

      const trustLevel = String(body.trustLevel ?? 'high');
      if (!TRUST_LEVELS.includes(trustLevel as (typeof TRUST_LEVELS)[number])) {
        throw new BadRequest(`trustLevel must be one of: ${TRUST_LEVELS.join(', ')}.`);
      }

      const url = String(body.url ?? '').trim();
      const enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;
      // A source cannot be scraped without a feed URL.
      if (enabled === 1 && !url) throw new BadRequest('An enabled source needs a feed URL.');

      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO sources (id, name, url, enabled, trustLevel, parser, createdAt, updatedAt)
         VALUES (@id, @name, @url, @enabled, @trustLevel, @parser, @now, @now)`,
      ).run({
        id,
        name,
        url,
        enabled,
        trustLevel,
        parser: typeof body.parser === 'string' && body.parser.trim() ? body.parser.trim() : null,
        now,
      });

      res.status(201).json({ id });
    }, res));

  router.patch('/sources/:id', (req, res) =>
    handle(() => {
      const existing = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(req.params.id) as
        | { url: string; enabled: number }
        | undefined;
      if (!existing) {
        res.status(404).json({ error: `No source with id '${req.params.id}'.` });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const sets: string[] = [];
      const params: Record<string, string | number | null> = { id: req.params.id };

      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) throw new BadRequest('name cannot be empty.');
        sets.push('name = @name');
        params.name = name;
      }

      if (body.url !== undefined) {
        sets.push('url = @url');
        params.url = String(body.url).trim();
      }

      if (body.trustLevel !== undefined) {
        const value = String(body.trustLevel);
        if (!TRUST_LEVELS.includes(value as (typeof TRUST_LEVELS)[number])) {
          throw new BadRequest(`trustLevel must be one of: ${TRUST_LEVELS.join(', ')}.`);
        }
        sets.push('trustLevel = @trustLevel');
        params.trustLevel = value;
      }

      if (body.parser !== undefined) {
        const value = body.parser === null ? null : String(body.parser).trim();
        sets.push('parser = @parser');
        params.parser = value || null;
      }

      if (body.enabled !== undefined) {
        const enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;
        const url = params.url !== undefined ? String(params.url) : existing.url;
        if (enabled === 1 && !url) throw new BadRequest('An enabled source needs a feed URL.');
        sets.push('enabled = @enabled');
        params.enabled = enabled;
      }

      if (sets.length === 0) throw new BadRequest('No fields to update.');

      sets.push('updatedAt = @updatedAt');
      params.updatedAt = new Date().toISOString();

      db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = @id`).run(params);
      res.json({ id: req.params.id });
    }, res));

  /**
   * §5.1 lastFetchedAt / lastFetchedItemPublishedAt are scraper state, not
   * editor settings — §4.4 calls them "last-run results", i.e. something to
   * read. They are exposed read-only, with this one action to clear them, which
   * is the only legitimate edit: re-ingest a feed from scratch. That is safer
   * than a free-text timestamp field, where a typo silently skips real stories.
   */
  router.post('/sources/:id/reset-cursor', (req, res) => {
    const existing = db.prepare(`SELECT 1 FROM sources WHERE id = ?`).get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: `No source with id '${req.params.id}'.` });
      return;
    }
    db.prepare(
      `UPDATE sources SET lastFetchedAt = NULL, lastFetchedItemPublishedAt = NULL, updatedAt = ?
       WHERE id = ?`,
    ).run(new Date().toISOString(), req.params.id);
    res.json({ id: req.params.id, reset: true });
  });

  router.delete('/sources/:id', (req, res) =>
    handle(() => {
      const existing = db.prepare(`SELECT 1 FROM sources WHERE id = ?`).get(req.params.id);
      if (!existing) {
        res.status(404).json({ error: `No source with id '${req.params.id}'.` });
        return;
      }

      // The schema's ON DELETE RESTRICT protects ingested articles. Surface it
      // as advice rather than a raw constraint error.
      const count = db
        .prepare(`SELECT COUNT(*) FROM raw_articles WHERE sourceId = ?`)
        .pluck()
        .get(req.params.id) as number;

      if (count > 0) {
        throw new Conflict(
          `'${req.params.id}' has ${count} ingested article(s), so it cannot be deleted. ` +
            'Disable it instead — its stories stay readable and it stops being scraped.',
        );
      }

      db.prepare(`DELETE FROM sources WHERE id = ?`).run(req.params.id);
      res.json({ deleted: req.params.id });
    }, res));

  // ─── §6 guard config ────────────────────────────────────────────────────
  router.get('/guard-config', (_req, res) => {
    const row = db.prepare(`SELECT * FROM guard_config WHERE id = 'default'`).get() as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Guard config missing. Run npm run db:seed.' });
      return;
    }
    res.json({
      ...row,
      denyList: parseJsonColumn<string[]>(String(row.denyList), []),
      denyListEnabled: row.denyListEnabled === 1,
      promptGuardEnabled: row.promptGuardEnabled === 1,
    });
  });

  router.put('/guard-config', (req, res) =>
    handle(() => {
      const body = (req.body ?? {}) as Record<string, unknown>;

      if (!Array.isArray(body.denyList) || !body.denyList.every((w) => typeof w === 'string')) {
        throw new BadRequest('denyList must be an array of strings.');
      }

      // Trim, drop blanks, de-duplicate case-insensitively — the guard matches
      // case-insensitively, so two casings of one word would double-count.
      const seen = new Set<string>();
      const denyList: string[] = [];
      for (const word of body.denyList as string[]) {
        const value = word.trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        denyList.push(value);
      }

      db.prepare(
        `UPDATE guard_config SET
           denyList = @denyList,
           denyListEnabled = @denyListEnabled,
           promptGuardEnabled = @promptGuardEnabled,
           promptGuardText = @promptGuardText,
           updatedAt = @updatedAt
         WHERE id = 'default'`,
      ).run({
        denyList: JSON.stringify(denyList),
        denyListEnabled: body.denyListEnabled === false ? 0 : 1,
        promptGuardEnabled: body.promptGuardEnabled === true ? 1 : 0,
        promptGuardText: typeof body.promptGuardText === 'string' ? body.promptGuardText : '',
        updatedAt: new Date().toISOString(),
      });

      res.json({ denyList, count: denyList.length });
    }, res));

  // ─── §8.5 translation prompt config ─────────────────────────────────────
  // Stored and returned, but NOTHING reads these yet: the local pipeline (§9.2)
  // is rule-based. They take effect only once §9.1 exists.
  router.get('/prompt-config', (_req, res) => {
    const row = db.prepare(`SELECT * FROM translation_prompt_config WHERE id = 'default'`).get() as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Prompt config missing. Run npm run db:seed.' });
      return;
    }
    res.json({
      ...row,
      ageOverrides: parseJsonColumn<Record<string, string>>(String(row.ageOverrides), {}),
      versions: parseJsonColumn<Record<string, number>>(String(row.versions), {}),
      inertUntilLlm: true,
    });
  });

  router.put('/prompt-config', (req, res) =>
    handle(() => {
      const body = (req.body ?? {}) as Record<string, unknown>;

      if (typeof body.genericPrompt !== 'string') {
        throw new BadRequest('genericPrompt must be a string.');
      }

      const overrides = body.ageOverrides;
      if (
        typeof overrides !== 'object' || overrides === null || Array.isArray(overrides) ||
        !Object.entries(overrides).every(
          ([age, prompt]) =>
            /^\d+$/.test(age) && Number(age) >= 5 && Number(age) <= 14 && typeof prompt === 'string',
        )
      ) {
        throw new BadRequest('ageOverrides must be an object mapping an age from 5 to 14 to a prompt string.');
      }

      // `versions` is NOT writable here: §7.5 makes it a counter that only a
      // sandbox promotion may increment. Editing it by hand would falsify the
      // version history.
      db.prepare(
        `UPDATE translation_prompt_config SET
           genericPrompt = @genericPrompt, ageOverrides = @ageOverrides, updatedAt = @updatedAt
         WHERE id = 'default'`,
      ).run({
        genericPrompt: body.genericPrompt,
        ageOverrides: JSON.stringify(overrides),
        updatedAt: new Date().toISOString(),
      });

      res.json({ ok: true });
    }, res));

  // ─── §8.7 app settings ──────────────────────────────────────────────────
  router.get('/app-settings', (_req, res) => {
    const row = db.prepare(`SELECT * FROM app_settings WHERE id = 'default'`).get() as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'App settings missing. Run npm run db:seed.' });
      return;
    }
    res.json({
      defaultAge: row.defaultAge,
      scrapeTimes: parseJsonColumn<string[]>(String(row.scrapeTimes), []),
      llmProvider: row.llmProvider,
      // §13.2: the API key lives in the environment, never in this table.
      apiKeyLocation: 'environment variable only (never stored in the database)',
    });
  });

  router.put('/app-settings', (req, res) =>
    handle(() => {
      const body = (req.body ?? {}) as Record<string, unknown>;

      const defaultAge = Number(body.defaultAge);
      if (!Number.isInteger(defaultAge) || defaultAge < 5 || defaultAge > 14) {
        throw new BadRequest('defaultAge must be a whole number from 5 to 14.');
      }

      if (!Array.isArray(body.scrapeTimes)) throw new BadRequest('scrapeTimes must be an array.');
      const times: string[] = [];
      for (const entry of body.scrapeTimes) {
        const value = String(entry).trim();
        if (!value) continue;
        const match = /^(\d{1,2}):(\d{2})$/.exec(value);
        if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
          throw new BadRequest(`'${value}' is not a time of day in HH:MM form.`);
        }
        // Normalise so "6:00" and "06:00" cannot both be stored.
        times.push(`${match[1]!.padStart(2, '0')}:${match[2]}`);
      }

      const provider =
        body.llmProvider === null || body.llmProvider === undefined || String(body.llmProvider).trim() === ''
          ? null
          : String(body.llmProvider).trim();

      db.prepare(
        `UPDATE app_settings SET defaultAge = @defaultAge, scrapeTimes = @scrapeTimes, llmProvider = @llmProvider
         WHERE id = 'default'`,
      ).run({
        defaultAge,
        scrapeTimes: JSON.stringify([...new Set(times)]),
        llmProvider: provider,
      });

      res.json({ defaultAge, scrapeTimes: [...new Set(times)], llmProvider: provider });
    }, res));

  return router;
}
