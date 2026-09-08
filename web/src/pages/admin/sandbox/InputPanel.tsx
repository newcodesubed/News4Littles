import { Field, Select, TextArea } from '../../../ui/Field';
import { Card } from '../../../ui/Surface';
import type { PromptTarget, RawArticleSummary } from './types';

const AGES = Array.from({ length: 10 }, (_, i) => i + 5);

/** §7.3 panel 1: what is being edited, and what it is tested against. */
export function InputPanel({
  target, age, articleId, rawText, headline, articles, defaultAge,
  onChange,
}: {
  target: PromptTarget;
  age: number | null;
  articleId: string;
  rawText: string;
  headline: string;
  articles: RawArticleSummary[];
  defaultAge: number;
  onChange: (patch: Partial<{ target: PromptTarget; age: number | null; articleId: string; rawText: string; headline: string }>) => void;
}) {
  const usingPastedText = articleId === '';

  return (
    <Card className="space-y-4">
      <h2 className="font-display text-xl">1. What to test</h2>

      <Field label="Prompt">
        <Select value={target} onChange={(e) => onChange({ target: e.target.value as PromptTarget, age: null })}>
          <option value="simplification">Simplification</option>
          <option value="guard">Safety guard</option>
        </Select>
      </Field>

      {/* §7.3: the age target applies to simplification prompts only. */}
      {target === 'simplification' && (
        <Field
          label="Prompt variant"
          hint="A variant edits the prompt used for that one age. Generic covers every other age."
        >
          <Select
            value={age === null ? 'generic' : String(age)}
            onChange={(e) => onChange({ age: e.target.value === 'generic' ? null : Number(e.target.value) })}
          >
            <option value="generic">Generic (all ages)</option>
            {AGES.map((value) => (
              <option key={value} value={value}>Age {value} override</option>
            ))}
          </Select>
        </Field>
      )}

      <Field label="Test article">
        <Select value={articleId} onChange={(e) => onChange({ articleId: e.target.value })}>
          <option value="">Paste my own text…</option>
          {articles.map((article) => (
            <option key={article.id} value={article.id}>
              {article.headline.slice(0, 70)} · {article.sourceName}
            </option>
          ))}
        </Select>
      </Field>

      {usingPastedText ? (
        <>
          <Field label="Headline">
            <input
              value={headline}
              onChange={(e) => onChange({ headline: e.target.value })}
              placeholder="Original headline"
              className="mt-1 w-full rounded-xl border border-border bg-background px-4 py-2.5"
            />
          </Field>
          <Field label="Article text">
            <TextArea rows={8} value={rawText} onChange={(e) => onChange({ rawText: e.target.value })}
              placeholder="Paste an article to test against." />
          </Field>
        </>
      ) : (
        <Field label="Article text (read-only)" hint="Raw source text. Editing happens in the prompt, not here.">
          <TextArea
            rows={8}
            readOnly
            value={articles.find((a) => a.id === articleId)?.headline ?? ''}
            className="bg-muted/50 text-muted-foreground"
          />
        </Field>
      )}

      {target === 'simplification' && (
        <p className="text-xs text-muted-foreground">
          Runs at age {age ?? defaultAge}{age === null && ' (the app default)'}.
        </p>
      )}
    </Card>
  );
}
