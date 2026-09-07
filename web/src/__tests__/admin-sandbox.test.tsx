/**
 * Prompt sandbox UI — PRD §7.
 *
 * The behaviours under most scrutiny are §7.4's: a draft never touches
 * production, and promotion is impossible until a test run has succeeded.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthProvider } from '../admin/AdminAuthContext';
import { AdminSandbox } from '../pages/admin/AdminSandbox';

let calls: { method: string; path: string; body: any }[] = [];
let llmEnabled = true;
let testResponse: any;

const ARTICLE = {
  id: 'a1', originalId: 'r1', ageTarget: 8, kidHeadline: 'A robot looked at a reef',
  summary: 'A robot explored a reef.', whatHappened: 'It went down with lights.',
  whyItMatters: 'Reefs are homes.', vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
  thinkAbout: 'What would you look for?', feelingNote: null, safety: 'calm',
  contentWarnings: null, category: 'World', readingMinutes: 2, sourceName: 'BBC News',
  sourceUrl: 'https://x', status: 'pending_review', rejectReason: null, editedByHuman: false,
  createdAt: '2026-09-09T10:00:00.000Z', publishedAt: null,
};

const okRun = {
  target: 'simplification', age: null, engine: 'llm',
  model: 'google/gemini-2.5-flash-lite', elapsedMs: 2100, costUsd: 0.00017,
  article: ARTICLE,
  validation: { schemaValid: true, ageLimit: 14, longestSentenceWords: 9, withinAgeLimit: true, overLongSentences: [] },
};

function mockApi() {
  testResponse = { subject: { headline: 'Survey team documents a coral reef', body: 'b', sourceName: 'BBC News', category: 'World' }, draft: okRun, usingLocalFallback: false };

  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push({ method: init.method ?? 'GET', path, body: init.body ? JSON.parse(String(init.body)) : null });
    const json = (body: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as unknown as Response;

    if (path.startsWith('/api/admin/prompts/test')) return json(testResponse);
    if (path.startsWith('/api/admin/prompts/promote')) return json({ id: 'v1', version: 1 }, 201);
    if (path.startsWith('/api/admin/prompts/draft')) return json({ saved: true });
    if (path.startsWith('/api/admin/prompts/versions')) return json([
      { id: 'v1', target: 'simplification', age: null, promptText: 'first text', version: 1, promotedBy: 'admin', promotedAt: '2026-09-08T10:00:00.000Z', note: 'initial' },
      { id: 'v2', target: 'simplification', age: null, promptText: 'second text', version: 2, promotedBy: 'admin', promotedAt: '2026-09-09T10:00:00.000Z', note: null },
    ]);
    if (path.startsWith('/api/admin/prompts')) return json({
      simplification: { generic: 'PRODUCTION GENERIC PROMPT', ageOverrides: { '6': 'AGE SIX PROMPT' } },
      guard: { promptText: 'GUARD PROMPT', enabled: false },
      versions: { simplification: 2 },
      drafts: [],
      templateVariables: ['{{headline}}', '{{body}}', '{{age}}'],
      llm: { enabled: llmEnabled, model: 'google/gemini-2.5-flash-lite' },
      defaultAge: 6,
    });
    if (path.startsWith('/api/admin/raw-articles')) return json([
      { id: 'r1', headline: 'Survey team documents a coral reef', sourceName: 'BBC News', topic: 'World', publishedAt: null, fetchedAt: '2026-09-09T10:00:00.000Z', bodyLength: 120 },
    ]);
    return json({});
  }));
}

const renderSandbox = (path = '/admin/sandbox') =>
  render(<MemoryRouter initialEntries={[path]}><AdminAuthProvider><AdminSandbox /></AdminAuthProvider></MemoryRouter>);

beforeEach(() => {
  window.sessionStorage.setItem('news4littles.admin', btoa('admin:admin123'));
  calls = [];
  llmEnabled = true;
  mockApi();
});
afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

const promptBox = () => screen.getByLabelText('Prompt text');

describe('loading the live prompt (§7.3)', () => {
  it('pre-loads the production prompt', async () => {
    renderSandbox();
    expect(await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT')).toBeInTheDocument();
  });

  it('loads the age override when that variant is chosen', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.selectOptions(screen.getByLabelText('Prompt variant'), '6');
    expect(await screen.findByDisplayValue('AGE SIX PROMPT')).toBeInTheDocument();
  });

  it('loads the guard prompt for the guard target', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.selectOptions(screen.getByLabelText('Prompt'), 'guard');
    expect(await screen.findByDisplayValue('GUARD PROMPT')).toBeInTheDocument();
  });

  it('shows the live version number', async () => {
    renderSandbox();
    expect(await screen.findByText('v2')).toBeInTheDocument();
  });

  it('lists the template variables, insertable by click (§7.3)', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.click(screen.getByRole('button', { name: '{{headline}}' }));
    expect(promptBox()).toHaveValue('PRODUCTION GENERIC PROMPT\n{{headline}}');
  });
});

describe('draft indicator (§7.3)', () => {
  it('says the text matches production initially', async () => {
    renderSandbox();
    expect(await screen.findByText('Matches production')).toBeInTheDocument();
  });

  it('flags an unpromoted edit', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.type(promptBox(), ' extra');
    expect(await screen.findByText('Edited — not yet promoted')).toBeInTheDocument();
  });

  it('reset restores the production text', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.type(promptBox(), ' extra');
    await userEvent.click(screen.getByRole('button', { name: 'Reset to production' }));
    expect(promptBox()).toHaveValue('PRODUCTION GENERIC PROMPT');
  });
});

describe('running a test (§7.4)', () => {
  it('posts the prompt and shows the output as a reader would see it', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));

    expect(await screen.findByText('A robot looked at a reef')).toBeInTheDocument();
    // The shared StoryPreview, so it renders like the story page.
    expect(screen.getByText('What happened?')).toBeInTheDocument();
    expect(screen.getByText('Words to know')).toBeInTheDocument();
  });

  it('never asks for a comparison unless Compare was pressed', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));

    await waitFor(() => {
      const call = calls.find((c) => c.path.startsWith('/api/admin/prompts/test'));
      expect(call?.body.compareWithProduction).toBe(false);
    });
  });

  it('comparison mode asks for both and shows a diff (§7.3)', async () => {
    testResponse = {
      subject: { headline: 'h', body: 'b', sourceName: 's', category: 'World' },
      draft: { ...okRun, article: { ...ARTICLE, kidHeadline: 'Draft headline' } },
      production: { ...okRun, article: { ...ARTICLE, kidHeadline: 'Production headline' } },
      usingLocalFallback: false,
    };
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.click(screen.getByRole('button', { name: 'Compare with production' }));

    expect(await screen.findByText(/1 field\(s\) differ/)).toBeInTheDocument();
    // Each headline appears twice: once in the diff table, once in the preview.
    expect(screen.getAllByText('Production headline')).toHaveLength(2);
    expect(screen.getAllByText('Draft headline')).toHaveLength(2);
  });

  it('reports latency and the model that answered (§7.4)', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));
    // The model is named in the page header too, so scope to the run meta.
    expect(await screen.findByText(/2100ms/)).toBeInTheDocument();
    expect(screen.getByText(/2100ms/).textContent).toContain('google/gemini-2.5-flash-lite');
  });

  it('shows the words-per-sentence check against the age limit (§7.3)', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));
    expect(await screen.findByText(/9\/14 words/)).toBeInTheDocument();
  });

  it('says plainly when there is no LLM (§7.4)', async () => {
    llmEnabled = false;
    renderSandbox();
    expect(await screen.findByText(/No LLM key is configured/)).toBeInTheDocument();
  });
});

describe('saving a draft (§7.4: never auto-promotes)', () => {
  it('PUTs the draft and does not promote', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.type(promptBox(), ' edited');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/admin/prompts/draft')).toBe(true));
    expect(calls.some((c) => c.path.includes('/promote'))).toBe(false);
  });
});

describe('promotion (§7.4)', () => {
  it('is disabled until a test run has succeeded', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    expect(screen.getByRole('button', { name: 'Promote to production' })).toBeDisabled();
    expect(screen.getByText(/needs one successful test run first/)).toBeInTheDocument();
  });

  it('becomes available after a successful run', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));
    await screen.findByText('A robot looked at a reef');
    expect(screen.getByRole('button', { name: 'Promote to production' })).toBeEnabled();
  });

  it('stays disabled when the run fell back', async () => {
    testResponse = {
      subject: { headline: 'h', body: 'b', sourceName: 's', category: 'World' },
      draft: { ...okRun, engine: 'local-fallback', fallbackReason: 'Response was not valid JSON.' },
      usingLocalFallback: true,
    };
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));
    await screen.findByText(/not valid JSON/);
    expect(screen.getByRole('button', { name: 'Promote to production' })).toBeDisabled();
  });

  it('summarises what will change before confirming (§7.4)', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));
    await screen.findByText('A robot looked at a reef');
    await userEvent.click(screen.getByRole('button', { name: 'Promote to production' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/All ages/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Version 3/)).toBeInTheDocument();
    expect(within(dialog).getByText(/not regenerated/)).toBeInTheDocument();
  });

  it('sends confirmed:true with the note', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));
    await screen.findByText('A robot looked at a reef');
    await userEvent.click(screen.getByRole('button', { name: 'Promote to production' }));

    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Clearer safety wording');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Promote' }));

    await waitFor(() => {
      const call = calls.find((c) => c.path.includes('/promote'));
      expect(call?.body).toMatchObject({ confirmed: true, note: 'Clearer safety wording', age: null });
    });
  });

  it('cancel promotes nothing', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));
    await screen.findByText('A robot looked at a reef');
    await userEvent.click(screen.getByRole('button', { name: 'Promote to production' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(calls.some((c) => c.path.includes('/promote'))).toBe(false);
  });
});

describe('run history (§7.3)', () => {
  it('records each run and reloads it on click', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.type(promptBox(), ' v1');
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));
    await screen.findByText('A robot looked at a reef');

    const entry = await screen.findByRole('button', { name: /simplification/ });
    await userEvent.clear(promptBox());
    await userEvent.type(promptBox(), 'something else');

    await userEvent.click(entry);
    expect(promptBox()).toHaveValue('PRODUCTION GENERIC PROMPT v1');
  });

  it('shows the session cost', async () => {
    renderSandbox();
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));
    // Shown in the header total, the run meta and the history row.
    await waitFor(() => expect(screen.getAllByText(/\$0\.00017/).length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText(/This session:/).textContent).toContain('$0.00017');
  });
});

describe('version history (§7.5)', () => {
  it('lists promotions with who and when', async () => {
    renderSandbox();
    expect(await screen.findByText(/v2 · simplification/)).toBeInTheDocument();
    expect(screen.getByText(/initial/)).toBeInTheDocument();
  });

  it('diffs any two chosen versions', async () => {
    renderSandbox();
    await screen.findByText(/v2 · simplification/);
    const [asA] = screen.getAllByRole('button', { name: 'Compare as A' });
    const asB = screen.getAllByRole('button', { name: 'Compare as B' })[1]!;
    await userEvent.click(asA);
    await userEvent.click(asB);

    expect(await screen.findByText('second text')).toBeInTheDocument();
    expect(screen.getByText('first text')).toBeInTheDocument();
  });
});

describe('entry points (§7.2)', () => {
  it('pre-loads an article passed in the URL', async () => {
    renderSandbox('/admin/sandbox?articleId=r1&age=8');
    await screen.findByDisplayValue('PRODUCTION GENERIC PROMPT');
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));

    await waitFor(() => {
      const call = calls.find((c) => c.path.startsWith('/api/admin/prompts/test'));
      expect(call?.body).toMatchObject({ articleId: 'r1', age: 8 });
    });
  });

  it('opens on the guard target when the URL says so', async () => {
    renderSandbox('/admin/sandbox?target=guard');
    expect(await screen.findByDisplayValue('GUARD PROMPT')).toBeInTheDocument();
  });
});
