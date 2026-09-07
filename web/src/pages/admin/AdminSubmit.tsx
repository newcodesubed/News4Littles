import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { CategoryBadge, CATEGORIES, SafetyBadge } from '../../components/Badges';
import { useAdminAuth } from '../../admin/AdminAuthContext';
import type { KidArticle } from '../../lib/types';

/**
 * Editor portal — PRD §4.3.
 *
 * "Simplify with AI" calls POST /api/admin/simplify, which runs the local
 * rule-based pipeline (§9.2). There is no LLM configured, and this page makes
 * no model calls of any kind.
 */
interface GuardInfo {
  matches: string[];
  safety: string;
  denyListEnabled: boolean;
  engine: string;
}

const AGES = Array.from({ length: 10 }, (_, i) => i + 5); // 5–14 (§4.3)

const field = 'mt-1 w-full rounded-xl border border-border bg-background px-4 py-2.5';

export function AdminSubmit() {
  const { adminFetch } = useAdminAuth();

  const [form, setForm] = useState({
    headline: '',
    sourceName: '',
    sourceUrl: '',
    body: '',
    category: 'World',
    ageTarget: 6,
  });

  const [preview, setPreview] = useState<KidArticle | null>(null);
  const [guard, setGuard] = useState<GuardInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    // The pasted text changed, so the preview no longer reflects it.
    setPreview(null);
    setGuard(null);
  };

  const setPreviewField = <K extends keyof KidArticle>(key: K, value: KidArticle[K]) =>
    setPreview((current) => (current ? { ...current, [key]: value } : current));

  async function simplify() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await adminFetch('/api/admin/simplify', { method: 'POST', body: JSON.stringify(form) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not simplify.');
      setPreview(body.article as KidArticle);
      setGuard(body.guard as GuardInfo);
      setNotice('Simplified. Review the output below, then save — nothing has been saved yet.');
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not simplify.');
    } finally {
      setBusy(false);
    }
  }

  async function save(status: 'pending_review' | 'published') {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload: Record<string, unknown> = { ...form, status };
      if (preview) {
        // Only the kid-facing TEXT is sent; safety is re-derived server-side.
        payload.kidHeadline = preview.kidHeadline;
        payload.summary = preview.summary;
        payload.whatHappened = preview.whatHappened;
        payload.whyItMatters = preview.whyItMatters;
        payload.thinkAbout = preview.thinkAbout;
        payload.readingMinutes = preview.readingMinutes;
        payload.vocab = preview.vocab;
      }

      const res = await adminFetch('/api/admin/articles', { method: 'POST', body: JSON.stringify(payload) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');

      setNotice(
        status === 'published'
          ? 'Published — it is live on the site now.'
          : 'Sent to the review queue as pending review.',
      );
      setForm({ headline: '', sourceName: '', sourceUrl: '', body: '', category: 'World', ageTarget: form.ageTarget });
      setPreview(null);
      setGuard(null);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  const complete = form.headline.trim() && form.sourceName.trim() && form.sourceUrl.trim() && form.body.trim();

  return (
    <div className="container max-w-4xl py-10">
      <h1 className="font-display text-4xl mb-1">Submit an article</h1>
      <p className="text-muted-foreground mb-6">
        Paste a story, simplify it, check the result, then send it to the review queue. It is filed
        under the <strong>manual</strong> source.
      </p>

      <div className="rounded-3xl border border-border bg-card p-6 shadow-soft space-y-4">
        <label className="block">
          <span className="text-sm font-bold">Original headline</span>
          <input value={form.headline} onChange={(e) => set('headline', e.target.value)} className={field} />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-bold">Source name</span>
            <input value={form.sourceName} onChange={(e) => set('sourceName', e.target.value)}
              placeholder="e.g. BBC News" className={field} />
          </label>
          <label className="block">
            <span className="text-sm font-bold">Source URL</span>
            <input value={form.sourceUrl} onChange={(e) => set('sourceUrl', e.target.value)}
              placeholder="https://…" className={field} />
          </label>
        </div>

        <div>
          <label className="block">
            <span className="text-sm font-bold">Article text</span>
            <textarea value={form.body} onChange={(e) => set('body', e.target.value)} rows={10}
              placeholder="Paste the full article text here." className={field} />
          </label>
          {/* Outside the <label> so it does not become part of the field's name. */}
          <p className="mt-1 text-xs text-muted-foreground">
            {form.body.trim() ? `${form.body.trim().split(/\s+/).length} words` : 'No text yet'}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-bold">Category</span>
            <select value={form.category} onChange={(e) => set('category', e.target.value)} className={field}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-bold">Age target</span>
            <select value={form.ageTarget} onChange={(e) => set('ageTarget', Number(e.target.value))} className={field}>
              {AGES.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
        </div>

        <button
          onClick={simplify}
          disabled={!complete || busy}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3 font-bold text-primary-foreground shadow-pop disabled:opacity-50"
        >
          <Sparkles className="w-4 h-4" /> {busy ? 'Working…' : 'Simplify with AI'}
        </button>
        <p className="text-xs text-muted-foreground">
          No AI key is configured, so this runs the local rule-based simplifier. Nothing is saved
          until you choose an action below.
        </p>
      </div>

      {error && <p role="alert" className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">{error}</p>}
      {notice && <p role="status" className="mt-4 rounded-2xl bg-muted px-4 py-3 text-sm font-semibold">{notice}</p>}

      {preview && (
        <div className="mt-6 rounded-3xl border border-border bg-card p-6 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h2 className="font-display text-2xl">Review output</h2>
            <span className="rounded-full bg-muted px-3 py-1 text-xs font-bold">
              model: {guard?.engine ?? 'local-fallback'}
            </span>
          </div>

          <div className="mb-5 flex flex-wrap items-center gap-2">
            <CategoryBadge category={preview.category} />
            <SafetyBadge safety={preview.safety} />
            <span className="text-xs font-semibold text-muted-foreground">
              Age {preview.ageTarget} · {preview.readingMinutes} min
            </span>
          </div>

          {guard && (
            <p className="mb-5 rounded-2xl bg-muted px-4 py-3 text-sm">
              <strong>Guard:</strong>{' '}
              {!guard.denyListEnabled
                ? 'the deny-list guard is switched off in settings, so everything reads as calm.'
                : guard.matches.length === 0
                  ? 'no deny-list words found.'
                  : `matched ${guard.matches.length} deny-list word(s): ${guard.matches.join(', ')}.`}{' '}
              Safety is decided by the guard on save — you cannot change it here. Use the review
              queue’s Edit if it is wrong.
            </p>
          )}

          <div className="space-y-4">
            {([
              ['kidHeadline', 'Kid headline', 1],
              ['summary', 'Summary', 2],
              ['whatHappened', 'What happened?', 4],
              ['whyItMatters', 'Why it matters', 3],
              ['thinkAbout', 'Think about', 2],
            ] as const).map(([key, label, rows]) => (
              <label key={key} className="block">
                <span className="text-sm font-bold">{label}</span>
                {rows === 1 ? (
                  <input value={preview[key] as string} onChange={(e) => setPreviewField(key, e.target.value)} className={field} />
                ) : (
                  <textarea value={preview[key] as string} rows={rows}
                    onChange={(e) => setPreviewField(key, e.target.value)} className={field} />
                )}
              </label>
            ))}

            {preview.feelingNote && (
              <div className="rounded-2xl bg-surface-sky px-4 py-3">
                <p className="text-sm font-bold">Feeling note (added because this story is not calm)</p>
                <p className="mt-1 text-sm">{preview.feelingNote}</p>
              </div>
            )}

            <div>
              <span className="text-sm font-bold">Words to know</span>
              <div className="mt-1 space-y-2">
                {preview.vocab.map((entry, index) => (
                  <div key={index} className="flex flex-wrap gap-2">
                    <input value={entry.word} aria-label={`Word ${index + 1}`}
                      onChange={(e) => setPreviewField('vocab', preview.vocab.map((v, i) => i === index ? { ...v, word: e.target.value } : v))}
                      className="w-40 rounded-xl border border-border bg-background px-3 py-2" />
                    <input value={entry.definition} aria-label={`Definition ${index + 1}`}
                      onChange={(e) => setPreviewField('vocab', preview.vocab.map((v, i) => i === index ? { ...v, definition: e.target.value } : v))}
                      className="flex-1 min-w-48 rounded-xl border border-border bg-background px-3 py-2" />
                    <button onClick={() => setPreviewField('vocab', preview.vocab.filter((_, i) => i !== index))}
                      className="rounded-full px-3 py-2 text-sm font-bold text-destructive hover:bg-muted">Remove</button>
                  </div>
                ))}
                <button onClick={() => setPreviewField('vocab', [...preview.vocab, { word: '', definition: '' }])}
                  className="rounded-full border border-border px-4 py-2 text-sm font-bold hover:bg-muted">+ Add word</button>
              </div>
            </div>

            {preview.contentWarnings && preview.contentWarnings.length > 0 && (
              <p className="text-sm">
                <strong>Content warnings:</strong> {preview.contentWarnings.join(', ')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* §4.3 actions. "Save draft" is deliberately absent — see the notes. */}
      <div className="mt-6 flex flex-wrap gap-3 border-t border-border pt-6">
        <button onClick={() => save('pending_review')} disabled={!complete || busy}
          className="rounded-full bg-primary px-5 py-3 font-bold text-primary-foreground shadow-pop disabled:opacity-50">
          Send for review
        </button>
        <button
          onClick={() => { if (window.confirm('Publish straight to the site, without going through the review queue?')) void save('published'); }}
          disabled={!complete || busy}
          className="rounded-full border border-border px-5 py-3 font-bold hover:bg-muted disabled:opacity-50">
          Publish now
        </button>
        <p className="w-full text-xs text-muted-foreground">
          You can save without simplifying — the pipeline runs on the server either way.
        </p>
      </div>
    </div>
  );
}
