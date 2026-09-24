import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { LogOut, Menu, ShieldCheck, X } from 'lucide-react';
import { useAdminAuth } from '../../admin/AdminAuthContext';

/** Gate for every /admin/* route except the login page itself (§4.1). */
export function RequireAdmin() {
  const { isAuthenticated } = useAdminAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    // The query string too, so signing back in returns to the same filtered view.
    return <Navigate to="/admin/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

const NAV = [
  { to: '/admin/review', label: 'Review' },
  { to: '/admin/submit', label: 'Submit' },
  { to: '/admin/sandbox', label: 'Sandbox' },
  { to: '/admin/settings', label: 'Settings' },
];

const navClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-2 rounded-full text-sm font-semibold transition-colors ${
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'text-foreground/70 hover:text-foreground hover:bg-muted'
  }`;

const JOB_LABEL: Record<string, string> = {
  scrape: 'Scraping…',
  simplify: 'Simplifying…',
  regenerate: 'Regenerating…',
};

/**
 * The background job the server is running, if any. Only one runs at a time,
 * so without this an editor learns of it only when a click meets "already
 * running".
 */
function RunningJob() {
  const { adminFetch } = useAdminAuth();
  const [job, setJob] = useState<string | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const res = await adminFetch('/api/admin/jobs/active');
        if (res.ok) setJob(((await res.json()) as { job: string | null }).job ?? null);
      } catch {
        // Only a hint; the page works without it.
      }
    };
    void check();
    const timer = setInterval(() => void check(), 5000);
    return () => clearInterval(timer);
  }, [adminFetch]);

  const label = job ? JOB_LABEL[job] : undefined;
  if (!label) return null;
  return (
    <span role="status" className="rounded-full bg-surface-sun px-3 py-1 text-xs font-bold text-amber-800">
      {label}
    </span>
  );
}

export function AdminChrome() {
  const { signOut } = useAdminAuth();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 backdrop-blur-md bg-background/80 border-b border-border">
        <div className="container flex items-center justify-between gap-2 h-16">
          <Link to="/admin/review" className="flex items-center gap-2 min-w-0">
            <span className="w-9 h-9 shrink-0 rounded-2xl bg-gradient-sun grid place-items-center shadow-soft">
              <ShieldCheck className="w-5 h-5 text-primary-foreground" strokeWidth={2.5} />
            </span>
            <span className="font-display text-lg sm:text-xl leading-none whitespace-nowrap">
              Editor <span className="text-primary">Dashboard</span>
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-1">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} className={navClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="hidden md:flex items-center gap-2">
            <RunningJob />
            <Link
              to="/"
              className="px-3 py-2 rounded-full text-sm font-semibold text-foreground/70 hover:bg-muted"
            >
              View site
            </Link>
            <button
              onClick={signOut}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-semibold text-foreground/70 hover:bg-muted"
            >
              <LogOut className="w-4 h-4" /> Sign out
            </button>
          </div>

          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Menu"
            aria-expanded={menuOpen}
            aria-controls="admin-menu"
            className="md:hidden shrink-0 rounded-full p-2 text-foreground/70 hover:bg-muted"
          >
            {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {menuOpen && (
          <nav id="admin-menu" aria-label="Editor menu" className="md:hidden border-t border-border px-5 py-3 flex flex-col gap-1">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} className={navClass}>
                {item.label}
              </NavLink>
            ))}
            <Link
              to="/"
              className="px-3 py-2 rounded-full text-sm font-semibold text-foreground/70 hover:bg-muted"
            >
              View site
            </Link>
            <button
              onClick={signOut}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-semibold text-foreground/70 hover:bg-muted"
            >
              <LogOut className="w-4 h-4" /> Sign out
            </button>
          </nav>
        )}
      </header>

      <Outlet />
    </div>
  );
}
