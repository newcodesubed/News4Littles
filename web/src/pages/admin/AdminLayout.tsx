import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { LogOut, ShieldCheck } from 'lucide-react';
import { useAdminAuth } from '../../admin/AdminAuthContext';

/** Gate for every /admin/* route except the login page itself (§4.1). */
export function RequireAdmin() {
  const { isAuthenticated } = useAdminAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

export function AdminChrome() {
  const { signOut } = useAdminAuth();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 backdrop-blur-md bg-background/80 border-b border-border">
        <div className="container flex items-center justify-between h-16">
          <Link to="/admin/review" className="flex items-center gap-2">
            <span className="w-9 h-9 rounded-2xl bg-gradient-sun grid place-items-center shadow-soft">
              <ShieldCheck className="w-5 h-5 text-primary-foreground" strokeWidth={2.5} />
            </span>
            <span className="font-display text-xl leading-none">
              Editor <span className="text-primary">Dashboard</span>
            </span>
          </Link>

          <nav className="flex items-center gap-1">
            {[
              { to: '/admin/review', label: 'Review' },
              { to: '/admin/submit', label: 'Submit' },
              { to: '/admin/sandbox', label: 'Sandbox' },
              { to: '/admin/settings', label: 'Settings' },
            ].map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
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

          <div className="flex items-center gap-2">
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
        </div>
      </header>

      <Outlet />
    </div>
  );
}
