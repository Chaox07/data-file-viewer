import * as vscode from 'vscode';
import { basename } from 'node:path';
import { DuckDbFile, QueryDiff } from './duckdbConnection';
import { isDestructiveStatement } from './sqlSafety';

class DuckDBDocument implements vscode.CustomDocument {
  private tablesCache: string[] | undefined;

  safeMode = true;
  backupBeforeWrite = true;
  checkForChanges = true;
  hasBackup = false;

  // Set by the runQuery handler after each run, so columnStats/updateCell
  // (which don't carry the SQL text themselves) know what to re-run/target,
  // and so editability is always server-derived, never trusted from the webview.
  lastSql: string | undefined;
  lastEditableTable: string | undefined;
  lastEditableColumns: string[] | undefined;

  constructor(readonly uri: vscode.Uri, readonly file: DuckDbFile, private readonly onDispose?: () => void) {}

  async getTables(): Promise<string[]> {
    if (!this.tablesCache) {
      this.tablesCache = await this.file.listTables();
    }
    return this.tablesCache;
  }

  dispose(): void {
    if (this.hasBackup && this.checkForChanges) {
      // Fire-and-forget: the webview is already gone by the time dispose()
      // runs, so a VS Code notification is the only place left to report
      // this. Connection is closed either way once the comparison settles.
      this.file
        .compareToBackup()
        .then((status) => {
          const entries = Object.entries(status);
          const changed = entries.filter(([, s]) => s !== 'unchanged');
          const fileName = basename(this.uri.fsPath);
          if (changed.length > 0) {
            vscode.window.showInformationMessage(
              `${fileName}: ${changed.length} of ${entries.length} table(s) changed since backup (${changed
                .map(([table]) => table)
                .join(', ')}).`
            );
          } else if (entries.length > 0) {
            vscode.window.showInformationMessage(`${fileName}: no changes since backup.`);
          }
        })
        .catch(() => {
          // Best-effort notification only — never block closing the file over this.
        })
        .finally(() => {
          this.file.dispose();
          this.onDispose?.();
        });
    } else {
      this.file.dispose();
      this.onDispose?.();
    }
  }
}

export class DuckDBEditorProvider implements vscode.CustomReadonlyEditorProvider<DuckDBDocument> {
  public static readonly viewType = 'dataFileViewer.editor';
  public static readonly sqliteViewType = 'dataFileViewer.sqliteEditor';

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new DuckDBEditorProvider(context);
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(DuckDBEditorProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }),
      vscode.window.registerCustomEditorProvider(DuckDBEditorProvider.sqliteViewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      })
    );
  }

  // Unlike .duckdb (direct open) and .db/.sqlite (ATTACH), DuckDB doesn't
  // put any file-level lock on .parquet/.csv — they're read into a :memory:
  // instance, so nothing today stops opening the same path in two tabs, each
  // with its own independent copy and no lock-conflict warning. That's fine
  // for read-only browsing, but with cell editing now writing back to these
  // files, two tabs editing the same path would silently last-write-wins.
  // Guard it the same way the existing DuckDB-native lock error already
  // reads, scoped to just these kinds since duckdb/sqlite already have their
  // own (better — graceful read-only fallback) protection via DuckDbFile.open().
  private readonly openFlatFilePaths = new Set<string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<DuckDBDocument> {
    const isFlatFile = /\.(parquet|csv)$/i.test(uri.fsPath);
    if (isFlatFile && this.openFlatFilePaths.has(uri.fsPath)) {
      const message = `${basename(
        uri.fsPath
      )} is already open in another tab — this file type has no native lock, so a second tab could silently overwrite edits from the first. Close the other tab first.`;
      vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    try {
      const file = await DuckDbFile.open(uri.fsPath);
      if (file.isReadOnly()) {
        vscode.window.showWarningMessage(
          `${basename(uri.fsPath)}: opened read-only — this file is already open elsewhere. Edits will fail until the other handle is released.`
        );
      }
      if (isFlatFile) this.openFlatFilePaths.add(uri.fsPath);
      return new DuckDBDocument(uri, file, isFlatFile ? () => this.openFlatFilePaths.delete(uri.fsPath) : undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(message);
      throw err;
    }
  }

  async resolveCustomEditor(
    document: DuckDBDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css')
    );
    webview.html = getHtml(webview, scriptUri, styleUri);

    // Debounced in the webview too, but guarded here as well since DuckDB's
    // single-connection model would just queue a second query behind the first.
    let running = false;

    type IncomingMessage =
      | { command: 'ready' }
      | { command: 'runQuery'; sql: string }
      | { command: 'toggleSafeMode'; safeMode: boolean; backupBeforeWrite: boolean; checkForChanges: boolean }
      | { command: 'columnStats'; column: string; statsKind: 'numeric' | 'datetime' | 'other'; limit?: number }
      | { command: 'updateCell'; column: string; newValue: unknown; rowValues: Record<string, unknown> };

    const messageSub = webview.onDidReceiveMessage(async (message: IncomingMessage) => {
      if (message.command === 'ready') {
        try {
          const tables = await document.getTables();
          webview.postMessage({ command: 'tables', tables });
        } catch (err) {
          webview.postMessage({ command: 'error', message: (err as Error).message });
        }
        return;
      }

      if (message.command === 'toggleSafeMode') {
        const wasSafeMode = document.safeMode;
        document.backupBeforeWrite = message.backupBeforeWrite;
        document.checkForChanges = message.checkForChanges;

        if (wasSafeMode && !message.safeMode) {
          // Turning Safe Mode OFF.
          if (document.backupBeforeWrite) {
            try {
              const backupPath = await document.file.createBackup();
              document.hasBackup = true;
              document.safeMode = false;
              webview.postMessage({ command: 'backupStatus', message: `Backup created: ${basename(backupPath)}` });
              // A fresh backup makes any previous comparison labels stale.
              webview.postMessage({ command: 'tableChangeStatus', status: {} });
            } catch (err) {
              webview.postMessage({
                command: 'backupStatus',
                message: `Could not create backup — Safe Mode stays on: ${(err as Error).message}`,
              });
            }
          } else {
            document.safeMode = false;
            webview.postMessage({ command: 'backupStatus', message: 'Safe Mode off — no backup was made.' });
            webview.postMessage({ command: 'tableChangeStatus', status: {} });
          }
        } else if (!wasSafeMode && message.safeMode) {
          // Turning Safe Mode back ON (re-lock).
          document.safeMode = true;
          if (document.checkForChanges && document.hasBackup) {
            try {
              const status = await document.file.compareToBackup();
              webview.postMessage({ command: 'tableChangeStatus', status });
            } catch (err) {
              webview.postMessage({ command: 'error', message: (err as Error).message });
            }
          } else {
            webview.postMessage({ command: 'tableChangeStatus', status: {} });
          }
        }

        webview.postMessage({ command: 'safeModeState', safeMode: document.safeMode });
        return;
      }

      if (message.command === 'runQuery' && typeof message.sql === 'string') {
        if (running) return;
        running = true;
        try {
          const destructive = isDestructiveStatement(message.sql);
          if (document.safeMode && destructive) {
            const firstWord = message.sql.trim().match(/^[a-zA-Z]+/)?.[0] ?? 'this statement';
            webview.postMessage({
              command: 'error',
              message: `Blocked by Safe Mode: this looks like a write statement ("${firstWord}"). Uncheck Safe Mode to allow it.`,
            });
            return;
          }

          const result = await document.file.runQuery(message.sql);
          document.lastSql = message.sql;

          let diffFields: Partial<QueryDiff> = {};
          if (!destructive && document.checkForChanges && document.hasBackup) {
            try {
              const diff = await document.file.diffQueryAgainstBackup(message.sql, result.columns, result.rows);
              if (diff) diffFields = diff;
            } catch {
              // Diff highlighting is a nice-to-have; never let it block showing the result.
            }
          }

          const editability = destructive ? { editable: false } : await document.file.checkEditableSelect(message.sql);
          document.lastEditableTable = editability.editable ? editability.table : undefined;
          document.lastEditableColumns = editability.editable ? editability.columns : undefined;

          webview.postMessage({
            command: 'queryResult',
            ...result,
            ...diffFields,
            editable: editability.editable,
            editableTable: editability.editable ? editability.table : undefined,
          });
        } catch (err) {
          webview.postMessage({ command: 'error', message: (err as Error).message });
        } finally {
          running = false;
        }
        return;
      }

      if (message.command === 'columnStats') {
        if (running || !document.lastSql) return;
        running = true;
        try {
          if (message.statsKind === 'other') {
            const stats = await document.file.getColumnTopValues(document.lastSql, message.column, message.limit);
            webview.postMessage({ command: 'columnStatsResult', column: message.column, statsKind: 'other', ...stats });
          } else {
            const stats = await document.file.getColumnDescriptiveStats(document.lastSql, message.column, message.statsKind);
            webview.postMessage({
              command: 'columnStatsResult',
              column: message.column,
              statsKind: message.statsKind,
              ...stats,
            });
          }
        } catch (err) {
          webview.postMessage({ command: 'columnStatsError', column: message.column, message: (err as Error).message });
        } finally {
          running = false;
        }
        return;
      }

      if (message.command === 'updateCell') {
        if (running) return;
        if (document.safeMode) {
          webview.postMessage({
            command: 'cellUpdateError',
            column: message.column,
            message: 'Blocked by Safe Mode: uncheck Safe Mode to allow edits.',
          });
          return;
        }
        if (!document.lastEditableTable || !document.lastEditableColumns?.includes(message.column)) {
          webview.postMessage({
            command: 'cellUpdateError',
            column: message.column,
            message: 'This result is not editable.',
          });
          return;
        }
        const expectedCols = new Set(document.lastEditableColumns);
        const gotCols = Object.keys(message.rowValues);
        if (gotCols.length !== expectedCols.size || !gotCols.every((c) => expectedCols.has(c))) {
          webview.postMessage({
            command: 'cellUpdateError',
            column: message.column,
            message: 'Result changed since this row was loaded — re-run the query and try again.',
          });
          return;
        }

        running = true;
        try {
          const rowsMatched = await document.file.updateCell(
            document.lastEditableTable,
            message.column,
            message.newValue,
            message.rowValues
          );
          if (rowsMatched === 0) {
            webview.postMessage({
              command: 'cellUpdateError',
              column: message.column,
              message: 'No matching row found — the data may have changed. Re-run the query and try again.',
            });
          } else {
            webview.postMessage({
              command: 'cellUpdated',
              column: message.column,
              newValue: message.newValue,
              rowValues: message.rowValues,
              rowsMatched,
            });
          }
        } catch (err) {
          webview.postMessage({ command: 'cellUpdateError', column: message.column, message: (err as Error).message });
        } finally {
          running = false;
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      messageSub.dispose();
    });
  }
}

function getHtml(webview: vscode.Webview, scriptUri: vscode.Uri, styleUri: vscode.Uri): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Data File Viewer</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
