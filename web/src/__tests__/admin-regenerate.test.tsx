/**
 * Story-scoped Regenerate from the queue — §4.2 under §5's story scope.
 *
 * The job is what makes this different from every other row action: the click
 * starts work that outlives the request, so the row has to say so, and the
 * dialog only appears once every age has been rebuilt.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthProvider } from '../admin/AdminAuthContext';
import { AdminReview } from '../pages/admin/AdminReview';
import type { AdminArticle } from '../admin/types';

const BASE: AdminArticle = {
  id: 'v5', originalId: 'r1', ageTarget: 5, kidHeadline: 'Stored age 5',
  summary: 'A summary.', whatHappened: 'What happened.', whyItMatters: 'Why it matters.',
  vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
  thinkAbout: 'Think?', feelingNote: null, safety: 'calm', contentWarnings: null,
  category: 'Environment', readingMinutes: 3, sourceName: 'BBC News',
  sourceUrl: 'https://example.com/original', status: 'pending_review', rejectReason: null,
  editedByHuman: false, createdAt: '2026-09-08T10:00:00.000Z', publishedAt: null,
  sourceId: 'bbc', originalHeadline: 'Adult headline', approvedBy: null,
};

const versions: AdminArticle[] = [5, 8, 14].map((age) => ({
  ...BASE, id: `v${age}`, ageTarget: age, kidHeadline: `Stored age ${age}`,
}));

let jobRunning = false;
let jobLost = false;
let jobError: string | null = null;
let done = 1;
let startStatus = 202;
let applyStatus = 200;
let applyBody: { jobId: string; ages: number[] } | null = null;
let discarded = false;

function mockApi() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = init.method ?? 'GET';
    const json = (body: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as unknown as Response;

    const story = {
      originalId: 'r1', versions, safety: 'calm', status: 'pending_review', approvedBy: null,
      kidHeadline: 'Stored age 5', category: 'Environment', sourceId: 'bbc',
      originalHeadline: 'Adult headline', createdAt: '2026-09-08T10:00:00.000Z',
    };

    const job = () => ({
      id: 'job-1', originalId: 'r1', kidHeadline: 'Stored age 5',
      startedAt: '2026-09-10T09:00:00.000Z', ages: [5, 8, 14], done,
      running: jobRunning, costUsd: 0.0043,
      // Only for a thrown failure; a truthy value here ends the job the same
      // way the service does — running: false, and no versions to show.
      error: jobError ?? undefined,
      // A running job has attempted some ages but reports versions only when
      // it is done, exactly as the service fills them in at the end.
      versions: jobRunning || jobError
        ? []
        : versions.map((v) => ({
            ageTarget: v.ageTarget,
            current: v,
            generated: { ...v, kidHeadline: `Fresh age ${v.ageTarget}` },
            engine: 'llm',
          })),
    });

    if (path.includes('/articles/regenerate/status')) {
      return json({ running: jobRunning, job: jobLost ? null : job() });
    }
    if (path.includes('/articles/regenerate/apply')) {
      applyBody = JSON.parse(String(init.body)) as { jobId: string; ages: number[] };
      if (applyStatus !== 200) {
        return json({ error: 'That preview is no longer the current one. Regenerate the story again.' }, applyStatus);
      }
      return json(story);
    }
    if (path.endsWith('/articles/regenerate') && method === 'DELETE') {
      discarded = true;
      return json({ discarded: true });
    }
    if (path.includes('/regenerate') && method === 'POST') {
      if (startStatus !== 202) {
        return json({ error: 'A scrape is already running. Wait for it to finish before regenerating a story.' }, startStatus);
      }
      jobRunning = true;
      return json({ running: true, job: job() }, 202);
    }
    if (path.includes('/counts')) return json({ pending_review: 1, published: 0, rejected: 0, total: 1, waiting: 0 });
    if (path.includes('/filters')) {
      return json({ categories: [], sources: [], ageTargets: [], safety: [], statuses: [], sortFields: [] });
    }
    if (path.includes('/stories')) return json({ stories: [story], total: 1 });
    return json({});
  }));
}

const view = () =>
  render(
    <MemoryRouter>
      <AdminAuthProvider>
        <AdminReview />
      </AdminAuthProvider>
    </MemoryRouter>,
  );

/** Clicks Regenerate on the only row and waits for the job to be reported. */
async function startJob(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('Stored age 5');
  await user.click(screen.getByRole('button', { name: /Regenerate/ }));
  await screen.findByRole('button', { name: /Regenerating/ });
}

/** Lets the job report itself finished, then waits for the dialog. */
async function finishJob() {
  jobRunning = false;
  done = 3;
  await screen.findByText('Regenerate — review before applying', {}, { timeout: 6000 });
}

beforeEach(() => {
  jobRunning = false;
  jobLost = false;
  jobError = null;
  done = 1;
  startStatus = 202;
  applyStatus = 200;
  applyBody = null;
  discarded = false;
  window.sessionStorage.setItem('news4littles.admin', btoa('admin:admin123'));
  mockApi();
});
afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe('starting a story-scoped regeneration', () => {
  it('reports progress on the row while the job runs', async () => {
    const user = userEvent.setup();
    view();
    await startJob(user);

    const button = await screen.findByRole('button', { name: /Regenerating… 1\/3/ }, { timeout: 6000 });
    expect(button).toBeDisabled();
    // The whole row is locked: the server takes one job at a time.
    // (Named exactly: the story has 3 versions, so the row says "Publish
    // all", and a plain /Publish/ regex also matches the "Published" tab.)
    expect(screen.getByRole('button', { name: 'Publish all' })).toBeDisabled();
  });

  it('opens the dialog with one tab per age once it finishes', async () => {
    const user = userEvent.setup();
    view();
    await startJob(user);
    await finishJob();

    for (const age of [5, 8, 14]) {
      expect(screen.getByRole('tab', { name: new RegExp(`Age ${age}`) })).toBeInTheDocument();
    }
    expect(screen.getByText('Fresh age 5')).toBeInTheDocument();
  });

  it('reports a refusal from the server', async () => {
    startStatus = 409;
    const user = userEvent.setup();
    view();
    await screen.findByText('Stored age 5');

    await user.click(screen.getByRole('button', { name: /Regenerate/ }));

    expect(await screen.findByText(/A scrape is already running/)).toBeInTheDocument();
  });

  it('says so when the preview is lost mid-run', async () => {
    const user = userEvent.setup();
    view();
    await startJob(user);

    // A server restart: the job is gone and nothing was written.
    jobLost = true;

    expect(
      await screen.findByText(/regenerate preview was lost/i, {}, { timeout: 6000 }),
    ).toBeInTheDocument();
  });

  it('surfaces a polled job.error and opens no dialog', async () => {
    const user = userEvent.setup();
    view();
    await startJob(user);

    // The job dies mid-run: the next poll reports it finished with an error
    // rather than versions. If this branch broke, the poll would instead set
    // a job with versions: [], the dialog's `versions.length > 0` guard would
    // suppress it, and the row would quietly unlock with no notice at all.
    jobRunning = false;
    jobError = 'The model backend is unreachable.';

    expect(
      await screen.findByText(/model backend is unreachable/i, {}, { timeout: 6000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Regenerate — review before applying')).not.toBeInTheDocument();
  });
});

describe('applying a story-scoped regeneration', () => {
  it('sends the job id and exactly the ticked ages', async () => {
    const user = userEvent.setup();
    view();
    await startJob(user);
    await finishJob();

    await user.click(screen.getByRole('checkbox', { name: 'Apply age 8' }));
    await user.click(screen.getByRole('button', { name: 'Apply 2 of 3 versions' }));

    await waitFor(() => expect(applyBody).toEqual({ jobId: 'job-1', ages: [5, 14] }));
    await waitFor(() =>
      expect(screen.queryByText('Regenerate — review before applying')).not.toBeInTheDocument(),
    );
  });

  it('discards without applying', async () => {
    const user = userEvent.setup();
    view();
    await startJob(user);
    await finishJob();

    await user.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(discarded).toBe(true));
    expect(applyBody).toBeNull();
  });

  it('closes the dialog and shows the notice when apply fails', async () => {
    applyStatus = 409;
    const user = userEvent.setup();
    view();
    await startJob(user);
    await finishJob();

    await user.click(screen.getByRole('button', { name: 'Apply 3 of 3 versions' }));

    // The dialog must close so the notice — which renders in page flow,
    // underneath Modal's fixed overlay — is actually visible.
    expect(
      await screen.findByText(/no longer the current one/i, {}, { timeout: 6000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Regenerate — review before applying')).not.toBeInTheDocument();
  });
});
