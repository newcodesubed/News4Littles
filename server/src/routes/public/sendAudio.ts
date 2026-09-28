import type { Request, Response } from 'express';
import type { AudioSuccess } from '../../services/audioService.js';

export function sendAudio(req: Request, res: Response, result: AudioSuccess): void {
  // The key hashes the script, model and voice, so it is a strong validator:
  // change any of them and the ETag changes with it.
  res.setHeader('ETag', `"${result.key}"`);
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Length', String(result.body.size));
  // Revalidate every time, or a regenerated story keeps playing the old audio.
  res.setHeader('Cache-Control', 'public, no-cache');

  if (req.headers['if-none-match'] === `"${result.key}"`) {
    res.status(304).end();
    return;
  }

  const audio = result.body.open();

  // Headers are already sent by the time a stream can fail, so there is no
  // error page to send; dropping the connection at least lets the browser
  // report a truncated file instead of treating half a story as complete.
  audio.on('error', (error: Error) => {
    req.log.error({ err: error, key: result.key }, 'audio stream failed');
    res.destroy();
  });
  // A listener who navigates away would otherwise leave the file handle open.
  res.on('close', () => audio.destroy());

  audio.pipe(res);
}
