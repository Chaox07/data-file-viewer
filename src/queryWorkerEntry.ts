import { realpath, stat } from 'node:fs/promises';
import { DuckDbFile, baseTableOfSelect, type DuckDbFileOpenOptions, type FileKind } from './duckdbConnection';
import { queryDiagnostic, queryNotices } from './queryDiagnostics';
import { QueryPolicyError, validateResultSize } from './queryPolicy';
import { READ_METHODS } from './queryProtocol';
import { preflightWorkbook } from './xlsxBudget';

/** No write methods are exposed by the read worker. */
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
    openWarnings: queryNotices(file.openWarnings),
    numberLocale: file.numberLocale,
    stamp,
    warnings: queryNotices(file.takeLateWarnings()),
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
        if (/\.xlsx$/i.test(approvedPath)) await preflightWorkbook(approvedPath);
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
        value = await operation.apply(file, method === 'checkEditableSelect' ? [args[0], true] : args);
      }
      const result = { value, metadata: await metadata() };
      validateResultSize(result);
      process.send?.({ id, value: result });
    } catch (error) {
      const rawWorksheet = method === 'runQuery' && typeof args[0] === 'string' && !!file?.isWorksheet(baseTableOfSelect(args[0]) ?? '');
      const diagnostic = queryDiagnostic(error, rawWorksheet).message;
      if (file) {
        try {
          const result = { value: undefined, metadata: await metadata(), error: diagnostic };
          validateResultSize(result);
          process.send?.({ id, value: result });
        }
        catch { process.send?.({ id, error: diagnostic }); }
      } else process.send?.({ id, error: diagnostic });
    }
  });
});

process.on('disconnect', () => { file?.dispose(); process.exit(0); });
