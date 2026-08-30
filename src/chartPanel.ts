import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/**
 * The chart's own VS Code tab.
 *
 * A chart used to render inside the grid pane, which meant a table and a
 * picture of the same rows could never be looked at together -- and the panel
 * that held it was one CSS rule away from covering the grid permanently, which
 * is exactly what it did. A separate editor tab is what was asked for and it
 * is also the simpler thing: the grid goes back to owning its whole pane, and
 * the chart gets a tab that can be dragged, split and closed like any other.
 *
 * It also keeps ECharts out of the grid's bundle. The library is ~530 KB and
 * the grid never draws anything; loading it into dist/chartView.js instead
 * means it is fetched the first time a chart is opened and not before.
 */
export class ChartPanel {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  /** Held until the view says it is listening -- see reveal(). */
  private pending: unknown;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly fileName: string
  ) {}

  /**
   * Show `message` in this document's chart tab, creating the tab if needed.
   *
   * ONE panel per document, reused and retitled. Plotting a second column
   * replaces what is drawn rather than opening another tab: the request was
   * for a tab, not for a pile of them, and a column clicked by mistake should
   * not have to be tidied up afterwards.
   */
  reveal(title: string, message: unknown): void {
    if (!this.panel) this.create();
    const panel = this.panel!;
    panel.title = title;
    // preserveFocus, so plotting a column does not move the cursor out of the
    // table the next column will be clicked in.
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, true);

    // A webview that has just been created has not loaded its script yet, so
    // a postMessage sent now goes nowhere and reports no error. Held until the
    // view's own 'ready' arrives; after that, sent straight through.
    if (this.ready) {
      void panel.webview.postMessage(message);
    } else {
      this.pending = message;
    }
  }

  private create(): void {
    const panel = vscode.window.createWebviewPanel(
      'dataFileViewer.chart',
      this.fileName,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        // ECharts holds the zoom/brush state the user just set, and it lives
        // in the page rather than anywhere we could restore it from. Without
        // this, switching tabs and back re-initialises the chart zoomed out.
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'dist'),
          vscode.Uri.joinPath(this.extensionUri, 'media'),
        ],
      }
    );

    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'chartView.js')
    );
    const styleUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css')
    );
    const nonce = randomBytes(16).toString('hex');
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Chart</title>
</head>
<body>
  <div id="chart-root" class="chart-root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;

    const sub = panel.webview.onDidReceiveMessage((m: { command?: string }) => {
      if (m?.command !== 'ready') return;
      this.ready = true;
      if (this.pending !== undefined) {
        void panel.webview.postMessage(this.pending);
        this.pending = undefined;
      }
    });

    panel.onDidDispose(() => {
      sub.dispose();
      this.panel = undefined;
      this.ready = false;
      this.pending = undefined;
    });

    this.panel = panel;
  }

  /** Closing the file closes its chart -- an orphan chart of a document nobody has open is furniture. */
  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}
