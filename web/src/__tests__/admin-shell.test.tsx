/** Admin login, session handling and the route guard — PRD §4.1. */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthProvider, useAdminAuth } from '../admin/AdminAuthContext';
import { AdminLogin } from '../pages/admin/AdminLogin';
import { AdminChrome, RequireAdmin } from '../pages/admin/AdminLayout';

const STORAGE_KEY = 'news4littles.admin';

const reply = (status: number) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status < 400, status, json: async () => ({}) }) as unknown as Response));

function Protected() {
  return <p>secret content</p>;
}

const renderApp = (initial = '/admin/review') =>
  render(
    <MemoryRouter initialEntries={[initial]}>
      <AdminAuthProvider>
        <Routes>
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route element={<RequireAdmin />}>
            <Route path="/admin" element={<AdminChrome />}>
              <Route path="review" element={<Protected />} />
            </Route>
          </Route>
        </Routes>
      </AdminAuthProvider>
    </MemoryRouter>,
  );

beforeEach(() => window.sessionStorage.clear());
afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe('route guard', () => {
  it('sends a signed-out visitor to the login page', () => {
    reply(401);
    renderApp();
    expect(screen.getByText('Editor sign-in')).toBeInTheDocument();
    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
  });

  it('lets a signed-in editor through', () => {
    window.sessionStorage.setItem(STORAGE_KEY, btoa('admin:admin123'));
    reply(200);
    renderApp();
    expect(screen.getByText('secret content')).toBeInTheDocument();
  });
});

describe('sign in', () => {
  it('stores the credential and lands on the protected page', async () => {
    reply(200);
    renderApp();
    await userEvent.type(screen.getByLabelText('Username'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'admin123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('secret content')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(btoa('admin:admin123'));
  });

  it('verifies the credential before storing it', async () => {
    reply(401);
    renderApp();
    await userEvent.type(screen.getByLabelText('Username'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('explains an unreachable API rather than blaming the password', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    renderApp();
    await userEvent.type(screen.getByLabelText('Username'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'admin123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Could not reach the API/)).toBeInTheDocument();
  });

  it('sends the credential as HTTP Basic', async () => {
    reply(200);
    renderApp();
    await userEvent.type(screen.getByLabelText('Username'), 'admin');
    await userEvent.type(screen.getByLabelText('Password'), 'admin123');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa('admin:admin123')}`);
  });
});

describe('admin chrome', () => {
  beforeEach(() => window.sessionStorage.setItem(STORAGE_KEY, btoa('admin:admin123')));

  it('links to Review, Submit and Settings', () => {
    reply(200);
    renderApp();
    for (const label of ['Review', 'Submit', 'Settings']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('sign out clears the session and returns to login', async () => {
    reply(200);
    renderApp();
    await userEvent.click(screen.getByRole('button', { name: /Sign out/ }));
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(await screen.findByText('Editor sign-in')).toBeInTheDocument();
  });
});

describe('session expiry', () => {
  it('a 401 from any admin call signs the editor out', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, btoa('admin:admin123'));

    function Probe() {
      const { adminFetch, isAuthenticated } = useAdminAuth();
      return (
        <>
          <button onClick={() => void adminFetch('/api/admin/articles')}>call</button>
          <span>{isAuthenticated ? 'signed in' : 'signed out'}</span>
        </>
      );
    }

    reply(401);
    render(<MemoryRouter><AdminAuthProvider><Probe /></AdminAuthProvider></MemoryRouter>);
    expect(screen.getByText('signed in')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'call' }));
    expect(await screen.findByText('signed out')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
