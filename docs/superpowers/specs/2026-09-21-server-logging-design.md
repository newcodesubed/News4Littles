# Server logging — design

**Date:** 2026-09-21
**Status:** implemented

## 1. Problem

The server writes 35 `console.*` lines with hand-made prefixes — `[scrape]`,
`[tts]`, `[auto]`, `[error]` — and nothing else. Three things are missing.

**Requests are invisible.** No line says a request arrived or what it
answered, so a slow endpoint, a request that never finishes and a client that
walked away all look the same: silence.

**Errors lose their context.** `errorHandler` prints an unhandled error, but
nothing ties it to the request that caused it. The background jobs log
`error.message` strings, so the stack is gone before anyone reads it.

**Nothing is kept.** Everything goes to the terminal. Restart the process and
yesterday's failure is gone.

## 2. Decision

One [pino](https://github.com/pinojs/pino) logger, built in `src/logger.ts`,
writing JSON to a rolling file and, in development, pretty text to the
terminal. Every request gets two lines; every error gets one; background jobs
log through child loggers named by area.

### Happy path: two lines per request, not one

The obvious design — one completion line carrying method, status and duration,
which is what `pino-http` emits — was rejected because it says nothing about a
request that never completes. A handler that awaits a hung provider call never
reaches `finish`, so the request leaves no trace at all.

So a small middleware of our own, `src/http/middleware/requestLogger.ts`, logs:

| when                       | level | message             | fields                          |
|----------------------------|-------|---------------------|---------------------------------|
| request arrives            | info  | `request started`   | `reqId`, `method`, `url`        |
| response finishes          | info  | `request completed` | `reqId`, `status`, `durationMs` |
| socket closes, no finish   | warn  | `request aborted`   | `reqId`, `durationMs`           |

A hang is a `started` with no `completed`. The `aborted` line is already a
real case: a listener leaving mid-stream on the audio route.

`reqId` is a random id attached to `req` and echoed as the `X-Request-Id`
response header, so a failure a user reports can be found in the file.
`req.log` is a child logger carrying that id, and that is what the error
handler logs through, so the error and its request share one key.

Routes log nothing on the happy path. Entry and exit are enough.

### Error path

`errorHandler` is the one place errors are seen, so it is the one place they
are logged:

- **`AppError` (400/401/404/409)** — `warn` with `status` and the message, no
  stack. These are client mistakes, not bugs; a stack trace for "No article
  with id 'x'" is noise.
- **anything else (500)** — `error` with pino's `err` serializer: type,
  message and full stack.

The `request completed` line still follows, so a failed request always leaves
a pair.

Background paths — the scheduler, scrape runs, auto-approve, TTS synthesis —
have no request, so they log through `logger.child({ area })`. The prefix
that used to be `[scrape]` becomes `area: "scrape"`, and a caught error is
passed as `{ err }` rather than flattened to its message.

### Where the lines go

Two transport targets, both configured in `src/logger.ts`:

- **`pino-roll`** writes JSON to `LOG_DIR/server.1.log`, and starts a new
  file when the current one reaches **5 MB**: `server.2.log`, `server.3.log`,
  … The newest **10** are kept and older ones deleted, so the directory is
  bounded at roughly 50 MB. `mkdir: true`, so a fresh clone needs no setup.
- **stdout** — `pino-pretty` when `LOG_PRETTY=true` (the default, meant for
  `npm run dev`), raw JSON when `false` (production, where a process manager
  captures stdout).

`req.headers.authorization` is redacted. The admin uses Basic Auth, so without
this the credentials would sit in every `request started` line on disk.

### What stays on `console`

The CLI scripts (`db:init`, `db:seed`, `seed`) and the startup banner in
`server.ts` print for the person who ran the command. That is terminal output,
not a log, and it stays as it is.

## 3. Configuration

Three new variables in `src/env.ts` and `.env.example`:

| variable     | default     | meaning                                        |
|--------------|-------------|------------------------------------------------|
| `LOG_LEVEL`  | `info`      | pino level; `silent` turns everything off      |
| `LOG_DIR`    | `data/logs` | rolling-file directory, relative to `/server`  |
| `LOG_PRETTY` | `true`      | pretty terminal output; `false` for raw JSON   |

`data/` is already gitignored.

## 4. Testing

`createApp(db, { logger })` takes an optional logger. Suites that assert on
logging pass a pino instance writing to an in-memory stream and check:

- a request produces `started` then `completed` with the same `reqId`, a
  `status` and a `durationMs`;
- the `X-Request-Id` header matches the `reqId` in both lines;
- a 4xx produces a `warn` carrying the message and no stack;
- a thrown non-`AppError` produces an `error` carrying a stack;
- the `authorization` header is redacted.

Every other suite runs with `LOG_LEVEL=silent` in `vitest.config.ts`. File
rotation is `pino-roll`'s tested behaviour and is not re-tested here.

## 5. Out of scope

Log shipping, per-route debug logging, and request-body logging. The last is
deliberately absent: bodies carry article text and admin edits, and the point
of the request line is to be short.
