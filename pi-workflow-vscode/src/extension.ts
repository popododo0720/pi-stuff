// extension.ts — Pi Workflow VSCode Extension entry point
// Phase 1: Read-only UI companion for pi workflow sessions.

import * as vscode from 'vscode';
import { showDiff } from './commands/show-diff';
import { SessionWatcher } from './core/session-watcher';
import { ChangedFilesTreeProvider } from './providers/files-tree';
import { WorkflowStatusBar } from './providers/status-bar';
import { TodoTreeProvider } from './providers/todo-tree';
import { WorkflowTreeProvider } from './providers/workflow-tree';
import type { WorkflowSession } from './types/workflow';
import { PlanPanel } from './views/plan-panel';
import { VerifyPanel } from './views/verify-panel';

function updateContextKey(session: WorkflowSession | null): void {
  const active = !!session && !session.completed && session.state !== 'done';
  vscode.commands.executeCommand('setContext', 'pi.hasActiveWorkflow', active);
}

export function activate(context: vscode.ExtensionContext): void {
  // Set initial context before any guards — prevents stale state across window transitions
  vscode.commands.executeCommand('setContext', 'pi.hasActiveWorkflow', false);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  // Output channel for diagnostics
  const outputChannel = vscode.window.createOutputChannel('Pi Workflow');
  context.subscriptions.push(outputChannel);

  // ── Session Watcher (created but not started yet) ────────────
  const sessionWatcher = new SessionWatcher(workspaceRoot, outputChannel);
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

  // ── Webview Panels ───────────────────────────────────────────
  const planPanel = new PlanPanel();
  const verifyPanel = new VerifyPanel();
  context.subscriptions.push(planPanel, verifyPanel);

  // ── UI Sync Helper ────────────────────────────────────────────
  function syncUI(session: WorkflowSession | null): void {
    statusBar.update(session);
    workflowTree.update(session);
    todoTree.update(session);
    filesTree.refresh();
    planPanel.update(session);
    verifyPanel.update(session);
    updateContextKey(session);
  }

  // ── Watcher → UI Binding (subscribe BEFORE start) ────────────
  const watcherDisposable = sessionWatcher.onDidChange(syncUI);
  context.subscriptions.push(watcherDisposable);

  // ── Start watcher (async load begins) ────────────────────────
  sessionWatcher.start();

  // ── Initial sync (covers the gap before async load completes) ─
  syncUI(sessionWatcher.getState());

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
    vscode.commands.registerCommand('pi.openPlan', () => {
      const session = sessionWatcher.getState();
      if (session?.planContent) {
        planPanel.show(session);
      } else {
        vscode.window.showInformationMessage('No plan available yet.');
      }
    }),
    vscode.commands.registerCommand('pi.openVerification', () => {
      const session = sessionWatcher.getState();
      if (session?.verifyPlanResult) {
        verifyPanel.show(session);
      } else {
        vscode.window.showInformationMessage(
          'No verification results yet.',
        );
      }
    }),
    vscode.commands.registerCommand('pi.showDiff', () => showDiff(workspaceRoot)),
  );
}

export function deactivate(): void {
  // Cleanup handled via context.subscriptions
}
