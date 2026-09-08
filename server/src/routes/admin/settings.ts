/**
 * Guardrails, translation prompts and app settings — PRD §4.4, §6, §8.5, §8.7.
 *
 * NO LLM calls. The prompt fields are stored and returned, but nothing reads
 * them until §9.1 exists.
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { BadRequestError } from '../../core/errors.js';
import { MAX_AGE, MIN_AGE } from '../../core/article.js';
import { createSettingsRepository } from '../../db/repositories/settingsRepository.js';
import { optionalString, requireAgeTarget, requireTimeOfDay } from '../../http/validation.js';

/**
 * The guard matches case-insensitively, so two casings of one word would
 * double-count toward §6.1's 3+ threshold. Trim, drop blanks, de-duplicate.
 */
function normaliseDenyList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((word) => typeof word === 'string')) {
    throw new BadRequestError('denyList must be an array of strings.');
  }

  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of value as string[]) {
    const word = raw.trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
  }
  return words;
}

function readAgeOverrides(value: unknown): Record<string, string> {
  const valid =
    typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.entries(value).every(
      ([age, prompt]) =>
        /^\d+$/.test(age) && Number(age) >= MIN_AGE && Number(age) <= MAX_AGE && typeof prompt === 'string',
    );

  if (!valid) {
    throw new BadRequestError(
      `ageOverrides must be an object mapping an age from ${MIN_AGE} to ${MAX_AGE} to a prompt string.`,
    );
  }
  return value as Record<string, string>;
}

export function createSettingsRouter(db: Database): Router {
  const router = Router();
  const settings = createSettingsRepository(db);
  const now = () => new Date().toISOString();

  // ─── §6 guardrails ──────────────────────────────────────────────────────
  router.get('/guard-config', (_req, res) => {
    res.json(settings.getGuardConfig());
  });

  router.put('/guard-config', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const denyList = normaliseDenyList(body.denyList);

    settings.saveGuardConfig(
      {
        denyList,
        denyListEnabled: body.denyListEnabled !== false,
        promptGuardEnabled: body.promptGuardEnabled === true,
        promptGuardText: typeof body.promptGuardText === 'string' ? body.promptGuardText : '',
      },
      now(),
    );

    res.json({ denyList, count: denyList.length });
  });

  // ─── §8.5 translation prompts (inert until §9.1) ────────────────────────
  router.get('/prompt-config', (_req, res) => {
    res.json({ ...settings.getPromptConfig(), inertUntilLlm: true });
  });

  router.put('/prompt-config', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.genericPrompt !== 'string') {
      throw new BadRequestError('genericPrompt must be a string.');
    }

    // `versions` is not writable: §7.5 makes it a counter only a sandbox
    // promotion may increment. Editing it by hand would falsify the history.
    settings.savePromptConfig(
      { genericPrompt: body.genericPrompt, ageOverrides: readAgeOverrides(body.ageOverrides) },
      now(),
    );

    res.json({ ok: true });
  });

  // ─── §8.7 app settings ──────────────────────────────────────────────────
  router.get('/app-settings', (_req, res) => {
    res.json({
      ...settings.getAppSettings(),
      // §13.2: the API key lives in the environment, never in this table.
      apiKeyLocation: 'environment variable only (never stored in the database)',
    });
  });

  router.put('/app-settings', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.scrapeTimes)) throw new BadRequestError('scrapeTimes must be an array.');

    const times = [
      ...new Set(
        body.scrapeTimes
          .filter((entry) => String(entry).trim() !== '')
          .map((entry) => requireTimeOfDay(entry)),
      ),
    ];

    const saved = {
      defaultAge: requireAgeTarget(body.defaultAge, 'defaultAge'),
      scrapeTimes: times,
      llmProvider: optionalString(body.llmProvider),
    };

    settings.saveAppSettings(saved);
    res.json(saved);
  });

  return router;
}
