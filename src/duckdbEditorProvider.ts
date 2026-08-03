import * as vscode from 'vscode';
import { DuckDbFile } from './duckdbConnection';

class DuckDBDocument implements vscode.CustomDocument {
  private tablesCache: string[] | undefined;

  constructor(readonly uri: vscode.Uri, readonly file: DuckDbFile) {}

  async getTables(): Promise<string[]> {
    if (!this.tablesCache) {
      this.tablesCache = await this.file.listTables();
    }
    return this.tablesCache;
  }

  dispose(): void {
    this.file.dispose();
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

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<DuckDBDocument> {
    try {
      const file = await DuckDbFile.open(uri.fsPath);
      return new DuckDBDocument(uri, file);
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

    const messageSub = webview.onDidReceiveMessage(async (message: { command: string; sql?: string }) => {
      if (message.command === 'ready') {
        try {
          const tables = await document.getTables();
          webview.postMessage({ command: 'tables', tables });
        } catch (err) {
          webview.postMessage({ command: 'error', message: (err as Error).message });
        }
        return;
      }

      if (message.command === 'runQuery' && typeof message.sql === 'string') {
        if (running) return;
        running = true;
        try {
          const result = await document.file.runQuery(message.sql);
          webview.postMessage({ command: 'queryResult', ...result });
        } catch (err) {
          webview.postMessage({ command: 'error', message: (err as Error).message });
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
