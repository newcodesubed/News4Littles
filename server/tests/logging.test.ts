/**
 * What the server writes to its log for a request that succeeds, one the
 * client got wrong, and one that blew up. The logger writes to memory here,
 * so the lines can be read back as JSON.
 */
import { Writable } from 'node:stream';
import pino from 'pino';
import { createTestContext, type TestContext } from './helpers.js';

interface Line {
  level: number;
  msg: string;
  reqId?: string;
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  reason?: string;
  err?: { type: string; message: string; stack?: string };
}

const INFO = 30;
const WARN = 40;
const ERROR = 50;

function captureLogger() {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const logger = pino({ redact: ['req.headers.authorization'] }, sink);
  const lines = () => chunks.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
  const raw = () => chunks.join('');
  return { logger, lines, raw, reset: () => chunks.splice(0) };
}

describe('request logging', () => {
  let ctx: TestContext;
  const log = captureLogger();

  beforeAll(() => { ctx = createTestContext({ logger: log.logger }); });
  afterAll(() => ctx.close());
  beforeEach(() => log.reset());

  it('writes a started and a completed line sharing the request id', async () => {
    const res = await ctx.anon('/api/health');
    expect(res.status).toBe(200);

    const [started, completed] = log.lines();
    expect(started).toMatchObject({ level: INFO, msg: 'request started', method: 'GET', url: '/api/health' });
    expect(completed).toMatchObject({ level: INFO, msg: 'request completed', status: 200 });
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    expect(started.reqId).toBe(completed.reqId);
    expect(res.headers.get('x-request-id')).toBe(started.reqId);
  });

  it('gives every request its own id', async () => {
    await ctx.anon('/api/health');
    await ctx.anon('/api/health');
    const ids = new Set(log.lines().map((l) => l.reqId));
    expect(ids.size).toBe(2);
  });

  it('warns with the reason, and no stack, when the client is wrong', async () => {
    const res = await ctx.anon('/api/articles/no-such-id');
    expect(res.status).toBe(404);

    const failed = log.lines().find((l) => l.msg === 'request failed');
    expect(failed).toMatchObject({ level: WARN, status: 404, reason: "No article with id 'no-such-id'." });
    expect(failed?.err).toBeUndefined();
    expect(log.raw()).not.toContain('"stack"');
  });

  it('treats an unmatched route like any other 404', async () => {
    const res = await ctx.anon('/api/nowhere');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found.' });
    expect(log.lines().find((l) => l.msg === 'request failed')).toMatchObject({ status: 404, reason: 'Not found.' });
  });

  it('warns on a body that is not JSON', async () => {
    const res = await ctx.api('/api/admin/settings', { method: 'PUT', body: '{not json' });
    expect(res.status).toBe(400);
    expect(log.lines().find((l) => l.msg === 'request failed')).toMatchObject({ status: 400, reason: 'invalid JSON body' });
  });

  it('never writes the admin credentials', async () => {
    await ctx.api('/api/admin/settings');
    expect(log.raw()).not.toContain('Basic ');
    expect(log.raw()).not.toContain('admin123');
  });
});

describe('unhandled errors', () => {
  it('logs the stack at error level, tied to the request', async () => {
    const log = captureLogger();
    const ctx = createTestContext({ logger: log.logger });
    // A closed connection makes the repository throw a plain Error, not an AppError.
    ctx.db.close();

    const res = await ctx.anon('/api/articles');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Something went wrong on the server.' });

    const [started, unhandled, completed] = log.lines();
    expect(unhandled).toMatchObject({ level: ERROR, msg: 'unhandled error', reqId: started.reqId });
    expect(unhandled.err?.stack).toContain('Error');
    expect(completed).toMatchObject({ msg: 'request completed', status: 500, reqId: started.reqId });

    ctx.close();
  });
});
