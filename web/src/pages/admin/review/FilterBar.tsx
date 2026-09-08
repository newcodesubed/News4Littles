import { AlertTriangle, Search } from 'lucide-react';
import { CategoryBadge } from '../../../components/Badges';
import { Button } from '../../../ui/Button';
import { Chip } from '../../../ui/Surface';
import { EMPTY_FILTERS, type FilterOptions, type Filters } from '../../../admin/types';

const SORTS = [
  { value: 'createdAt', label: 'Created' },
  { value: 'publishedAt', label: 'Published' },
  { value: 'readingMinutes', label: 'Reading time' },
  { value: 'ageTarget', label: 'Age target' },
];

const SAFETY_VALUES = ['calm', 'adult-nearby', 'skip-young'] as const;

/** The §4.2 filter bar: search, sort, safety, category, source, age, dates. */
export function FilterBar({
  filters,
  options,
  onChange,
}: {
  filters: Filters;
  options: FilterOptions | null;
  onChange: (filters: Filters) => void;
}) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ ...filters, [key]: value });

  const toggleIn = (key: 'categories' | 'safety' | 'sources' | 'ageTargets', value: string) =>
    onChange({
      ...filters,
      [key]: filters[key].includes(value)
        ? filters[key].filter((entry) => entry !== value)
        : [...filters[key], value],
    });

  /** A labelled row of chips, the shape every filter group shares. */
  const Group = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground w-16">{label}</span>
      {children}
    </div>
  );

  return (
    <div className="mt-5 rounded-3xl border border-border bg-card p-5 shadow-soft space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative grow min-w-60">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filters.q}
            onChange={(e) => set('q', e.target.value)}
            placeholder="Search kid headline, summary or original headline…"
            aria-label="Search"
            className="w-full rounded-full border border-border bg-background py-2.5 pl-9 pr-4 text-sm"
          />
        </div>

        <label className="flex items-center gap-2 text-sm font-bold">
          Sort
          <select
            value={filters.sort}
            onChange={(e) => set('sort', e.target.value)}
            className="rounded-full border border-border bg-background px-3 py-2"
          >
            {SORTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>

        <Button variant="outline" onClick={() => set('order', filters.order === 'desc' ? 'asc' : 'desc')}>
          {filters.order === 'desc' ? 'Newest first ↓' : 'Oldest first ↑'}
        </Button>

        <Button variant="ghost" className="text-muted-foreground"
          onClick={() => onChange({ ...EMPTY_FILTERS, status: filters.status })}>
          Clear filters
        </Button>
      </div>

      <Group label="Safety">
        {/* §4.2: one click selects adult-nearby + skip-young together. */}
        <Chip
          active={filters.flagged}
          className="inline-flex items-center gap-1.5"
          onClick={() => onChange({ ...filters, flagged: !filters.flagged, safety: [] })}
        >
          <AlertTriangle className="w-3.5 h-3.5" /> Flagged only
        </Chip>
        {SAFETY_VALUES.map((value) => (
          <Chip
            key={value}
            active={!filters.flagged && filters.safety.includes(value)}
            onClick={() => onChange({
              ...filters,
              flagged: false,
              safety: filters.safety.includes(value)
                ? filters.safety.filter((entry) => entry !== value)
                : [...filters.safety, value],
            })}
          >
            {value}
          </Chip>
        ))}
      </Group>

      {options && (
        <>
          <Group label="Category">
            {options.categories.map((value) => (
              <button key={value} onClick={() => toggleIn('categories', value)}
                className={filters.categories.includes(value) ? 'ring-2 ring-foreground rounded-full' : ''}>
                <CategoryBadge category={value} />
              </button>
            ))}
          </Group>

          <Group label="Source">
            {options.sources.map((source) => (
              <Chip key={source.id} active={filters.sources.includes(source.id)}
                onClick={() => toggleIn('sources', source.id)}>
                {source.name}
              </Chip>
            ))}
          </Group>

          <Group label="Age">
            {options.ageTargets.map((age) => (
              <Chip key={age} active={filters.ageTargets.includes(String(age))}
                onClick={() => toggleIn('ageTargets', String(age))}>
                {age}
              </Chip>
            ))}
          </Group>
        </>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground w-16">Created</span>
        <input type="date" value={filters.createdFrom} aria-label="Created from"
          onChange={(e) => set('createdFrom', e.target.value)}
          className="rounded-full border border-border bg-background px-3 py-2" />
        <span className="text-muted-foreground">to</span>
        <input type="date" value={filters.createdTo} aria-label="Created to"
          onChange={(e) => set('createdTo', e.target.value)}
          className="rounded-full border border-border bg-background px-3 py-2" />
      </div>
    </div>
  );
}
