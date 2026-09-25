/**
 * Which stdout target the logger picks. pino-pretty is a dev dependency, so a
 * production install (`npm ci --omit=dev`) does not have it — and asking pino
 * for a transport it cannot find kills the process at start-up. LOG_PRETTY
 * defaults to true, so that was the out-of-the-box result.
 */
import { describe, expect, it } from 'vitest';
import { chooseStdoutTarget } from '../src/logger.js';

const installed = () => true;
const missing = () => false;

describe('chooseStdoutTarget', () => {
  it('pretty-prints when asked and pino-pretty is installed', () => {
    const choice = chooseStdoutTarget(true, installed);
    expect(choice.target.target).toBe('pino-pretty');
    expect(choice.prettyUnavailable).toBe(false);
  });

  it('falls back to plain JSON on stdout when pino-pretty is not installed', () => {
    const choice = chooseStdoutTarget(true, missing);
    expect(choice.target).toEqual({ target: 'pino/file', options: { destination: 1 } });
    expect(choice.prettyUnavailable).toBe(true);
  });

  it('writes plain JSON when pretty output is off, without looking for pino-pretty', () => {
    let looked = false;
    const choice = chooseStdoutTarget(false, () => { looked = true; return true; });
    expect(choice.target.target).toBe('pino/file');
    expect(choice.prettyUnavailable).toBe(false);
    expect(looked).toBe(false);
  });
});
