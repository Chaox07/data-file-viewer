import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { DuckDbFile, type DuckDbFileOpenOptions, type FileKind, type DetectedSheetTable } from './duckdbConnection';
import { QueryWorker, QueryWorkerOperationError } from './queryWorker';
import { QueryPolicyError } from './queryPolicy';
import type { ReadMetadata, ReadMethod, ReadReply } from './queryProtocol';
import { queryNotices } from './queryDiagnostics';

/** Public document contract; the raw connection class remains the trusted writer. */
export type DocumentFile = Pick<DuckDbFile, keyof DuckDbFile>;

export class ViewerFile implements DocumentFile {
  private readonly worker = new QueryWorker();
  private metadata!: ReadMetadata;
  private writable = false;
  private closed = false;
  private backupPath?: string;
  private warnings: string[] = [];
  private readonly tableIdentities = new Map<string, DetectedSheetTable>();
  private readonly combinedBuilders = new Map<string, Parameters<DuckDbFile['buildCombinedQuery']>>();
  private constructor(private readonly path: string, private readonly forceKind: FileKind | undefined,
    private readonly options: DuckDbFileOpenOptions) {}

  static async open(path: string, forceKind?: FileKind, options: DuckDbFileOpenOptions = {}): Promise<ViewerFile> {
    const file = new ViewerFile(await realpath(path), forceKind, options);
    try {
      file.writable = !options.forceReadOnly && await access(file.path, constants.W_OK).then(() => true, () => false);
      await file.ensureOpen();
      return file;
    } catch (error) { file.dispose(); throw error; }
  }

  private accept(reply: ReadReply): void {
    this.metadata = reply.metadata;
    for (const table of reply.metadata.detectedTables) this.tableIdentities.set(table.name, table);
    this.warnings.push(...reply.metadata.warnings);
  }

  private async ensureOpen(allowChanged = false): Promise<void> {
    if (this.closed) throw new QueryPolicyError('This query view is closed.');
    if (this.worker.running) return;
    const reply = await this.worker.call<ReadReply>('open', [this.path, this.forceKind, {
      ...this.options, backupPath: this.backupPath,
    }]);
    if (!allowChanged && this.metadata && (this.metadata.stamp.size !== reply.metadata.stamp.size || this.metadata.stamp.mtimeMs !== reply.metadata.stamp.mtimeMs)) {
      await this.worker.close();
      throw new QueryPolicyError('The source changed. Refresh the document before running another query.');
    }
    this.accept(reply);
    for (const args of this.combinedBuilders.values()) {
      await this.worker.call<ReadReply>('buildCombinedQuery', args);
    }
  }

  private read<M extends ReadMethod>(method: M, args: Parameters<DuckDbFile[M]>): ReturnType<DuckDbFile[M]> {
    return (async () => {
      await this.ensureOpen();
      let reply: ReadReply;
      try { reply = await this.worker.call<ReadReply>(method, args); }
      catch (error) {
        if (error instanceof QueryWorkerOperationError) this.accept({ value: undefined, metadata: error.metadata as ReadMetadata });
        throw error;
      }
      this.accept(reply);
      if (reply.error) throw new QueryPolicyError(reply.error);
      return reply.value;
    })() as ReturnType<DuckDbFile[M]>;
  }

  get fileKind() { return this.metadata.fileKind; }
  get openWarnings() { return this.metadata.openWarnings; }
  get numberLocale() { return this.metadata.numberLocale; }
  isReadOnly() { return !this.writable || this.metadata.readOnlyByFormat || this.fileKind === 'kdb'; }
  isReadOnlyByFormat() { return this.metadata.readOnlyByFormat; }
  hasSibling() { return this.metadata.hasSibling; }
  hasPendingSheets() { return this.metadata.hasPendingSheets; }
  isWorksheet(name: string) { return this.metadata.worksheets.includes(name); }
  getDetectedSheetTables(sheet: string) { return structuredClone([...this.tableIdentities.values()].filter(table => table.sheet === sheet)); }
  takeLateWarnings() { return this.warnings.splice(0); }
  interruptCurrentQuery() { this.worker.cancel(); }
  dispose() { this.closed = true; this.worker.dispose(); this.warnings = []; this.tableIdentities.clear(); this.combinedBuilders.clear(); }

  listTables = (...a: Parameters<DuckDbFile['listTables']>) => this.read('listTables', a);
  getQueryCatalog = (...a: Parameters<DuckDbFile['getQueryCatalog']>) => this.read('getQueryCatalog', a);
  getQueryColumns = (...a: Parameters<DuckDbFile['getQueryColumns']>) => this.read('getQueryColumns', a);
  listSidebarTables = (...a: Parameters<DuckDbFile['listSidebarTables']>) => this.read('listSidebarTables', a);
  listSiblingTables = (...a: Parameters<DuckDbFile['listSiblingTables']>) => this.read('listSiblingTables', a);
  getCombinableTableNames = (...a: Parameters<DuckDbFile['getCombinableTableNames']>) => this.read('getCombinableTableNames', a);
  async buildCombinedQuery(...args: Parameters<DuckDbFile['buildCombinedQuery']>) {
    const result = await this.read('buildCombinedQuery', args);
    if (this.combinedBuilders.size >= 64) this.combinedBuilders.delete(this.combinedBuilders.keys().next().value!);
    this.combinedBuilders.set(result.sql, args);
    return result;
  }
  getPollCadenceSeconds = (...a: Parameters<DuckDbFile['getPollCadenceSeconds']>) => this.read('getPollCadenceSeconds', a);
  getSeriesFrequency = (...a: Parameters<DuckDbFile['getSeriesFrequency']>) => this.read('getSeriesFrequency', a);
  buildDetectedTableQuery = (...a: Parameters<DuckDbFile['buildDetectedTableQuery']>) => this.read('buildDetectedTableQuery', a);
  runDetectedTableQuery = (...a: Parameters<DuckDbFile['runDetectedTableQuery']>) => this.read('runDetectedTableQuery', a);
  runQuery = (...a: Parameters<DuckDbFile['runQuery']>) => this.read('runQuery', a);
  runChartQuery = (...a: Parameters<DuckDbFile['runChartQuery']>) => this.read('runChartQuery', a);
  runSortedQuery = (...a: Parameters<DuckDbFile['runSortedQuery']>) => this.read('runSortedQuery', a);
  countMatchingRows = (...a: Parameters<DuckDbFile['countMatchingRows']>) => this.read('countMatchingRows', a);
  getColumnTopValues = (...a: Parameters<DuckDbFile['getColumnTopValues']>) => this.read('getColumnTopValues', a);
  getColumnDescriptiveStats = (...a: Parameters<DuckDbFile['getColumnDescriptiveStats']>) => this.read('getColumnDescriptiveStats', a);
  compareToBackup = (...a: Parameters<DuckDbFile['compareToBackup']>) => this.read('compareToBackup', a);
  diffQueryAgainstBackup = (...a: Parameters<DuckDbFile['diffQueryAgainstBackup']>) => this.read('diffQueryAgainstBackup', a);
  async checkEditableSelect(sql: string) {
    if (this.isReadOnly()) return { editable: false } as const;
    return this.read('checkEditableSelect', [sql]);
  }

  async refreshInPlace(): Promise<boolean> {
    await this.worker.close();
    this.tableIdentities.clear();
    await this.ensureOpen(true);
    return true;
  }

  private async write<T>(operation: (file: DuckDbFile) => Promise<T>): Promise<T> {
    if (this.isReadOnly()) throw new QueryPolicyError('This document is read-only.');
    const current = await stat(this.path);
    if (current.size !== this.metadata.stamp.size || current.mtimeMs !== this.metadata.stamp.mtimeMs) {
      throw new QueryPolicyError('The source changed. Refresh before editing.');
    }
    await this.worker.close();
    let writer: DuckDbFile | undefined;
    try {
      writer = await DuckDbFile.open(this.path, this.forceKind, { ...this.options, restrictedReads: false });
      return await operation(writer);
    } finally {
      if (writer) this.warnings.push(...queryNotices(writer.takeLateWarnings()));
      writer?.dispose();
      if (!this.closed) await this.ensureOpen(true);
    }
  }

  async createBackup(): Promise<string> {
    return this.write(async file => { this.backupPath = await file.createBackup(); return this.backupPath; });
  }

  async updateCell(...args: Parameters<DuckDbFile['updateCell']>): Promise<number> {
    const priorTable = this.tableIdentities.get(args[0]);
    return this.write(async file => {
      if (priorTable) {
        await file.runQuery(`select * from "${priorTable.sheet.replace(/"/g, '""')}" limit 0`);
        const current = file.getDetectedSheetTables(priorTable.sheet).find(table => table.name === priorTable.name);
        if (JSON.stringify(current) !== JSON.stringify(priorTable)) throw new QueryPolicyError('The detected table changed. Refresh before editing.');
        await file.buildDetectedTableQuery(priorTable.name);
      }
      return file.updateCell(...args);
    });
  }
}
