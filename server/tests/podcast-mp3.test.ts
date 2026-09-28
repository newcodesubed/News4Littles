/**
 * Joining the spoken pieces of an episode into one MP3 (spec §7.3).
 *
 * Each piece the voice returns is a whole file: often an ID3 tag, then a
 * Xing/Info (or VBRI) frame that states THAT piece's length, then the audio.
 * Glued together as-is, the first piece's header tells the browser the whole
 * episode is one piece long — the progress bar fills early and some players
 * stop there. These frames are built by hand, so no real audio is needed.
 */
import { describe, expect, it } from 'vitest';
import { joinMp3 } from '../src/podcast/joinMp3.js';

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding: 417 bytes a frame. */
const STEREO = [0xff, 0xfb, 0x90, 0x00];
const MONO = [0xff, 0xfb, 0x90, 0xc0];
const FRAME_BYTES = 417;

function frame(header: number[], fill: number, tag?: { at: number; text: string }): Buffer {
  const bytes = Buffer.alloc(FRAME_BYTES, fill);
  Buffer.from(header).copy(bytes, 0);
  if (tag) bytes.write(tag.text, tag.at, 'latin1');
  return bytes;
}

/** An ID3v2.4 tag with `size` bytes of body (sizes are syncsafe). */
function id3(size: number): Buffer {
  const head = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, size]);
  return Buffer.concat([head, Buffer.alloc(size, 0x11)]);
}

const xing = (text = 'Xing', header = STEREO, at = 36) => frame(header, 0x00, { at, text });
const audio = (fill: number) => frame(STEREO, fill);

describe('joinMp3', () => {
  it('keeps the first tag and drops every length header, so no piece claims to be the whole', () => {
    const pieces = [
      Buffer.concat([id3(20), xing(), audio(0xa1)]),
      Buffer.concat([id3(20), xing(), audio(0xa2)]),
      Buffer.concat([id3(20), xing(), audio(0xa3)]),
    ];

    expect(joinMp3(pieces).equals(Buffer.concat([id3(20), audio(0xa1), audio(0xa2), audio(0xa3)]))).toBe(true);
  });

  it('recognises an Info header, a mono one, and a VBRI one', () => {
    const pieces = [
      Buffer.concat([xing('Info'), audio(0xa1)]),
      Buffer.concat([xing('Xing', MONO, 21), audio(0xa2)]),
      Buffer.concat([xing('VBRI', STEREO, 36), audio(0xa3)]),
    ];

    expect(joinMp3(pieces).equals(Buffer.concat([audio(0xa1), audio(0xa2), audio(0xa3)]))).toBe(true);
  });

  it('drops an ID3v1 tag from the end of every piece but the last', () => {
    const v1 = Buffer.concat([Buffer.from('TAG', 'latin1'), Buffer.alloc(125, 0x22)]);
    const pieces = [Buffer.concat([audio(0xa1), v1]), Buffer.concat([audio(0xa2), v1])];

    expect(joinMp3(pieces).equals(Buffer.concat([audio(0xa1), audio(0xa2), v1]))).toBe(true);
  });

  it('leaves plain audio frames alone', () => {
    const pieces = [Buffer.concat([audio(0xa1), audio(0xa4)]), audio(0xa2)];

    expect(joinMp3(pieces).equals(Buffer.concat(pieces))).toBe(true);
  });

  it('leaves a single piece exactly as the voice sent it', () => {
    // One piece's header describes that piece correctly.
    const only = Buffer.concat([id3(20), xing(), audio(0xa1)]);

    expect(joinMp3([only]).equals(only)).toBe(true);
  });

  it('joins bytes it does not recognise as MP3 unchanged, rather than cutting them', () => {
    const pieces = [Buffer.from('not audio at all'), Buffer.from('nor this')];

    expect(joinMp3(pieces).toString()).toBe('not audio at allnor this');
  });
});
