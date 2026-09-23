import { realpath, stat } from 'node:fs/promises';
import { DuckDbFile, type DuckDbFileOpenOptions, type FileKind } from './duckdbConnection';
import { queryDiagnostic } from './queryDiagnostics';
import { QueryPolicyError, validateResultSize } from './queryPolicy';

/** No write methods are exposed by the read worker. */
export const READ_METHODS = [
  'listTables', 'listSidebarTables', 'listSiblingTables', 'getCombinableTableNames',
  'buildCombinedQuery', 'getPollCadenceSeconds', 'getSeriesFrequency',
  'buildDetectedTableQuery', 'runDetectedTableQuery', 'runQuery', 'runChartQuery',
  'runSortedQuery', 'countMatchingRows', 'checkEditableSelect',
  'getColumnTopValues', 'getColumnDescriptiveStats',
] as const;

let file: DuckDbFile | undefined;
let approvedPath: string | undefined;
let stamp: { size: number; mtimeMs: number } | undefined;
let queue = Promise.resolve();

async function metadata() {
  if (!file) return undefined;
  const tables = await file.listSidebarTables();
  return {
    fileKind: file.fileKind,
    readOnly: file.isReadOnly(),
    readOnlyByFormat: file.isReadOnlyByFormat(),
    hasSibling: file.hasSibling(),
    hasPendingSheets: file.hasPendingSheets(),
    worksheets: tables.filter(t => file!.isWorksheet(t)),
    detectedTables: tables.flatMap(t => file!.getDetectedSheetTables(t)),
    openWarnings: file.openWarnings,
    warnings: file.takeLateWarnings(),
  };
}

process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const request = message as { id?: number; method?: string; args?: unknown[] };
  if (request.method === 'cancel') { file?.interruptCurrentQuery(); return; }
  if (!Number.isSafeInteger(request.id) || !Array.isArray(request.args) || typeof request.method !== 'string') return;
  const { id, method, args } = request;
  queue = queue.then(async () => {
    try {
      let value: unknown;
      if (method === 'open') {
        if (file) throw new QueryPolicyError('This query worker already owns a document.');
        approvedPath = await realpath(String(args[0]));
        const info = await stat(approvedPath);
        stamp = { size: info.size, mtimeMs: info.mtimeMs };
        file = await DuckDbFile.open(approvedPath, args[1] as FileKind | undefined, {
          ...(args[2] as DuckDbFileOpenOptions), restrictedReads: true, forceReadOnly: true,
        });
      } else {
        if (!file || !approvedPath || !stamp) throw new QueryPolicyError('Open the document before running a query.');
        if (!(READ_METHODS as readonly string[]).includes(method)) throw new QueryPolicyError('This operation is not available in a read worker.');
        const canonical = await realpath(approvedPath);
        const current = await stat(approvedPath);
        if (canonical !== approvedPath || current.size !== stamp.size || current.mtimeMs !== stamp.mtimeMs) {
          throw new QueryPolicyError('The source changed. Refresh the document before running another query.');
        }
        const operation = file[method as typeof READ_METHODS[number]] as (...values: any[]) => Promise<unknown>;
        value = await operation.apply(file, args);
      }
      const result = { value, metadata: await metadata() };
      validateResultSize(result);
      process.send?.({ id, value: result });
    } catch (error) {
      process.send?.({ id, error: queryDiagnostic(error).message });
    }
  });
});

process.on('disconnect', () => { file?.dispose(); process.exit(0); });
