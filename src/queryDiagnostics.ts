import { QueryPolicyError } from './queryPolicy';

/** Notices can contain sampled cells and file-controlled labels. Classify them
 * before they cross into notifications; leave exact values in requested grids. */
export function queryNotices(notices: readonly string[]): string[] {
  return [...new Set(notices.map(notice => {
    if (/edit was saved/i.test(notice)) return 'The edit was saved, but its displayed data could not be refreshed. Reopen the file before editing again.';
    if (/floating-point|past 2\^53|exact type|precision/i.test(notice)) return 'Some columns remain text to preserve numeric precision. The source file is unchanged.';
    if (/decimal convention|read as Turkish|numberLocale/i.test(notice)) return 'Some columns have an ambiguous decimal convention and remain text. Set dataFileViewer.numberLocale only when the source convention is known.';
    if (/text column.*read as numbers/i.test(notice)) return 'Numeric text was interpreted as numbers; configured missing-value markers may appear empty. Set dataFileViewer.nullText to [] to read the source literally.';
    if (/error markers|could not compute/i.test(notice)) return 'Configured spreadsheet error markers appear empty in detected tables. The raw worksheet retains their original text.';
    if (/left as text|kept as text|remain.*text/i.test(notice)) return 'Some columns remain text because their values cannot all be interpreted consistently. The source file is unchanged.';
    if (/Stata|dataset, variable and value labels/i.test(notice)) return 'Stata files are read-only to preserve their original data types and labels.';
    return 'The dataset opened with a reading notice. Check the column types and raw worksheet before interpreting the result; the source file is unchanged.';
  }))];
}

export interface QueryDiagnostic {
  category: 'blocked' | 'type' | 'column' | 'conversion' | 'syntax' | 'resource' | 'cancelled' | 'unknown';
  message: string;
  line?: number;
}

/** Classify locally; never forward a raw engine error, SQL excerpt, URL or value.
 * Unknown diagnostics stay generic instead of relying on secret-pattern redaction.
 */
export function queryDiagnostic(error: unknown, rawWorksheet = false): QueryDiagnostic {
  if (error instanceof QueryPolicyError) return { category: 'blocked', message: error.message };
  const raw = error instanceof Error ? error.message : '';
  if (/already open elsewhere|being used by another process|resource busy|Could not set lock/i.test(raw)) return {
    category: 'blocked', message: 'The file is locked by another connection. Close that connection and reopen this view.',
  };
  const lineMatch = /\bLINE (\d+):/.exec(raw);
  const line = lineMatch && Number(lineMatch[1]) <= 100_000 ? Number(lineMatch[1]) : undefined;
  if (/interrupt|cancelled/i.test(raw)) return { category: 'cancelled', message: 'Query cancelled.' };
  if (/Cannot (compare|mix) values of type/i.test(raw)) {
    const text = /VARCHAR/.test(raw);
    const numeric = /INTEGER|BIGINT|INTEGER_LITERAL/.test(raw);
    return { category: 'type', line, message: text && numeric
      ? 'SQL type mismatch: a text column is being compared with a number. If it contains ISO dates, use an explicit CAST(column AS DATE) and a typed boundary such as DATE \'1990-01-01\'. Invalid dates will remain errors.'
      : 'SQL type mismatch. Compare compatible types. For dates, use a typed boundary such as DATE \'1990-01-01\'; a numeric year is not a date literal.' };
  }
  if (/Binder Error.*(Referenced column|not found)/is.test(raw)) return {
    category: 'column', line, message: rawWorksheet
      ? 'This raw worksheet exposes Excel letter columns (A, B, C…). Choose a detected table in Query table to use its headers and SQL types.'
      : 'A referenced column or relation could not be resolved. Check the selected table’s column names and SQL types.',
  };
  if (/Conversion Error|Could not convert|Could not parse/i.test(raw)) return {
    category: 'conversion', line, message: 'A value could not be converted to the requested SQL type. Check the column types and conversion; no invalid rows were silently discarded.',
  };
  if (/Parser Error|Syntax Error/i.test(raw)) return { category: 'syntax', line, message: 'SQL syntax error. Check the query near the indicated line.' };
  if (/Cell data too large|is the file corrupted/i.test(raw)) return {
    category: 'resource', message: 'This worksheet cannot be read: a cell is larger than Excel’s 32,767-character limit, or the sheet is damaged. Other sheets remain available.',
  };
  if (/Out of Memory|memory limit|maximum.*size|Resource/i.test(raw)) return { category: 'resource', message: 'Query exceeded a resource limit. Select fewer rows or columns, or simplify the query.' };
  if (/Permission Error|external access|disabled by configuration/i.test(raw)) return { category: 'blocked', message: 'The query requires a resource outside this document’s permitted access.' };
  return { category: 'unknown', message: 'The query could not be completed. Check its table, column names and SQL types.' };
}
