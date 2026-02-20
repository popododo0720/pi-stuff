// extension.ts — Pi Workflow VSCode Extension entry point
// Phase 1: Read-only UI companion for pi workflow sessions.

import * as vscode from 'vscode';
import { SessionWatcher } from './core/session-watcher';

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  // Output channel for diagnostics
  const outputChannel = vscode.window.createOutputChannel('Pi Workflow');
  context.subscriptions.push(outputChannel);

  // Session watcher — watches .pi/workflow-session.json
  const sessionWatcher = new SessionWatcher(workspaceRoot, outputChannel);
  sessionWatcher.start();
  context.subscriptions.push(sessionWatcher);

  // Providers and commands are registered in TODO #2 and #3.
  // SessionWatcher.onDidChange will be wired to UI components there.
}

export function deactivate(): void {
  // Cleanup handled via subscriptions.push(disposable)
}
