import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Unzip, UnzipInflate } from 'fflate';
import { QueryPolicyError } from './queryPolicy';

export const WORKBOOK_LIMITS = Object.freeze({ compressedBytes: 256 * 1024 * 1024,
  inflatedBytes: 512 * 1024 * 1024, partBytes: 256 * 1024 * 1024, entries: 10_000, cellsPerSheet: 10_000_000 });

/** Count actual streamed inflation, rather than trusting ZIP length declarations.
 * Runs in the killable reader before native workbook parsing, and before a save
 * reopens an already-validated workbook in the trusted writer.
 */
export async function preflightWorkbook(path: string, tighterLimits: Partial<Record<keyof typeof WORKBOOK_LIMITS, number>> = {}): Promise<void> {
  const limits: Record<keyof typeof WORKBOOK_LIMITS, number> = { ...WORKBOOK_LIMITS };
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = tighterLimits[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw new QueryPolicyError('Invalid workbook budget.');
      limits[key] = value;
    }
  }
  if ((await stat(path)).size > limits.compressedBytes) throw new QueryPolicyError('Workbook exceeds the compressed-size limit.');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { highWaterMark: 16 * 1024 });
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
