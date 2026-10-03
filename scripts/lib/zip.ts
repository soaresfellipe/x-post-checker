/**
 * Dependency-free ZIP archive validation for the packaging pipeline (VAL-SETUP-019): each
 * release artifact must be non-empty and readable as a ZIP before it is trusted. Reads only the
 * structure (end-of-central-directory record, central directory entries, local header
 * signatures) — it never inflates entry contents, so it works without external zip tooling.
 *
 * Byte offsets follow the APPNOTE.TXT format: EOCD ends with `PK\x05\x06`, central directory
 * entries start with `PK\x01\x02`, local file headers with `PK\x03\x04`.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** EOCD record length with a zero-entry comment. */
const EOCD_MIN_SIZE = 22;

export class ZipValidationError extends Error {}

export interface ZipEntry {
  name: string;
  /** Uncompressed byte size; 0 for directories. */
  size: number;
}

/** Finds the last EOCD record (scanning back past any ZIP comment) and returns its offset. */
function findEocd(buffer: Buffer): number {
  if (buffer.length < EOCD_MIN_SIZE) {
    throw new ZipValidationError(`archive is too small to be a ZIP (${buffer.length} bytes)`);
  }
  const maxScanStart = Math.max(0, buffer.length - EOCD_MIN_SIZE - 65_536);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= maxScanStart; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipValidationError('end-of-central-directory record not found');
}

/** Parses the central directory and returns one record per file entry. */
export function listZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEocd(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index++) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== CENTRAL_SIGNATURE) {
      throw new ZipValidationError(`central directory entry ${index} is corrupt or truncated`);
    }
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const size = buffer.readUInt32LE(pointer + 24);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    entries.push({ name, size });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Validates that `buffer` is a readable, non-empty ZIP archive. When `mustContain` is set, an
 * entry with exactly that name must exist (the packaging pipeline checks for `manifest.json`).
 */
export function validateZipArchive(buffer: Buffer, label: string, options: { mustContain?: string } = {}): ZipEntry[] {
  if (buffer.length === 0) throw new ZipValidationError(`${label}: archive is empty`);
  const eocd = findEocd(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  if (entryCount === 0) throw new ZipValidationError(`${label}: archive has no entries`);

  const entries = listZipEntries(buffer);
  for (const entry of entries) {
    if (entry.size === 0 && !entry.name.endsWith('/')) {
      throw new ZipValidationError(`${label}: entry ${entry.name} is unexpectedly empty`);
    }
  }
  const localCheckLimit = Math.min(entries.length, 8);
  for (let index = 0; index < localCheckLimit; index++) {
    // Spot-check the first entries' local headers: a truncated or spliced archive fails here.
    const found = findLocalHeader(buffer, entries[index]!.name);
    if (!found) throw new ZipValidationError(`${label}: local header for ${entries[index]!.name} not found`);
  }
  if (options.mustContain !== undefined && !entries.some((entry) => entry.name === options.mustContain)) {
    throw new ZipValidationError(`${label}: required entry ${options.mustContain} missing`);
  }
  return entries;
}

/** Walks the local headers chain from an entry's central-directory offset and verifies it. */
function findLocalHeader(buffer: Buffer, name: string): boolean {
  // Locate via the central directory record (name match) and read its local-header offset.
  const eocd = findEocd(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index++) {
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const entryName = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    if (entryName === name) {
      const localOffset = buffer.readUInt32LE(pointer + 42);
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) return false;
      return true;
    }
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return false;
}
