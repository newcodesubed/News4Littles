/** The three review-queue dialogs — PRD §4.2. */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditDialog, Modal, RegenerateDialog, RejectDialog, ViewArticleDialog } from '../pages/admin/dialogs';
import type { AdminArticle, AdminStory, RegenerateJob } from '../admin/types';

const BASE: AdminArticle = {
  id: 'a1', originalId: 'r1', ageTarget: 8, kidHeadline: 'A story headline',
  summary: 'A summary.', whatHappened: 'What happened.', whyItMatters: 'Why it matters.',
  vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
  thinkAbout: 'Think?', feelingNote: null, safety: 'calm', contentWarnings: null,
  category: 'World', readingMinutes: 3, sourceName: 'BBC News', sourceUrl: 'https://x',
  status: 'pending_review', rejectReason: null, editedByHuman: false,
  createdAt: '2026-09-04T10:00:00.000Z', publishedAt: null,
  sourceId: 'bbc', originalHeadline: 'Original headline', approvedBy: null,
};
const article = (o: Partial<AdminArticle> = {}): AdminArticle => ({ ...BASE, ...o });

describe('Modal', () => {
  it('is announced as a dialog with its title', () => {
    render(<Modal title="My dialog" onClose={() => {}}>body</Modal>);
    expect(screen.getByRole('dialog', { name: 'My dialog' })).toBeInTheDocument();
  });

  it('closes on the X button', async () => {
    const onClose = vi.fn();
    render(<Modal title="T" onClose={onClose}>body</Modal>);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the backdrop is clicked, but not the panel', async () => {
    const onClose = vi.fn();
    render(<Modal title="T" onClose={onClose}><p>inner</p></Modal>);
    await userEvent.click(screen.getByText('inner'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('RejectDialog (§4.2)', () => {
  it('shows which story is being rejected', () => {
    render(<RejectDialog article={article()} onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText('A story headline')).toBeInTheDocument();
  });

  it('passes the typed reason on confirm', async () => {
    const onConfirm = vi.fn();
    render(<RejectDialog article={article()} onCancel={() => {}} onConfirm={onConfirm} />);
    await userEvent.type(screen.getByLabelText(/Reason \(optional\)/), 'Not kid news');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject' }));
    expect(onConfirm).toHaveBeenCalledWith('Not kid news');
  });

  it('allows confirming with no reason at all', async () => {
    const onConfirm = vi.fn();
    render(<RejectDialog article={article()} onCancel={() => {}} onConfirm={onConfirm} />);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject' }));
    expect(onConfirm).toHaveBeenCalledWith('');
  });

  it('cancel does not confirm', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<RejectDialog article={article()} onCancel={onCancel} onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('EditDialog (§4.2)', () => {
  const open = (overrides: Partial<AdminArticle> = {}) => {
    const onSave = vi.fn();
    render(<EditDialog article={article(overrides)} onCancel={() => {}} onSave={onSave} />);
    return onSave;
  };

  it('pre-fills every kid-facing field §4.2 lists', () => {
    open();
    for (const value of ['A story headline', 'A summary.', 'What happened.', 'Why it matters.', 'Think?']) {
      expect(screen.getByDisplayValue(value)).toBeInTheDocument();
    }
    expect(screen.getByDisplayValue('reef')).toBeInTheDocument();
  });

  it('saves edited values', async () => {
    const onSave = open();
    const headline = screen.getByDisplayValue('A story headline');
    await userEvent.clear(headline);
    await userEvent.type(headline, 'A better headline');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ kidHeadline: 'A better headline' }));
  });

  it('sends a blank feeling note as null, not an empty string', async () => {
    const onSave = open();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ feelingNote: null }));
  });

  it('drops half-filled vocab rows on save', async () => {
    const onSave = open();
    await userEvent.click(screen.getByRole('button', { name: '+ Add word' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      vocab: [{ word: 'reef', definition: 'A ridge under the sea.' }],
    }));
  });

  it('removes a vocab row', async () => {
    const onSave = open();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ vocab: [] }));
  });
});

describe('RegenerateDialog (§4.2, story-scoped)', () => {
  const version = (age: number, over: Partial<AdminArticle> = {}, current: Partial<AdminArticle> = {}) => ({
    ageTarget: age,
    current: article({ id: `v${age}`, ageTarget: age, kidHeadline: `Stored age ${age}`, ...current }),
    generated: article({ id: `v${age}`, ageTarget: age, kidHeadline: `Fresh age ${age}`, ...over }),
    engine: 'llm',
  });

  const job = (versions: ReturnType<typeof version>[]): RegenerateJob => ({
    id: 'job-1', originalId: 'r1', kidHeadline: 'A story headline',
    startedAt: '2026-09-10T09:00:00.000Z', finishedAt: '2026-09-10T09:02:00.000Z',
    ages: versions.map((v) => v.ageTarget), done: versions.length, running: false,
    versions, costUsd: 0.0043,
  });

  const open = (state: RegenerateJob) => {
    const onApply = vi.fn();
    const onDiscard = vi.fn();
    render(<RegenerateDialog job={state} onDiscard={onDiscard} onApply={onApply} />);
    return { onApply, onDiscard };
  };

  it('offers one tab per age and opens on the youngest', () => {
    open(job([version(5), version(9), version(14)]));

    for (const age of [5, 9, 14]) {
      expect(screen.getByRole('tab', { name: new RegExp(`Age ${age}`) })).toBeInTheDocument();
    }
    expect(screen.getByText('Fresh age 5')).toBeInTheDocument();
    expect(screen.queryByText('Fresh age 14')).not.toBeInTheDocument();
  });

  it('switches the diff when another age is picked', async () => {
    open(job([version(5), version(14)]));

    await userEvent.click(screen.getByRole('tab', { name: /Age 14/ }));

    expect(screen.getByText('Fresh age 14')).toBeInTheDocument();
    expect(screen.queryByText('Fresh age 5')).not.toBeInTheDocument();
  });

  it('says how many fields would change for the age on screen', () => {
    open(job([version(5, { kidHeadline: 'Fresh age 5', summary: 'New summary.' })]));
    expect(screen.getByText(/2 field\(s\) would change/)).toBeInTheDocument();
  });

  it('says so when an age would not change at all', () => {
    open(job([version(5, { kidHeadline: 'Stored age 5' })]));
    expect(screen.getByText(/no differences/i)).toBeInTheDocument();
  });

  it('ticks every age a person has not edited', () => {
    open(job([version(5), version(6)]));

    expect(screen.getByRole('checkbox', { name: 'Apply age 5' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Apply 2 of 2 versions' })).toBeEnabled();
  });

  it('leaves a human-edited age unticked and warns about it', async () => {
    open(job([version(5), version(6, {}, { editedByHuman: true })]));

    expect(screen.getByRole('checkbox', { name: 'Apply age 6' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Apply 1 of 2 versions' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Age 6/ }));
    expect(screen.getByText(/edited by a person/i)).toBeInTheDocument();
  });

  it('applies exactly the ticked ages, ascending', async () => {
    const { onApply } = open(job([version(5), version(6), version(7)]));

    await userEvent.click(screen.getByRole('checkbox', { name: 'Apply age 6' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply 2 of 3 versions' }));

    expect(onApply).toHaveBeenCalledWith([5, 7]);
  });

  it('cannot apply nothing', async () => {
    open(job([version(5)]));

    await userEvent.click(screen.getByRole('checkbox', { name: 'Apply age 5' }));

    expect(screen.getByRole('button', { name: /Apply 0 of 1/ })).toBeDisabled();
  });

  it('unticks and re-ticks every age at once', async () => {
    open(job([version(5), version(6)]));

    await userEvent.click(screen.getByRole('button', { name: 'Untick all' }));
    expect(screen.getByRole('checkbox', { name: 'Apply age 5' })).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Tick all' }));
    expect(screen.getByRole('checkbox', { name: 'Apply age 5' })).toBeChecked();
  });

  it('names the preview cost, because it is spent either way', () => {
    open(job([version(5)]));
    expect(screen.getByText(/\$0\.0043/)).toBeInTheDocument();
  });

  it('says which ages fell back to the rule-based pipeline', () => {
    const fell = { ...version(5), fallbackReason: 'upstream exploded' };
    open(job([fell]));
    expect(screen.getByText(/rule-based pipeline: upstream exploded/)).toBeInTheDocument();
  });

  it('discards without applying', async () => {
    const { onDiscard, onApply } = open(job([version(5)]));

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(onDiscard).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('reading every age version before approving (§5)', () => {
  const story: AdminStory = {
    originalId: 'raw-1',
    versions: [
      article({ id: 'v5', originalId: 'raw-1', ageTarget: 5, kidHeadline: 'Headline for fives', summary: 'Summary for fives.' }),
      article({ id: 'v9', originalId: 'raw-1', ageTarget: 9, kidHeadline: 'Headline for nines', summary: 'Summary for nines.' }),
      article({ id: 'v14', originalId: 'raw-1', ageTarget: 14, kidHeadline: 'Headline for fourteens', summary: 'Summary for fourteens.' }),
    ],
    safety: 'calm',
    status: 'pending_review',
    approvedBy: null,
    kidHeadline: 'Headline for fives',
    category: 'World',
    sourceId: 'bbc',
    originalHeadline: 'Original headline',
    createdAt: '2026-09-04T10:00:00.000Z',
  };

  const open = () =>
    render(
      <ViewArticleDialog
        story={story}
        onClose={() => {}}
        onEdit={() => {}}
        onPublish={() => {}}
        onReject={() => {}}
      />,
    );

  it('opens on the youngest version', () => {
    open();
    expect(screen.getByText('Headline for fives')).toBeInTheDocument();
  });

  it('offers every age and switches the text', async () => {
    const user = userEvent.setup();
    open();

    for (const age of [5, 9, 14]) {
      expect(screen.getByRole('button', { name: `Age ${age}` })).toBeInTheDocument();
    }

    await user.click(screen.getByRole('button', { name: 'Age 14' }));

    expect(screen.getByText('Headline for fourteens')).toBeInTheDocument();
    expect(screen.getByText('Summary for fourteens.')).toBeInTheDocument();
    expect(screen.queryByText('Headline for fives')).not.toBeInTheDocument();
  });

  it('says how many versions Publish will approve', () => {
    open();
    expect(screen.getByRole('button', { name: /publish all 3/i })).toBeInTheDocument();
  });
});
