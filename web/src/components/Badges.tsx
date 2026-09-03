import {
  Atom,
  Cpu,
  Globe2,
  HeartPulse,
  Leaf,
  Palette,
  ShieldCheck,
  Smile,
  Sparkles,
  TriangleAlert,
  Trophy,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Safety } from '../lib/types';

/** Category list and styling as used by the reference prototype. */
export const CATEGORIES = [
  'World',
  'Science',
  'Environment',
  'Health',
  'Culture',
  'Technology',
  'Sports',
  'Good News',
] as const;

const CATEGORY_CONFIG: Record<string, { icon: LucideIcon; cls: string; label: string }> = {
  World: { icon: Globe2, cls: 'bg-category-world/15 text-category-world', label: 'World' },
  Science: { icon: Atom, cls: 'bg-category-science/15 text-category-science', label: 'Science' },
  Environment: {
    icon: Leaf,
    cls: 'bg-category-environment/15 text-category-environment',
    label: 'Environment',
  },
  Health: { icon: HeartPulse, cls: 'bg-category-health/15 text-category-health', label: 'Health' },
  Culture: { icon: Palette, cls: 'bg-category-culture/15 text-category-culture', label: 'Culture' },
  Technology: {
    icon: Cpu,
    cls: 'bg-category-technology/15 text-category-technology',
    label: 'Technology',
  },
  Sports: { icon: Trophy, cls: 'bg-category-sports/15 text-category-sports', label: 'Sports' },
  'Good News': { icon: Smile, cls: 'bg-category-good/20 text-amber-700', label: 'Good News' },
};

const BADGE = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold';

export function CategoryBadge({ category }: { category: string }) {
  // Categories are free text in the database, so an unknown one still renders.
  const config = CATEGORY_CONFIG[category] ?? {
    icon: Sparkles,
    cls: 'bg-muted text-muted-foreground',
    label: category,
  };
  const Icon = config.icon;

  return (
    <span className={`${BADGE} ${config.cls}`}>
      <Icon className="w-3.5 h-3.5" strokeWidth={2.5} />
      {config.label}
    </span>
  );
}

const SAFETY_CONFIG: Record<Safety, { icon: LucideIcon; cls: string; label: string }> = {
  calm: { icon: ShieldCheck, cls: 'bg-safety-calm/15 text-safety-calm', label: 'Calm' },
  'adult-nearby': { icon: Users, cls: 'bg-safety-adult/20 text-amber-700', label: 'Grown-up nearby' },
  'skip-young': {
    icon: TriangleAlert,
    cls: 'bg-safety-skip/15 text-safety-skip',
    label: 'Skip for young kids',
  },
};

export function SafetyBadge({ safety }: { safety: Safety }) {
  const config = SAFETY_CONFIG[safety];
  const Icon = config.icon;

  return (
    <span className={`${BADGE} ${config.cls}`}>
      <Icon className="w-3.5 h-3.5" strokeWidth={2.5} />
      {config.label}
    </span>
  );
}
