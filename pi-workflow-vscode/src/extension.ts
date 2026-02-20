// extension.ts — Pi Workflow VSCode Extension entry point
// Phase 1: Read-only UI companion for pi workflow sessions.

import * as vscode from 'vscode';
import { SessionWatcher } from './core/session-watcher';
import { ChangedFilesTreeProvider } from './providers/files-tree';
import { WorkflowStatusBar } from './providers/status-bar';
import { TodoTreeProvider } from './providers/todo-tree';
import { WorkflowTreeProvider } from './providers/workflow-tree';

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  // Output channel for diagnostics
  const outputChannel = vscode.window.createOutputChannel('Pi Workflow');
  context.subscriptions.push(outputChannel);

  // ── Session Watcher ──────────────────────────────────────────
  const sessionWatcher = new SessionWatcher(workspaceRoot, outputChannel);
  sessionWatcher.start();
  context.subscriptions.push(sessionWatcher);

  // ── Status Bar ───────────────────────────────────────────────
  const statusBar = new WorkflowStatusBar();
  context.subscriptions.push(statusBar);

  // ── Tree Views ───────────────────────────────────────────────
  const workflowTree = new WorkflowTreeProvider();
  const todoTree = new TodoTreeProvider();
  const filesTree = new ChangedFilesTreeProvider(workspaceRoot);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('pi.status', workflowTree),
    vscode.window.registerTreeDataProvider('pi.todos', todoTree),
    vscode.window.registerTreeDataProvider('pi.files', filesTree),
  );
  context.subscriptions.push(workflowTree, todoTree, filesTree);

  // ── Watcher → UI Binding ─────────────────────────────────────
  const watcherDisposable = sessionWatcher.onDidChange((session) => {
    statusBar.update(session);
    workflowTree.update(session);
    todoTree.update(session);
    filesTree.refresh();
  });
  context.subscriptions.push(watcherDisposable);

  // Also refresh files on file save (git status may change independently)
  const saveDisposable = vscode.workspace.onDidSaveTextDocument(() => {
    filesTree.refresh();
  });
  context.subscriptions.push(saveDisposable);

  // ── Commands ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('pi.refresh', () => {
      sessionWatcher.reload();
      filesTree.refresh();
    }),
  );

  // Placeholder commands for TODO #3 (plan/verification/diff panels)
  context.subscriptions.push(
    vscode.commands.registerCommand('pi.openPlan', () => {
      const session = sessionWatcher.getState();
      if (session?.planContent) {
        vscode.window.showInformationMessage(
          'Plan viewer will be available in TODO #3.',
        );
      } else {
        vscode.window.showInformationMessage('No plan available yet.');
      }
    }),
    vscode.commands.registerCommand('pi.openVerification', () => {
      const session = sessionWatcher.getState();
      if (session?.verifyPlanResult) {
        vscode.window.showInformationMessage(
          'Verification viewer will be available in TODO #3.',
        );
      } else {
        vscode.window.showInformationMessage(
          'No verification results yet.',
        );
      }
    }),
    vscode.commands.registerCommand('pi.showDiff', () => {
      vscode.window.showInformationMessage(
        'Diff viewer will be available in TODO #3.',
      );
    }),
  );

  // ── Initial load trigger ─────────────────────────────────────
  // SessionWatcher.start() already does initial load, which will
  // fire onDidChange and update all UI components.
}

export function deactivate(): void {
  // Cleanup handled via context.subscriptions
}
