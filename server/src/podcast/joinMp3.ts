const BITRATES_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

const SAMPLE_RATES: Record<number, number[]> = {
  3: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  0: [11_025, 12_000, 8_000],
};

function id3v2Length(piece: Buffer): number {
  if (piece.length < 10 || piece.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size =
    ((piece[6]! & 0x7f) << 21) | ((piece[7]! & 0x7f) << 14) | ((piece[8]! & 0x7f) << 7) | (piece[9]! & 0x7f);
  const footer = piece[5]! & 0x10 ? 10 : 0;
  return Math.min(piece.length, 10 + size + footer);
}

function lengthHeaderFrame(piece: Buffer, at: number): number {
  if (at + 4 > piece.length || piece[at] !== 0xff || (piece[at + 1]! & 0xe0) !== 0xe0) return 0;

  const version = (piece[at + 1]! >> 3) & 3;
  const layer = (piece[at + 1]! >> 1) & 3;
  if (version === 1 || layer !== 1) return 0;

  const mpeg1 = version === 3;
  const kbps = (mpeg1 ? BITRATES_MPEG1 : BITRATES_MPEG2)[piece[at + 2]! >> 4];
  const rate = SAMPLE_RATES[version]?.[(piece[at + 2]! >> 2) & 3];
  if (!kbps || !rate) return 0;

  const padding = (piece[at + 2]! >> 1) & 1;
  const length = Math.floor(((mpeg1 ? 144_000 : 72_000) * kbps) / rate) + padding;

  const mono = piece[at + 3]! >> 6 === 3;
  const sideInfo = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const word = (offset: number) => piece.toString('latin1', offset, offset + 4);
  const xing = word(at + 4 + sideInfo);
  const isLengthHeader = xing === 'Xing' || xing === 'Info' || word(at + 36) === 'VBRI';

  return isLengthHeader && at + length <= piece.length ? length : 0;
}

function id3v1Length(piece: Buffer): number {
  return piece.length >= 128 && piece.toString('latin1', piece.length - 128, piece.length - 125) === 'TAG'
    ? 128
    : 0;
}

export function joinMp3(pieces: Buffer[]): Buffer {
  if (pieces.length < 2) return pieces[0] ?? Buffer.alloc(0);

  const last = pieces.length - 1;
  return Buffer.concat(
    pieces.flatMap((piece, index) => {
      const tag = id3v2Length(piece);
      const audioStart = tag + lengthHeaderFrame(piece, tag);
      const audioEnd = piece.length - (index === last ? 0 : id3v1Length(piece));
      const audio = piece.subarray(audioStart, Math.max(audioStart, audioEnd));
      return index === 0 ? [piece.subarray(0, tag), audio] : [audio];
    }),
  );
}
