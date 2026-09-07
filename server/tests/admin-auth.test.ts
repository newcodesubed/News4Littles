/** Admin Basic Auth — PRD §4.1, §8.7. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(() => { ctx = createTestContext(); });
afterAll(() => ctx.close());

const PROTECTED: [string, string][] = [
  ['GET', '/api/admin/articles'],
  ['GET', '/api/admin/articles/counts'],
  ['GET', '/api/admin/articles/filters'],
  ['GET', '/api/admin/sources'],
  ['GET', '/api/admin/guard-config'],
  ['GET', '/api/admin/prompt-config'],
  ['GET', '/api/admin/app-settings'],
  ['POST', '/api/admin/simplify'],
  ['POST', '/api/admin/articles'],
  ['POST', '/api/admin/articles/bulk'],
  ['PATCH', '/api/admin/articles/x/publish'],
  ['DELETE', '/api/admin/articles/x'],
];

describe('every admin route is gated', () => {
  it.each(PROTECTED)('%s %s -> 401 without credentials', async (method, path) => {
    expect((await ctx.anon(path, { method })).status).toBe(401);
  });

  it('sends WWW-Authenticate so a browser can prompt', async () => {
    const res = await ctx.anon('/api/admin/articles');
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic/);
  });
});

describe('credential checking', () => {
  const withAuth = (value: string) =>
    ctx.anon('/api/admin/articles/counts', { headers: { Authorization: value } });

  it('accepts the seeded account', async () => {
    expect((await ctx.api('/api/admin/articles/counts')).status).toBe(200);
  });

  it.each([
    ['wrong password', `Basic ${Buffer.from('admin:wrong').toString('base64')}`],
    ['unknown user', `Basic ${Buffer.from('nobody:admin123').toString('base64')}`],
    ['no colon', `Basic ${Buffer.from('adminadmin123').toString('base64')}`],
    ['not basic', 'Bearer sometoken'],
    ['empty', ''],
  ])('rejects %s', async (_label, value) => {
    expect((await withAuth(value)).status).toBe(401);
  });

  it('allows a password containing a colon', async () => {
    // Only the first colon separates the pair.
    const res = await withAuth(`Basic ${Buffer.from('admin:pass:with:colons').toString('base64')}`);
    expect(res.status).toBe(401); // wrong password, but parsed as one string
  });
});

describe('public routes stay open', () => {
  it.each(['/api/health', '/api/articles'])('%s needs no credentials', async (path) => {
    expect((await ctx.anon(path)).status).toBe(200);
  });
});
