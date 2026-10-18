// Validate portable archive-relative names independently of the host OS.
// Windows drive-absolute and drive-relative names must be rejected on POSIX
// too, otherwise a later Windows extractor can reinterpret an accepted entry.
export function isSafePortableArchivePath(name) {
  return typeof name === 'string' && name.length > 0 && !name.startsWith('/') && !name.startsWith('-') &&
    !/^[a-zA-Z]:/.test(name) && !name.includes('\\') && !/[\u0000-\u001f\u007f]/.test(name) &&
    name.split('/').every(part => part && part !== '.' && part !== '..');
}

// Validate ZIP central-directory entry types without extracting untrusted data.
// Callers must validate every path with isSafePortableArchivePath as well.
function uint64(bytes, offset, label) {
  if (offset < 0 || offset + 8 > bytes.length) throw new Error(`ZIP has truncated ${label}`);
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`ZIP ${label} exceeds the supported range`);
  return Number(value);
}

export function validateZipEntryTypes(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('ZIP archive must be bytes');
  bytes = Buffer.from(bytes);
  if (bytes.length < 22) throw new Error('archive is not a complete ZIP file');
  const minEocd = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let cursor = bytes.length - 22; cursor >= minEocd; cursor--) {
    if (bytes.readUInt32LE(cursor) !== 0x06054b50) continue;
    if (cursor + 22 + bytes.readUInt16LE(cursor + 20) === bytes.length) { eocd = cursor; break; }
  }
  if (eocd < 0) throw new Error('archive is not a complete ZIP file');

  let entryCount = bytes.readUInt16LE(eocd + 10);
  let centralSize = bytes.readUInt32LE(eocd + 12);
  let centralOffset = bytes.readUInt32LE(eocd + 16);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const hasZip64Sentinel = entryCount === 0xffff || diskEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff;
  if (disk !== 0 || centralDisk !== 0 || (entryCount !== diskEntries && !hasZip64Sentinel)) {
    throw new Error('ZIP uses unsupported multi-disk layout');
  }
  const locatorOffset = eocd - 20;
  const hasZip64Locator = locatorOffset >= 0 && bytes.readUInt32LE(locatorOffset) === 0x07064b50;
  if (hasZip64Sentinel || hasZip64Locator) {
    if (!hasZip64Locator) throw new Error('ZIP has missing ZIP64 end record');
    const zip64Offset = uint64(bytes, locatorOffset + 8, 'ZIP64 end-record offset');
    if (zip64Offset + 56 > bytes.length || bytes.readUInt32LE(zip64Offset) !== 0x06064b50) {
      throw new Error('ZIP has an invalid ZIP64 end record');
    }
    if (bytes.readUInt32LE(zip64Offset + 16) !== 0 || bytes.readUInt32LE(zip64Offset + 20) !== 0) {
      throw new Error('ZIP uses unsupported multi-disk ZIP64 layout');
    }
    const perDiskCount = uint64(bytes, zip64Offset + 24, 'ZIP64 per-disk entry count');
    entryCount = uint64(bytes, zip64Offset + 32, 'ZIP64 entry count');
    if (perDiskCount !== entryCount) throw new Error('ZIP has inconsistent ZIP64 entry counts');
    centralSize = uint64(bytes, zip64Offset + 40, 'ZIP64 central-directory size');
    centralOffset = uint64(bytes, zip64Offset + 48, 'ZIP64 central-directory offset');
  }
  const centralEnd = centralOffset + centralSize;
  if (!Number.isSafeInteger(centralEnd) || centralOffset < 0 || centralEnd > bytes.length || centralEnd > eocd) {
    throw new Error('ZIP has an out-of-bounds central directory');
  }

  let cursor = centralOffset;
  for (let entry = 0; entry < entryCount; entry++) {
    if (cursor + 46 > centralEnd || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('ZIP has a malformed central-directory entry');
    }
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > centralEnd) throw new Error('ZIP has a truncated central-directory entry');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
      .toString(bytes.readUInt16LE(cursor + 8) & 0x0800 ? 'utf8' : 'latin1');
    const madeByOs = bytes.readUInt16LE(cursor + 4) >>> 8;
    const attributes = bytes.readUInt32LE(cursor + 38);
    if (madeByOs === 3 || madeByOs === 19) {
      const type = (attributes >>> 16) & 0xf000;
      if (type !== 0 && type !== 0x8000 && type !== 0x4000) {
        throw new Error(`ZIP contains a symlink or special entry: ${JSON.stringify(name)}`);
      }
      if ((type === 0x4000 && !name.endsWith('/')) || (type === 0x8000 && name.endsWith('/'))) {
        throw new Error(`ZIP entry type conflicts with path: ${JSON.stringify(name)}`);
      }
    }
    cursor = end;
  }
  if (cursor !== centralEnd) throw new Error('ZIP central-directory length is inconsistent');
  return { entries: entryCount, central_directory_bytes: centralSize };
}
