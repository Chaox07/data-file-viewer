import { readFileSync } from 'node:fs';

/**
 * Reads real, on-disk kdb+ objects written via q's `` `:path set obj`` (the
 * ETL pipeline this extension pairs with writes exactly this shape). This is
 * NOT the kdb+ IPC wire protocol — same type-tagged body encoding, but a
 * different (much shorter) header, ported from scratch against real files.
 * Only the flat, uncompressed, non-enumerated single-object case is
 * supported (matching what the pipeline actually produces) — splayed/
 * partitioned tables, on-disk compression, and enumerated symbol columns
 * (which need a companion `sym` file) are explicitly out of scope and raise
 * a clear error rather than guessing.
 *
 * Body decoding logic ported from `michaelwittig/node-q`'s `lib/c.js`
 * (MIT licensed) `deserialize()`, adapted from IPC-message parsing to
 * on-disk single-object parsing.
 */

export interface KdbColumn {
  name: string;
  /** kdb+ vector type code, e.g. 9 = float, 14 = date, 11 = symbol. */
  qType: number;
  /** One decoded value per row; null represents kdb+'s null sentinel for that type. */
  values: unknown[];
}

export interface KdbTable {
  columns: KdbColumn[];
  rowCount: number;
}

const KDB_EPOCH_DAYS = 10957; // days from 1970-01-01 (Unix epoch) to 2000-01-01 (kdb+ epoch)
const SHORT_NULL = -32768;
const INT_NULL = -2147483648;
const LONG_NULL = -9223372036854775808n;

class KdbReader {
  private pos = 0;

  constructor(private readonly buf: Buffer) {}

  seek(offset: number): void {
    this.pos = offset;
  }

  skip(n: number): void {
    this.pos += n;
  }

  private i8(): number {
    const v = this.buf.readInt8(this.pos);
    this.pos += 1;
    return v;
  }

  private u8(): number {
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }

  private i16(): number {
    const v = this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  private i32(): number {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  private i64(): bigint {
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  private f32(): number {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  private f64(): number {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  private bytes(n: number): Buffer {
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  private str(n: number): string {
    const v = this.buf.toString('utf8', this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  /** Null-terminated symbol string (kdb+'s on-disk symbol encoding). */
  private cstr(): string | null {
    const end = this.buf.indexOf(0, this.pos);
    if (end === -1) throw new Error('Malformed kdb+ file: unterminated symbol string.');
    const s = this.buf.toString('utf8', this.pos, end);
    this.pos = end + 1;
    return s === '' ? null : s;
  }

  private readBoolean(): boolean {
    return this.i8() === 1;
  }

  private readGuid(): string | null {
    const b = this.bytes(16);
    let s = '';
    for (let i = 0; i < 16; i++) {
      if (i === 4 || i === 6 || i === 8 || i === 10) s += '-';
      s += b[i].toString(16).padStart(2, '0');
    }
    return s === '00000000-0000-0000-0000-000000000000' ? null : s;
  }

  private readByte(): number {
    return this.u8();
  }

  private readShort(): number | null {
    const v = this.i16();
    return v === SHORT_NULL ? null : v;
  }

  private readInt(): number | null {
    const v = this.i32();
    return v === INT_NULL ? null : v;
  }

  private readLong(): bigint | null {
    const v = this.i64();
    return v === LONG_NULL ? null : v;
  }

  private readReal(): number | null {
    const v = this.f32();
    return Number.isNaN(v) ? null : v;
  }

  private readFloat(): number | null {
    const v = this.f64();
    return Number.isNaN(v) ? null : v;
  }

  private readCharAtom(): string | null {
    const v = this.u8();
    return v === 32 ? null : String.fromCharCode(v);
  }

  private readSymbol(): string | null {
    return this.cstr();
  }

  /** nanoseconds since kdb+ epoch -> microseconds since Unix epoch. */
  private readTimestampMicros(): bigint | null {
    const v = this.i64();
    if (v === LONG_NULL) return null;
    return v / 1000n + BigInt(KDB_EPOCH_DAYS) * 86_400_000_000n;
  }

  /** months since kdb+ epoch (2000-01) -> Unix-epoch day count of that month's 1st. */
  private readMonthAsDateDays(): number | null {
    const v = this.i32();
    if (v === INT_NULL) return null;
    const y = 2000 + Math.floor(v / 12);
    const m = ((v % 12) + 12) % 12;
    return Math.floor(Date.UTC(y, m, 1) / 86_400_000);
  }

  /** days since kdb+ epoch -> Unix-epoch day count. */
  private readDateDays(): number | null {
    const v = this.i32();
    if (v === INT_NULL) return null;
    return v + KDB_EPOCH_DAYS;
  }

  /** fractional days since kdb+ epoch -> microseconds since Unix epoch. */
  private readDatetimeMicros(): bigint | null {
    const v = this.f64();
    if (Number.isNaN(v)) return null;
    return BigInt(Math.round((v + KDB_EPOCH_DAYS) * 86_400_000_000));
  }

  /** nanosecond duration -- kept raw, not an instant in time. */
  private readTimespanNanos(): bigint | null {
    const v = this.i64();
    return v === LONG_NULL ? null : v;
  }

  private readMinuteMicros(): bigint | null {
    const v = this.i32();
    if (v === INT_NULL) return null;
    return BigInt(v) * 60_000_000n;
  }

  private readSecondMicros(): bigint | null {
    const v = this.i32();
    if (v === INT_NULL) return null;
    return BigInt(v) * 1_000_000n;
  }

  /** milliseconds since midnight -> microseconds since midnight. */
  private readTimeMicros(): bigint | null {
    const v = this.i32();
    if (v === INT_NULL) return null;
    return BigInt(v) * 1000n;
  }

  private readAtomByType(t: number): unknown {
    switch (t) {
      case 1:
        return this.readBoolean();
      case 2:
        return this.readGuid();
      case 4:
        return this.readByte();
      case 5:
        return this.readShort();
      case 6:
        return this.readInt();
      case 7:
        return this.readLong();
      case 8:
        return this.readReal();
      case 9:
        return this.readFloat();
      case 10:
        return this.readCharAtom();
      case 11:
        return this.readSymbol();
      case 12:
        return this.readTimestampMicros();
      case 13:
        return this.readMonthAsDateDays();
      case 14:
        return this.readDateDays();
      case 15:
        return this.readDatetimeMicros();
      case 16:
        return this.readTimespanNanos();
      case 17:
        return this.readMinuteMicros();
      case 18:
        return this.readSecondMicros();
      case 19:
        return this.readTimeMicros();
      default:
        throw new Error(`Unsupported kdb+ atom type -${t}.`);
    }
  }

  /** Reads a list body (type byte + attribute byte already consumed by the caller). */
  private readListBody(t: number, n: number): unknown[] {
    if (t === 10) {
      // A char *vector* renders as one string of length n -- split back into
      // one character per row so every column keeps a uniform "value per row"
      // shape, matching every other type.
      return Array.from(this.str(n));
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = t === 0 ? this.readAny() : this.readAtomByType(t);
    }
    return out;
  }

  /** Full recursive object reader, for general/mixed-list elements and nested values. */
  private readAny(): unknown {
    const t = this.i8();
    if (t === -128) {
      throw new Error(`kdb+ error object encountered: ${this.readSymbol() ?? ''}`);
    }
    if (t < 0 && t > -20) {
      return this.readAtomByType(-t);
    }
    if (t > 99) {
      throw new Error(`Unsupported kdb+ object type ${t} (function/lambda objects are not supported).`);
    }
    if (t === 99) {
      const keys = this.readAny();
      const values = this.readAny();
      return { keys, values };
    }
    this.skip(1); // attribute byte, uniform for every list-shaped type including 98
    if (t === 98) {
      this.i8(); // discard the nested dict's own type byte (always 99 for a flip)
      const keys = this.readAny();
      const values = this.readAny();
      return { keys, values }; // nested table -- represented structurally, not flattened
    }
    const n = this.i32();
    return this.readListBody(t, n);
  }

  /** Reads a plain (non-general, non-dict, non-table) typed vector: type byte + attribute byte + payload. */
  private readTypedVector(): { qType: number; values: unknown[] } {
    const t = this.i8();
    this.skip(1); // attribute byte
    const n = this.i32();
    return { qType: t, values: this.readListBody(t, n) };
  }

  parseTable(): KdbTable {
    const t = this.i8();
    if (t !== 98) {
      throw new Error(`Expected a kdb+ table (type 98) at the top level of this file, got type ${t}.`);
    }
    this.skip(1); // table's own attribute byte
    const dictType = this.i8();
    if (dictType !== 99) {
      throw new Error('Malformed kdb+ table: expected a dict (type 99) inside the flip.');
    }

    const keys = this.readTypedVector();
    if (keys.qType !== 11) {
      throw new Error(
        `Malformed kdb+ table: expected column names as a symbol vector (type 11), got type ${keys.qType}. ` +
          'Enumerated (indexed) symbol columns are not supported.'
      );
    }
    const columnNames = keys.values as (string | null)[];

    const valuesType = this.i8();
    this.skip(1); // attribute byte of the outer "values" general list
    if (valuesType !== 0) {
      throw new Error(`Malformed kdb+ table: expected column data as a general list (type 0), got type ${valuesType}.`);
    }
    const nCols = this.i32();
    if (nCols !== columnNames.length) {
      throw new Error('Malformed kdb+ table: column name count does not match column data count.');
    }

    const columns: KdbColumn[] = [];
    for (let i = 0; i < nCols; i++) {
      const col = this.readTypedVector();
      columns.push({ name: columnNames[i] ?? `column_${i}`, qType: col.qType, values: col.values });
    }

    const rowCount = columns.length > 0 ? columns[0].values.length : 0;
    return { columns, rowCount };
  }
}

const HEADER_LEN = 2;

function parseKdbBuffer(buf: Buffer): KdbTable {
  if (buf.length >= 8 && buf.subarray(0, 8).toString('ascii') === 'kxzipped') {
    throw new Error('This kdb+ file uses on-disk compression ("kxzipped"), which is not supported.');
  }
  if (buf.length < HEADER_LEN + 1 || buf[0] !== 0xff || buf[1] !== 0x01) {
    throw new Error(
      'Unrecognized kdb+ file header. Only plain, uncompressed single-object files written via `set` are ' +
        'supported (splayed/partitioned tables and other on-disk header variants are not).'
    );
  }
  const reader = new KdbReader(buf);
  reader.seek(HEADER_LEN);
  return reader.parseTable();
}

export function parseKdbFile(path: string): KdbTable {
  return parseKdbBuffer(readFileSync(path));
}
