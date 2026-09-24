import type { DuckDbFile, DetectedSheetTable, FileKind, TextDecisionCache } from './duckdbConnection';

export const READ_METHODS = [
  'listTables', 'listSidebarTables', 'listSiblingTables', 'getCombinableTableNames',
  'buildCombinedQuery', 'getPollCadenceSeconds', 'getSeriesFrequency',
  'buildDetectedTableQuery', 'runDetectedTableQuery', 'runQuery', 'runChartQuery',
  'runSortedQuery', 'countMatchingRows', 'checkEditableSelect',
  'getColumnTopValues', 'getColumnDescriptiveStats',
  'compareToBackup', 'diffQueryAgainstBackup',
  'getQueryCatalog', 'getQueryColumns', 'locateXlsxEdit',
] as const;
export type ReadMethod = typeof READ_METHODS[number];

export interface ReadMetadata {
  fileKind: FileKind;
  readOnly: boolean;
  readOnlyByFormat: boolean;
  hasSibling: boolean;
  hasPendingSheets: boolean;
  worksheets: string[];
  detectedTables: DetectedSheetTable[];
  openWarnings: readonly string[];
  warnings: string[];
  numberLocale: DuckDbFile['numberLocale'];
  stamp: { size: number; mtimeMs: number };
  /** Text-column decisions for these exact bytes; the host keeps them in memory for a restarted reader. */
  textDecisions?: TextDecisionCache;
}
export interface ReadReply<T = unknown> { value: T; metadata: ReadMetadata; error?: string }
