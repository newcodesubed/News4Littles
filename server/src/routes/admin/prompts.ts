/** Prompt sandbox API — PRD §7.6. All routes sit behind the admin auth. */
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { BadRequestError } from '../../core/errors.js';
import {
  createPromptRepository, PROMPT_TARGETS, type PromptTarget,
} from '../../db/repositories/promptRepository.js';
import { createSettingsRepository } from '../../db/repositories/settingsRepository.js';
import { LLM_ENABLED, LLM_MODEL } from '../../env.js';
import { optionalString, parseBool, requireOneOf, requireString } from '../../http/validation.js';
import {
  productionPrompt, promotePrompt, requireAge, runSandboxTest,
} from '../../services/sandbox.js';

/** §7.3: the variables a prompt may reference, listed for the editor. */
const TEMPLATE_VARIABLES = ['{{headline}}', '{{body}}', '{{category}}', '{{sourceName}}', '{{age}}'];

export function createPromptsRouter(db: Database): Router {
  const router = Router();
  const prompts = createPromptRepository(db);
  const settings = createSettingsRepository(db);

  const target = (value: unknown): PromptTarget =>
    requireOneOf(value, PROMPT_TARGETS, 'target');

  /** §7.6: current prompt config plus a versions summary. */
  router.get('/prompts', (_req, res) => {
    const config = settings.getPromptConfig();
    const guard = settings.getGuardConfig();

    res.json({
      simplification: {
        generic: config.genericPrompt,
        ageOverrides: config.ageOverrides,
      },
      guard: {
        promptText: guard.promptGuardText,
        enabled: guard.promptGuardEnabled,
      },
      versions: prompts.currentVersions(),
      drafts: prompts.listDrafts(),
      templateVariables: TEMPLATE_VARIABLES,
      // §7.4: the sandbox must say when there is no key.
      llm: { enabled: LLM_ENABLED, model: LLM_MODEL },
      defaultAge: settings.getAppSettings().defaultAge,
    });
  });

  /** §7.6: save a draft. Never touches production (§7.4). */
  router.put('/prompts/draft', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const chosen = target(body.target);
    const age = requireAge(body.age);

    // §7.3 scopes the age target to simplification; the schema enforces it too.
    if (chosen === 'guard' && age !== null) {
      throw new BadRequestError('The guard prompt is not age-specific.');
    }

    prompts.saveDraft(
      { target: chosen, age, promptText: requireString(body.promptText, 'promptText') },
      new Date().toISOString(),
    );

    res.json({ target: chosen, age, saved: true });
  });

  router.delete('/prompts/draft', (req, res) => {
    const chosen = target(req.query.target);
    prompts.deleteDraft(chosen, requireAge(req.query.age));
    res.json({ deleted: true });
  });

  /** §7.6: run a prompt against an article. Writes nothing. */
  router.post('/prompts/test', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const chosen = target(body.target);
    const age = requireAge(body.age);

    const result = await runSandboxTest(db, {
      target: chosen,
      age,
      promptText: requireString(body.promptText, 'promptText'),
      subject: {
        articleId: optionalString(body.articleId) ?? undefined,
        rawText: optionalString(body.rawText) ?? undefined,
        headline: optionalString(body.headline) ?? undefined,
      },
      compareWithProduction: parseBool(body.compareWithProduction),
    });

    res.json(result);
  });

  /** §7.6: promote a prompt. The only route here that writes production. */
  router.post('/prompts/promote', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const chosen = target(body.target);
    const age = requireAge(body.age);

    if (chosen === 'guard' && age !== null) {
      throw new BadRequestError('The guard prompt is not age-specific.');
    }

    // §7.4 requires a successful test run in the current session before
    // promoting. The server holds no session, so the browser gates the button
    // and sends this flag; it is a guard rail, not a security boundary.
    if (!parseBool(body.confirmed)) {
      throw new BadRequestError(
        'Promotion must be confirmed after a successful test run (send confirmed: true).',
      );
    }

    const record = promotePrompt(db, {
      target: chosen,
      age,
      promptText: requireString(body.promptText, 'promptText'),
      note: optionalString(body.note),
      // §7.5 records who promoted it; the admin account is the only user (§2.2).
      promotedBy: 'admin',
    });

    res.status(201).json(record);
  });

  /** §7.6: version history, filterable. */
  router.get('/prompts/versions', (req, res) => {
    const filter: { target?: PromptTarget; age?: number | null } = {};
    if (req.query.target !== undefined) filter.target = target(req.query.target);
    if (req.query.age !== undefined) filter.age = requireAge(req.query.age);

    res.json(prompts.listVersions(filter));
  });

  /** The prompt currently live for a target+age — the "reset to production" source. */
  router.get('/prompts/production', (req, res) => {
    const chosen = target(req.query.target);
    res.json({ promptText: productionPrompt(db, chosen, requireAge(req.query.age)) });
  });

  return router;
}
