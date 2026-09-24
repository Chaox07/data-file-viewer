import * as zlib from 'node:zlib';

/**
 * Read selected members of a ZIP, and rewrite it with some members replaced,
 * carrying every other member's compressed bytes through untouched.
 *
 * Why this exists: patching one cell of a workbook used to inflate every
 * member with fflate and re-deflate them all -- on a 21 MB workbook, 114 MB of
 * XML re-encoded to change one number (2.7 s measured). Only the edited part
 * has to be re-encoded; the rest can be copied byte for byte, and native zlib
 * does the part that remains faster than the JavaScript deflate.
 *
 * Deliberately narrow: single-disk archives without ZIP64, encryption or
 * compression other than stored/deflate. Anything else returns `undefined`,
 * and the caller keeps its original whole-archive path for that file. The
 * member CONTENTS produced are identical either way; only the encoding of the
 * untouched members differs (they keep what the file already had).
 */

interface Entry {
  name: string;
  /** Offset of this entry's central-directory record. */
  central: number;
  centralLength: number;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export interface ZipIndex {
  bytes: Buffer;
  entries: Entry[];
  /** End-of-central-directory comment, preserved on rewrite. */
  comment: Buffer;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Parse the central directory, or `undefined` if the archive is outside this module's scope. */
export function indexZip(bytes: Buffer): ZipIndex | undefined {
  const min = Math.max(0, bytes.length - 0xffff - 22);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return undefined;
  const disk = bytes.readUInt16LE(eocd + 4);
  const cdDisk = bytes.readUInt16LE(eocd + 6);
  const countHere = bytes.readUInt16LE(eocd + 8);
  const count = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (disk !== 0 || cdDisk !== 0 || countHere !== count || count === 0xffff ||
      cdOffset === 0xffffffff || cdSize === 0xffffffff || cdOffset + cdSize > eocd ||
      eocd + 22 + commentLength > bytes.length) return undefined;
  const entries: Entry[] = [];
  const names = new Set<string>();
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || bytes.readUInt32LE(at) !== CENTRAL) return undefined;
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const entryCommentLength = bytes.readUInt16LE(at + 32);
    const localOffset = bytes.readUInt32LE(at + 42);
    const centralLength = 46 + nameLength + extraLength + entryCommentLength;
    if ((flags & 0x2041) !== 0 || bytes.readUInt16LE(at + 34) !== 0 || (method !== 0 && method !== 8) ||
        compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff ||
        at + centralLength > eocd) return undefined;
    const name = bytes.toString((flags & 0x0800) ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength);
    if (names.has(name)) return undefined;
    names.add(name);
    entries.push({ name, central: at, centralLength, flags, method, crc: bytes.readUInt32LE(at + 16), compressedSize, size, localOffset });
    at += centralLength;
  }
  if (at !== cdOffset + cdSize || at !== eocd) return undefined;
  let end = 0;
  for (const entry of [...entries].sort((a, b) => a.localOffset - b.localOffset)) {
    const local = localData(bytes, entry);
    if (!local || local.header !== end) return undefined;
    const localCompressed = bytes.readUInt32LE(local.header + 18);
    const localSize = bytes.readUInt32LE(local.header + 22);
    const localNameLength = bytes.readUInt16LE(local.header + 26);
    const centralNameLength = bytes.readUInt16LE(entry.central + 28);
    if (localCompressed === 0xffffffff || localSize === 0xffffffff ||
        bytes.readUInt16LE(local.header + 6) !== entry.flags ||
        bytes.readUInt16LE(local.header + 8) !== entry.method || localNameLength !== centralNameLength ||
        !bytes.subarray(local.header + 30, local.header + 30 + localNameLength)
          .equals(bytes.subarray(entry.central + 46, entry.central + 46 + centralNameLength))) return undefined;
    // ZIP64 extras can be present even when the central sizes fit in 32 bits.
    // They contain size/offset fields this rewriter deliberately does not update.
    for (const extra of [local.extra, bytes.subarray(entry.central + 46 + centralNameLength,
      entry.central + 46 + centralNameLength + bytes.readUInt16LE(entry.central + 30))]) {
      for (let pos = 0; pos < extra.length;) {
        if (pos + 4 > extra.length) return undefined;
        const id = extra.readUInt16LE(pos), length = extra.readUInt16LE(pos + 2);
        if (id === 1 || pos + 4 + length > extra.length) return undefined;
        pos += 4 + length;
      }
    }
    end = local.data + entry.compressedSize;
    if ((entry.flags & 8) !== 0) {
      const signed = end + 4 <= cdOffset && bytes.readUInt32LE(end) === 0x08074b50;
      const descriptor = end + (signed ? 4 : 0);
      if (descriptor + 12 > cdOffset || bytes.readUInt32LE(descriptor) !== entry.crc ||
          bytes.readUInt32LE(descriptor + 4) !== entry.compressedSize || bytes.readUInt32LE(descriptor + 8) !== entry.size) return undefined;
      end = descriptor + 12;
    } else if (localCompressed !== entry.compressedSize || localSize !== entry.size ||
      bytes.readUInt32LE(local.header + 14) !== entry.crc) return undefined;
  }
  if (end !== cdOffset) return undefined;
  return { bytes, entries, comment: bytes.subarray(eocd + 22, eocd + 22 + commentLength) };
}

/** Where an entry's local header starts and its data begins, validated against the central record. */
function localData(bytes: Buffer, entry: Entry): { header: number; data: number; extra: Buffer } | undefined {
  const header = entry.localOffset;
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== LOCAL) return undefined;
  const nameLength = bytes.readUInt16LE(header + 26);
  const extraLength = bytes.readUInt16LE(header + 28);
  const data = header + 30 + nameLength + extraLength;
  if (data + entry.compressedSize > bytes.length) return undefined;
  return { header, data, extra: bytes.subarray(header + 30 + nameLength, data) };
}

/**
 * Each member's compressed bytes and method, in central-directory order, or
 * `undefined` if any local header's name differs from its central record --
 * the classic way to show one reader a different archive than another.
 */
export function rawMembers(index: ZipIndex): { name: string; method: number; declaredSize: number; data: Buffer }[] | undefined {
  // Preflight must judge the same entries and compression that the original
  // streaming reader sees, including entries hidden from the central directory.
  // Descriptor/unusual layouts keep the streaming path instead of weakening it.
  if (!sequentialLayout(index)) return undefined;
  const out = [];
  for (const entry of index.entries) {
    const local = localData(index.bytes, entry)!;
    const nameLength = index.bytes.readUInt16LE(local.header + 26);
    const localName = index.bytes.subarray(local.header + 30, local.header + 30 + nameLength);
    const centralName = index.bytes.subarray(entry.central + 46, entry.central + 46 + index.bytes.readUInt16LE(entry.central + 28));
    if (!localName.equals(centralName)) return undefined;
    out.push({ name: entry.name, method: entry.method, declaredSize: entry.size, data: index.bytes.subarray(local.data, local.data + entry.compressedSize) });
  }
  return out;
}

/**
 * True when a streaming reader walking local headers from byte 0 sees exactly
 * the archive the central directory describes: members back to back in
 * central order, each local header agreeing on name, flags, method and sizes,
 * no data descriptors, and the central directory right after the last member.
 * Only then can a central-directory reader stand in for a streaming one and be
 * sure to give the same answer, including about damage.
 */
export function sequentialLayout(index: ZipIndex): boolean {
  const { bytes, entries } = index;
  let expected = 0;
  for (const entry of entries) {
    const local = localData(bytes, entry)!;
    if (local.header !== expected || (entry.flags & 0x0008) !== 0) return false;
    const nameLength = bytes.readUInt16LE(local.header + 26);
    const centralNameLength = bytes.readUInt16LE(entry.central + 28);
    if (bytes.readUInt16LE(local.header + 6) !== entry.flags ||
        bytes.readUInt16LE(local.header + 8) !== entry.method ||
        bytes.readUInt32LE(local.header + 14) !== entry.crc ||
        bytes.readUInt32LE(local.header + 18) !== entry.compressedSize ||
        bytes.readUInt32LE(local.header + 22) !== entry.size ||
        nameLength !== centralNameLength ||
        !bytes.subarray(local.header + 30, local.header + 30 + nameLength)
          .equals(bytes.subarray(entry.central + 46, entry.central + 46 + centralNameLength))) return false;
    expected = local.data + entry.compressedSize;
  }
  return entries.length > 0 && expected === entries[0].central;
}

/**
 * The first `want` bytes of a member's content, inflating only a prefix of
 * its compressed data. `undefined` when that cannot be done cheaply and
 * exactly (corrupt data, or a prefix that expands past `maxOutput`).
 */
export function memberHead(index: ZipIndex, name: string, want: number, maxOutput = 8 * 1024 * 1024): Buffer | undefined {
  const entry = index.entries.find(e => e.name === name);
  if (!entry) return undefined;
  const { data } = localData(index.bytes, entry)!;
  const raw = index.bytes.subarray(data, data + entry.compressedSize);
  if (entry.method === 0) return raw.subarray(0, want);
  for (let take = Math.min(raw.length, 16 * 1024); ; take = Math.min(raw.length, take * 4)) {
    let out: Buffer;
    try {
      out = zlib.inflateRawSync(raw.subarray(0, take), { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: maxOutput });
    } catch { return undefined; }
    if (out.length >= want || take === raw.length) return out.subarray(0, want);
  }
}

/** Inflate one member. Throws if it does not decode to its declared size. */
export function readMember(index: ZipIndex, name: string): Uint8Array | undefined {
  const entry = index.entries.find(e => e.name === name);
  if (!entry) return undefined;
  const { data } = localData(index.bytes, entry)!;
  const raw = index.bytes.subarray(data, data + entry.compressedSize);
  const out = entry.method === 0 ? raw : zlib.inflateRawSync(raw);
  if (out.length !== entry.size) throw new Error(`Workbook member ${name} does not match its declared size.`);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

let crcTable: Int32Array | undefined;
function crc32(data: Uint8Array): number {
  const native = (zlib as unknown as { crc32?: (d: Uint8Array) => number }).crc32;
  if (typeof native === 'function') return native(data) >>> 0;
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * A new archive: same members in central-directory order, `replacements`
 * deflated afresh, everything else copied compressed. Local headers are
 * rebuilt from the central records (sizes in the header, no data descriptor),
 * keeping each member's own name bytes, extra fields, timestamps and comment.
 */
export function rewriteZip(index: ZipIndex, replacements: ReadonlyMap<string, Uint8Array>): Buffer {
  const { bytes } = index;
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of index.entries) {
    const local = localData(bytes, entry)!;
    const replacement = replacements.get(entry.name);
    let data: Buffer, method = entry.method, crc = entry.crc, size = entry.size;
    if (replacement) {
      data = zlib.deflateRawSync(replacement, { level: 6 });
      method = 8; crc = crc32(replacement); size = replacement.length;
    } else {
      data = bytes.subarray(local.data, local.data + entry.compressedSize);
    }
    const nameBytes = bytes.subarray(entry.central + 46, entry.central + 46 + bytes.readUInt16LE(entry.central + 28));
    const flags = entry.flags & ~0x0008;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL, 0);
    header.writeUInt16LE(bytes.readUInt16LE(local.header + 4), 4); // version needed, as the file had it
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(bytes.readUInt16LE(entry.central + 12), 10); // time
    header.writeUInt16LE(bytes.readUInt16LE(entry.central + 14), 12); // date
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(local.extra.length, 28);
    const central = Buffer.from(bytes.subarray(entry.central, entry.central + entry.centralLength));
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt32LE(offset, 42);
    if (offset > 0xfffffffe || data.length > 0xfffffffe) throw new Error('Workbook is too large to rewrite without ZIP64.');
    parts.push(header, nameBytes, local.extra, data);
    offset += header.length + nameBytes.length + local.extra.length + data.length;
    centrals.push(central);
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(index.entries.length, 8);
  eocd.writeUInt16LE(index.entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(index.comment.length, 20);
  return Buffer.concat([...parts, ...centrals, eocd, index.comment]);
}
