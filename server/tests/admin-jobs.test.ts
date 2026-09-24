/** Which background job is running, for the admin header. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireJob, releaseJob } from '../src/services/jobLock.js';
import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeEach(() => { ctx = createTestContext(); releaseJob(); });
afterEach(() => { ctx.close(); releaseJob(); });

describe('GET /api/admin/jobs/active', () => {
  it('needs admin auth', async () => {
    expect((await ctx.anon('/api/admin/jobs/active')).status).toBe(401);
  });

  it('says nothing is running', async () => {
    expect(await (await ctx.api('/api/admin/jobs/active')).json()).toEqual({ job: null });
  });

  it('names the job holding the lock', async () => {
    acquireJob('simplify');
    expect(await (await ctx.api('/api/admin/jobs/active')).json()).toEqual({ job: 'simplify' });
  });
});
