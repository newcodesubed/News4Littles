import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { FIELD_CLASS_COMPACT, Select, TextInput } from '../../../ui/Field';
import { Section } from '../../../ui/Surface';
import { AGE_BANDS, ageBandLabel, formatAgeBand } from '../../../lib/ageBands';
import type { AppSettings, Save } from './types';

/** One model call per reading group, so this is the multiplier on the budget. */
const GROUP_COUNT = AGE_BANDS.length;

/** §8.7 app settings: default reading group, simplify budget, scrape times. */
export function AppSettingsSection({ settings, save }: { settings: AppSettings; save: Save }) {
  const [draft, setDraft] = useState(settings);
  const [newTime, setNewTime] = useState('');

  return (
    <Section title="App settings">
      {/* The group assumed when nothing names a reader — a scrape with no
          explicit target, or a feed request with no ?age=. Stored as the
          group's youngest age, which is all any consumer reads. */}
      <label className="block max-w-xs">
        <span className="text-sm font-bold">Default reading group</span>
        <Select
          value={draft.defaultAge} aria-label="Default reading group"
          onChange={(e) => setDraft({ ...draft, defaultAge: Number(e.target.value) })}
        >
          {AGE_BANDS.map((band) => (
            <option key={band.minAge} value={band.minAge}>{ageBandLabel(band.minAge)}</option>
          ))}
        </Select>
      </label>

      <label className="mt-5 block max-w-xs">
        <span className="text-sm font-bold">Simplifications per scrape run</span>
        <TextInput
          type="number" min={0} max={100} value={draft.simplifyBudget}
          onChange={(e) => setDraft({ ...draft, simplifyBudget: Number(e.target.value) })}
        />
      </label>
      <p className="mt-1 max-w-prose text-xs text-muted-foreground">
        How many stored stories a run may send to the model. Each story is rewritten once for
        every reading group (ages {AGE_BANDS.map(formatAgeBand).join(', ')}), so{' '}
        <strong>
          {draft.simplifyBudget} stories is {draft.simplifyBudget * GROUP_COUNT} model calls
        </strong>
        . The rest are kept as they came in, costing nothing, and wait in the review queue’s
        “Not yet simplified” tab until you ask for them. 0 means simplify nothing
        automatically.
      </p>

      <p className="mt-5 text-sm font-bold">Scrape times</p>
      <p className="text-xs text-muted-foreground mb-2">
        When the scraper runs each day. Changes take effect when the server restarts.
      </p>

      <div className="flex flex-wrap gap-2">
        {draft.scrapeTimes.map((time) => (
          <span key={time} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-sm font-bold">
            {time}
            <button
              aria-label={`Remove ${time}`}
              onClick={() => setDraft({ ...draft, scrapeTimes: draft.scrapeTimes.filter((t) => t !== time) })}
              className="rounded-full p-0.5 hover:bg-background"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </span>
        ))}
      </div>

      <div className="mt-2 flex gap-2">
        <input type="time" value={newTime} aria-label="Add scrape time"
          onChange={(e) => setNewTime(e.target.value)} className={FIELD_CLASS_COMPACT} />
        <Button variant="outline"
          onClick={() => {
            if (!newTime) return;
            setDraft({ ...draft, scrapeTimes: [...draft.scrapeTimes, newTime] });
            setNewTime('');
          }}
        >
          Add time
        </Button>
      </div>

      <p className="mt-5 text-xs text-muted-foreground">API key: {settings.apiKeyLocation}.</p>

      <Button
        size="lg"
        className="mt-5"
        onClick={async () => {
          const ok = await save('/api/admin/app-settings', { method: 'PUT', body: JSON.stringify(draft) }, 'App settings saved.');
          // A rejected save must not leave the form showing values the server never took.
          if (!ok) setDraft(settings);
        }}
      >
        Save app settings
      </Button>
    </Section>
  );
}
