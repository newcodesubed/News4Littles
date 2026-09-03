import { Link, NavLink, Outlet } from 'react-router-dom';

/** Header nav — PRD §3.2. Admin links are deliberately absent (out of scope). */
const NAV = [
  { to: '/', label: 'Today', end: true },
  { to: '/podcast', label: 'Podcast', end: false },
  { to: '/about', label: 'About', end: false },
  { to: '/settings', label: 'Settings', end: false },
];

export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-paper-deep bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-5 py-4">
          <Link to="/" className="flex items-center gap-2 font-display text-xl font-bold">
            <span aria-hidden="true" className="text-2xl">
              📰
            </span>
            News4Littles
          </Link>

          <nav aria-label="Main">
            <ul className="flex items-center gap-1 text-sm font-bold">
              {NAV.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      `rounded-full px-3 py-2 transition ${
                        isActive ? 'bg-brand-wash text-brand-deep' : 'text-ink-soft hover:bg-paper-deep'
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl grow px-5 py-10">
        <Outlet />
      </main>

      <footer className="border-t border-paper-deep px-5 py-8 text-center text-sm text-ink-soft">
        <p>Calm, true stories from trusted news sources — rewritten for young readers.</p>
        <p className="mt-1">Every story is read by a grown-up editor before it appears here.</p>
      </footer>
    </div>
  );
}
