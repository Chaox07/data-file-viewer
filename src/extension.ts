import * as vscode from 'vscode';
import { DuckDBEditorProvider } from './duckdbEditorProvider';
import { QueryWorker } from './queryWorker';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(DuckDBEditorProvider.register(context));
}

export function deactivate(): void { QueryWorker.releaseSpare(); }
