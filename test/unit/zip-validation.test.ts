import { describe, expect, it } from 'vitest';
import { listZipEntries, validateZipArchive, ZipValidationError } from '../../scripts/lib/zip';

/**
 * Builds a store-only (uncompressed) ZIP in memory: local file headers + central directory +
 * EOCD. Just enough writer for the validator tests — the validator itself must never depend on
 * an external zip tool.
 */
function buildZip(entries: { name: string; content: string }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const contentBytes = Buffer.from(entry.content, 'utf8');
    const crcTable = makeCrcTable();
    const local = Buffer.alloc(30 + nameBytes.length + contentBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt32LE(crc32(contentBytes, crcTable), 14);
    local.writeUInt32LE(contentBytes.length, 18);
    local.writeUInt32LE(contentBytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    contentBytes.copy(local, 30 + nameBytes.length);
    locals.push(local);

    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(crc32(contentBytes, crcTable), 16);
    cd.writeUInt32LE(contentBytes.length, 20);
    cd.writeUInt32LE(contentBytes.length, 24);
    cd.writeUInt32LE(offset, 42);
    nameBytes.copy(cd, 46);
    central.push(cd);
    offset += local.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function makeCrcTable(): number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(data: Buffer, table: number[]): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

describe('ZIP archive validation (VAL-SETUP-019)', () => {
  it('accepts a readable non-empty archive listing its entries', () => {
    const zip = buildZip([
      { name: 'manifest.json', content: '{"name":"AmplifyX"}' },
      { name: 'background.js', content: '// code' },
    ]);
    const entries = listZipEntries(zip);
    expect(entries.map((entry) => entry.name)).toEqual(['manifest.json', 'background.js']);
    expect(entries.every((entry) => entry.size > 0)).toBe(true);
    expect(() => validateZipArchive(zip, 'x.zip')).not.toThrow();
  });

  it('requires the manifest entry when asked', () => {
    const zip = buildZip([{ name: 'other.txt', content: 'x' }]);
    expect(() => validateZipArchive(zip, 'x.zip', { mustContain: 'manifest.json' })).toThrow(/manifest\.json/);
  });

  it('rejects empty bytes, truncated archives, and bad signatures', () => {
    expect(() => validateZipArchive(Buffer.alloc(0), 'empty.zip')).toThrow(ZipValidationError);
    expect(() => validateZipArchive(Buffer.from('not a zip'), 'junk.zip')).toThrow(ZipValidationError);

    const zip = buildZip([{ name: 'manifest.json', content: '{}' }]);
    // A truncated central directory (cut into the EOCD region) is unreadable.
    expect(() => validateZipArchive(zip.subarray(0, zip.length - 6), 'cut.zip')).toThrow(ZipValidationError);
    // A corrupt local header signature invalidates the archive.
    const corrupt = Buffer.from(zip);
    corrupt.writeUInt32LE(0xdeadbeef, 0);
    expect(() => validateZipArchive(corrupt, 'corrupt.zip')).toThrow(ZipValidationError);
  });
});
