import { Link, NavLink } from 'react-router-dom';
import { Sparkles } from 'lucide-react';

/**
 * Sticky header, matching the prototype.
 *
 * The prototype's nav also carries "Submit Article" and "Editor Review". Those
 * are admin routes (PRD §4.1) and are not built yet, so they are omitted rather
 * than linking to a 404.
 */
const NAV = [
  { to: '/', label: 'Today' },
  { to: '/podcast', label: 'Podcast' },
  { to: '/about', label: 'About' },
  { to: '/settings', label: 'Settings' },
];

export function Header() {
  return (
    <header className="sticky top-0 z-40 backdrop-blur-md bg-background/80 border-b border-border">
      <div className="container flex items-center justify-between h-16">
        <Link to="/" className="flex items-center gap-2 group">
          <span className="w-9 h-9 rounded-2xl bg-gradient-sun grid place-items-center shadow-soft group-hover:rotate-6 transition-transform">
            <Sparkles className="w-5 h-5 text-primary-foreground" strokeWidth={2.5} />
          </span>
          <span className="font-display text-xl leading-none">
            News for <span className="text-primary">Curious Kids</span>
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `px-3 py-2 rounded-full text-sm font-semibold transition-colors ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-foreground/70 hover:text-foreground hover:bg-muted'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <nav className="md:hidden flex gap-1 overflow-x-auto px-4 pb-3 text-sm">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `whitespace-nowrap px-3 py-1.5 rounded-full font-semibold transition-colors ${
                isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground/70'
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
