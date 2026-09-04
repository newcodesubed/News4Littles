import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { AdminAuthError, useAdminAuth } from '../../admin/AdminAuthContext';

/** /admin/login — PRD §4.1. */
export function AdminLogin() {
  const { signIn } = useAdminAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/admin/review';

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username, password);
      navigate(from, { replace: true });
    } catch (caught: unknown) {
      setError(caught instanceof AdminAuthError ? caught.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container max-w-md py-20">
      <div className="bg-card rounded-3xl border border-border p-8 shadow-card">
        <span className="w-11 h-11 rounded-2xl bg-primary/10 text-primary grid place-items-center mb-4">
          <Lock className="w-5 h-5" />
        </span>
        <h1 className="font-display text-3xl mb-1">Editor sign-in</h1>
        <p className="text-muted-foreground text-sm mb-6">
          The review queue is for editors. Nothing here is visible to readers.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-bold">Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              className="mt-1 w-full rounded-xl border border-border bg-background px-4 py-2.5"
            />
          </label>

          <label className="block">
            <span className="text-sm font-bold">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="mt-1 w-full rounded-xl border border-border bg-background px-4 py-2.5"
            />
          </label>

          {error && (
            <p role="alert" className="text-sm font-semibold text-destructive">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-full bg-primary px-5 py-3 font-bold text-primary-foreground shadow-pop disabled:opacity-60"
          >
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
