/**
 * Guardrails and app settings — PRD §4.4, §6, §8.7.
 *
 * No LLM calls happen here. Translation prompts are not edited here: only a
 * sandbox promotion changes them (§7.4), so every change has a test run and a
 * version record.
 */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { BadRequestError } from '../../core/errors.js';
import { createSettingsRepository } from '../../db/repositories/settingsRepository.js';
import {
  optionalString, requireAgeTarget, requireInt, requireTimeOfDay,
} from '../../http/validation.js';

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

    const current = settings.getAppSettings();

    const saved = {
      // The band assumed when nothing says which reader this is for. Stored
      // as its anchor, because every consumer resolves it to a band anyway.
      defaultAge: requireAgeTarget(body.defaultAge, 'defaultAge'),
      scrapeTimes: times,
      llmProvider: optionalString(body.llmProvider),
      // Absent means "leave it alone", so a client that predates this field
      // cannot silently reset the budget to a default.
      simplifyBudget:
        body.simplifyBudget === undefined
          ? current.simplifyBudget
          : requireInt(body.simplifyBudget, 'simplifyBudget', { min: 0, max: 100 }),
    };

    settings.saveAppSettings(saved);
    res.json(saved);
  });

  return router;
}
