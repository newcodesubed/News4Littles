/** Admin settings — PRD §4.4, §5.1, §6, §8.5, §8.7. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, insertRawArticle, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); });
afterEach(() => ctx.close());

const json = async (path: string) => (await ctx.api(path)).json();
const send = (method: string) => (path: string, body: unknown) =>
  ctx.api(path, { method, body: JSON.stringify(body) });
const post = send('POST');
const put = send('PUT');
const patch = send('PATCH');

describe('sources CRUD (§5.1)', () => {
  it('lists the seeded sources with article counts', async () => {
    const sources = await json('/api/admin/sources');
    expect(sources).toHaveLength(6);
    expect(sources.find((s: any) => s.id === 'bbc')).toMatchObject({ enabled: true, trustLevel: 'high' });
  });

  it('creates a source', async () => {
    const res = await post('/api/admin/sources', {
      id: 'guardian', name: 'The Guardian', url: 'https://example.com/rss', enabled: true, trustLevel: 'high', parser: 'rss',
    });
    expect(res.status).toBe(201);
    expect(await json('/api/admin/sources')).toHaveLength(7);
  });

  it.each([
    ['a duplicate id', { id: 'bbc', name: 'X', url: 'u', trustLevel: 'high' }, 409],
    ['a bad slug', { id: 'Bad Slug!', name: 'X', url: 'u', trustLevel: 'high' }, 400],
    ['an unknown trust level', { id: 'ok', name: 'X', url: 'u', trustLevel: 'excellent' }, 400],
    ['enabled with no feed URL', { id: 'ok', name: 'X', url: '', enabled: true, trustLevel: 'high' }, 400],
    ['a blank name', { id: 'ok', name: '', url: 'u', trustLevel: 'high' }, 400],
  ])('rejects %s', async (_label, body, status) => {
    expect((await post('/api/admin/sources', body)).status).toBe(status);
  });

  it('edits name, parser, trust level and enabled', async () => {
    await patch('/api/admin/sources/cnn', { name: 'CNN International', parser: 'rss', trustLevel: 'low' });
    const cnn = (await json('/api/admin/sources')).find((s: any) => s.id === 'cnn');
    expect(cnn).toMatchObject({ name: 'CNN International', parser: 'rss', trustLevel: 'low' });
  });

  it('refuses to enable a source with no feed URL', async () => {
    expect((await patch('/api/admin/sources/cnn', { enabled: true })).status).toBe(400);
  });

  it('deletes an unused source', async () => {
    expect((await ctx.api('/api/admin/sources/cnn', { method: 'DELETE' })).status).toBe(200);
  });

  it('refuses to delete a source with articles, and suggests disabling', async () => {
    insertRawArticle(ctx.db, { sourceId: 'bbc' });
    const res = await ctx.api('/api/admin/sources/bbc', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Disable it instead/);
  });

  it('resets the scrape cursor', async () => {
    ctx.db.prepare(`UPDATE sources SET lastFetchedItemPublishedAt = '2026-09-04T00:00:00.000Z' WHERE id='bbc'`).run();
    await post('/api/admin/sources/bbc/reset-cursor', {});
    const bbc = (await json('/api/admin/sources')).find((s: any) => s.id === 'bbc');
    expect(bbc.lastFetchedItemPublishedAt).toBeNull();
  });

  it('404s for an unknown source', async () => {
    expect((await patch('/api/admin/sources/ghost', { name: 'X' })).status).toBe(404);
  });
});

describe('guard config (§6)', () => {
  it('returns the deny-list as an array of strings', async () => {
    const config = await json('/api/admin/guard-config');
    expect(config.denyList).toHaveLength(11);
    expect(config.denyListEnabled).toBe(true);
  });

  it('trims, drops blanks and de-duplicates case-insensitively', async () => {
    await put('/api/admin/guard-config', { denyList: [' volcano ', 'Volcano', '', '  ', 'flood'], denyListEnabled: true });
    expect((await json('/api/admin/guard-config')).denyList).toEqual(['volcano', 'flood']);
  });

  it('a saved deny-list changes the very next guard run', async () => {
    await put('/api/admin/guard-config', { denyList: ['volcano', 'flood'], denyListEnabled: true });
    const { guard } = await (await post('/api/admin/simplify', {
      headline: 'Eruption', sourceName: 'X', sourceUrl: 'https://x', category: 'World', ageTarget: 8,
      body: 'A volcano erupted and a flood followed.',
    })).json();
    expect(guard.matches).toEqual(['volcano', 'flood']);
  });

  it('disabling the guard classifies everything calm', async () => {
    await put('/api/admin/guard-config', { denyList: ['war'], denyListEnabled: false });
    const { article } = await (await post('/api/admin/simplify', {
      headline: 'X', sourceName: 'X', sourceUrl: 'https://x', category: 'World', ageTarget: 8,
      body: 'There was a war.',
    })).json();
    expect(article.safety).toBe('calm');
  });

  it('rejects a non-array deny-list', async () => {
    expect((await put('/api/admin/guard-config', { denyList: 'war' })).status).toBe(400);
  });
});

describe('translation prompts (§8.5)', () => {
  it('returns prompts and flags them as inert', async () => {
    const config = await json('/api/admin/prompt-config');
    expect(typeof config.genericPrompt).toBe('string');
    expect(config.inertUntilLlm).toBe(true);
  });

  it('saves the generic prompt and age overrides', async () => {
    await put('/api/admin/prompt-config', { genericPrompt: 'New prompt', ageOverrides: { '6': 'Age six' } });
    const config = await json('/api/admin/prompt-config');
    expect(config.genericPrompt).toBe('New prompt');
    expect(config.ageOverrides['6']).toBe('Age six');
  });

  it('does not let the version counter be written by hand (§7.5)', async () => {
    const before = await json('/api/admin/prompt-config');
    await put('/api/admin/prompt-config', { genericPrompt: 'x', ageOverrides: {}, versions: { guard: 99 } });
    expect((await json('/api/admin/prompt-config')).versions).toEqual(before.versions);
  });

  it.each([
    ['an out-of-range override age', { genericPrompt: 'x', ageOverrides: { '99': 'y' } }],
    ['a non-string prompt', { genericPrompt: 5, ageOverrides: {} }],
    ['an array instead of a map', { genericPrompt: 'x', ageOverrides: [] }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await put('/api/admin/prompt-config', body)).status).toBe(400);
  });
});

describe('app settings (§8.7)', () => {
  it('returns the seeded defaults', async () => {
    expect(await json('/api/admin/app-settings')).toMatchObject({
      defaultAge: 6, scrapeTimes: ['06:00'], llmProvider: null,
    });
  });

  it('never exposes an API key field (§13.2)', async () => {
    const settings = await json('/api/admin/app-settings');
    expect(Object.keys(settings)).not.toContain('llmApiKey');
    expect(settings.apiKeyLocation).toMatch(/environment/);
  });

  it('normalises and de-duplicates scrape times', async () => {
    await put('/api/admin/app-settings', { defaultAge: 9, scrapeTimes: ['6:00', '07:30', '06:00'], llmProvider: 'anthropic' });
    expect(await json('/api/admin/app-settings')).toMatchObject({
      defaultAge: 9, scrapeTimes: ['06:00', '07:30'], llmProvider: 'anthropic',
    });
  });

  it('treats a blank provider as none', async () => {
    await put('/api/admin/app-settings', { defaultAge: 6, scrapeTimes: [], llmProvider: '  ' });
    expect((await json('/api/admin/app-settings')).llmProvider).toBeNull();
  });

  it.each([
    ['an impossible time', { defaultAge: 6, scrapeTimes: ['25:00'] }],
    ['a non-time', { defaultAge: 6, scrapeTimes: ['morning'] }],
    ['an out-of-range age', { defaultAge: 99, scrapeTimes: [] }],
    ['a non-array of times', { defaultAge: 6, scrapeTimes: '06:00' }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await put('/api/admin/app-settings', body)).status).toBe(400);
  });

  it('defaults the simplification budget to 10 and round-trips a new value', async () => {
    expect((await json('/api/admin/app-settings')).simplifyBudget).toBe(10);

    const res = await put('/api/admin/app-settings', {
      defaultAge: 6, scrapeTimes: ['06:00'], llmProvider: null, simplifyBudget: 4,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).simplifyBudget).toBe(4);
    expect((await json('/api/admin/app-settings')).simplifyBudget).toBe(4);
  });

  it('accepts a budget of 0 — simplify nothing automatically', async () => {
    const res = await put('/api/admin/app-settings', {
      defaultAge: 6, scrapeTimes: [], llmProvider: null, simplifyBudget: 0,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).simplifyBudget).toBe(0);
  });

  it.each([[-1], [101], ['ten'], [2.5]])('rejects a simplifyBudget of %p', async (value) => {
    const res = await put('/api/admin/app-settings', {
      defaultAge: 6, scrapeTimes: [], llmProvider: null, simplifyBudget: value,
    });
    expect(res.status).toBe(400);
  });

  it('leaves the budget alone when the field is absent', async () => {
    // An older client PUTting the pre-budget body must not silently reset it.
    await put('/api/admin/app-settings', {
      defaultAge: 6, scrapeTimes: [], llmProvider: null, simplifyBudget: 3,
    });
    await put('/api/admin/app-settings', { defaultAge: 7, scrapeTimes: [], llmProvider: null });
    expect((await json('/api/admin/app-settings')).simplifyBudget).toBe(3);
  });

  it('a saved defaultAge is used by the pipeline', async () => {
    await put('/api/admin/app-settings', { defaultAge: 12, scrapeTimes: ['06:00'] });
    const { article } = await (await post('/api/admin/simplify', {
      headline: 'X', sourceName: 'X', sourceUrl: 'https://x', category: 'World', ageTarget: 12,
      body: 'A calm story about the sea.',
    })).json();
    expect(article.ageTarget).toBe(12);
  });
});
