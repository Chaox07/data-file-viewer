import { Readable } from 'node:stream';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { indexZip, rawMembers } from './zipPatch';
import { Unzip, UnzipInflate } from 'fflate';
import { QueryPolicyError } from './queryPolicy';

export const WORKBOOK_LIMITS = Object.freeze({ compressedBytes: 256 * 1024 * 1024,
  inflatedBytes: 512 * 1024 * 1024, partBytes: 256 * 1024 * 1024, entries: 10_000, cellsPerSheet: 10_000_000 });

/** Count actual streamed inflation, rather than trusting ZIP length declarations.
 * Runs in the killable reader before native workbook parsing, and before a save
 * reopens an already-validated workbook in the trusted writer.
 */
export async function preflightWorkbook(path: string, tighterLimits: Partial<Record<keyof typeof WORKBOOK_LIMITS, number>> = {}): Promise<string> {
  const limits: Record<keyof typeof WORKBOOK_LIMITS, number> = { ...WORKBOOK_LIMITS };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = tighterLimits[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw new QueryPolicyError('Invalid workbook budget.');
      limits[key] = value;
    }
  }
  if ((await stat(path)).size > limits.compressedBytes) throw new QueryPolicyError('Workbook exceeds the compressed-size limit.');
  // Fast path: the same checks, with native zlib inflating each member as a
  // stream (bounded memory; a bomb is stopped mid-stream exactly as before).
  // fflate's JavaScript inflate was 430 of the 470 ms this took on a 21 MB
  // workbook. Archives outside zipPatch's scope -- ZIP64, encryption, other
  // methods, truncation, local headers disagreeing with the central directory
  // -- take the original streaming path below, unchanged.
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length > limits.compressedBytes) throw new QueryPolicyError('Workbook exceeds the compressed-size limit.');
  const index = indexZip(bytes);
  const members = index && rawMembers(index);
  if (members) {
    await preflightMembers(members, limits);
    return sha256;
  }
  await preflightStream(bytes, limits);
  return sha256;
}

/** Shared by both paths, so a name is judged identically however it was found. */
function unsafeName(raw: string, names: Set<string>): boolean {
  const name = raw.replace(/\\/g, '/');
  if (names.has(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\0') || name.split('/').includes('..')) return true;
  names.add(name);
  return false;
}

/** The entity-declaration test, per chunk with a carried tail, identical on both paths. */
function entityScanner(name: string): (data: Uint8Array) => boolean {
  if (!/\.(xml|rels)$/i.test(name)) return () => false;
  let tail = '';
  return (data) => {
    const text = tail + Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1');
    if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(text.replace(/\0/g, ''))) return true;
    tail = text.slice(-64);
    return false;
  };
}

async function preflightMembers(
  members: { name: string; method: number; declaredSize: number; data: Buffer }[],
  limits: Record<keyof typeof WORKBOOK_LIMITS, number>
): Promise<void> {
  const names = new Set<string>();
  let total = 0;
  for (const member of members) {
    if (unsafeName(member.name, names)) throw new QueryPolicyError('Workbook contains an unsafe or duplicate archive path.');
    if (names.size > limits.entries || member.declaredSize > limits.partBytes) {
      throw new QueryPolicyError('Workbook exceeds the archive-entry or part-size limit.');
    }
    const hasEntity = entityScanner(member.name);
    let part = 0;
    const consume = (data: Uint8Array): string | undefined => {
      total += data.length; part += data.length;
      if (total > limits.inflatedBytes || part > limits.partBytes) return 'Workbook exceeds its decompression budget.';
      if (hasEntity(data)) return 'Workbook XML entity declarations are unsupported.';
      return undefined;
    };
    if (member.method === 0) {
      const problem = consume(member.data);
      if (problem) throw new QueryPolicyError(problem);
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      const inflate = zlib.createInflateRaw();
      let done = false;
      const fail = (message: string) => { if (done) return; done = true; inflate.destroy(); reject(new QueryPolicyError(message)); };
      inflate.on('data', (chunk: Buffer) => { const problem = consume(chunk); if (problem) fail(problem); });
      inflate.once('error', () => fail('Workbook archive could not be decoded.'));
      inflate.once('end', () => { if (!done) { done = true; resolve(); } });
      inflate.end(member.data);
    });
  }
}

/** The original path: fflate walking local headers from a 16 KiB stream. */
function preflightStream(source: Buffer, limits: Record<keyof typeof WORKBOOK_LIMITS, number>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Validate the bytes we hashed, even if the source path is replaced while
    // this fallback runs. Preserve the old decoder's bounded chunk size.
    const stream = Readable.from((function* () {
      for (let offset = 0; offset < source.length; offset += 16 * 1024) yield source.subarray(offset, offset + 16 * 1024);
    })());
    const names = new Set<string>();
    let bytes = 0;
    let finished = false;
    const fail = (message: string) => {
      if (finished) return;
      finished = true; stream.destroy(); reject(new QueryPolicyError(message));
    };
    const unzip = new Unzip(file => {
      if (finished) return;
      const name = file.name.replace(/\\/g, '/');
      if (names.has(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\0') || name.split('/').includes('..')) {
        fail('Workbook contains an unsafe or duplicate archive path.'); return;
      }
      names.add(name);
      if (names.size > limits.entries || (file.originalSize ?? 0) > limits.partBytes) {
        fail('Workbook exceeds the archive-entry or part-size limit.'); return;
      }
      let partBytes = 0;
      let tail = '';
      file.ondata = (error, data) => {
        if (finished) { file.terminate(); return; }
        if (error) { fail('Workbook archive could not be decoded.'); return; }
        bytes += data.length; partBytes += data.length;
        if (bytes > limits.inflatedBytes || partBytes > limits.partBytes) {
          file.terminate(); fail('Workbook exceeds its decompression budget.'); return;
        }
        if (/\.(xml|rels)$/i.test(name)) {
          const text = tail + Buffer.from(data).toString('latin1');
          if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(text.replace(/\0/g, ''))) {
            file.terminate(); fail('Workbook XML entity declarations are unsupported.'); return;
          }
          tail = text.slice(-64);
        }
      };
      try { file.start(); } catch { fail('Workbook archive uses an unsupported encoding.'); }
    });
    unzip.register(UnzipInflate);
    stream.on('data', chunk => {
      if (finished) return;
      try { unzip.push(new Uint8Array(chunk as Buffer), false); } catch { fail('Workbook archive could not be decoded.'); }
    });
    stream.once('error', () => fail('Workbook could not be read.'));
    stream.once('end', () => {
      if (finished) return;
      try { unzip.push(new Uint8Array(), true); } catch { fail('Workbook archive is incomplete.'); return; }
      if (!finished) { finished = true; resolve(); }
    });
  });
}
