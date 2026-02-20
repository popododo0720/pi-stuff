// extension.ts — Pi Workflow VSCode Extension entry point
// Phase 1: Read-only UI companion for pi workflow sessions.
// Phase 2: RPC-based chat integration with pi coding agent.

import * as vscode from 'vscode';
import { showDiff } from './commands/show-diff';
import { SessionWatcher } from './core/session-watcher';
import { PiRpcClient } from './core/rpc-client';
import { ExtensionUIBridge } from './bridge/extension-ui';
import { ChangedFilesTreeProvider } from './providers/files-tree';
import { WorkflowStatusBar } from './providers/status-bar';
import { TodoTreeProvider } from './providers/todo-tree';
import { WorkflowTreeProvider } from './providers/workflow-tree';
import type { WorkflowSession } from './types/workflow';
import { ChatViewProvider } from './views/chat-panel';
import { PlanPanel } from './views/plan-panel';
import { VerifyPanel } from './views/verify-panel';

// ── Phase 2 state ──────────────────────────────────────────────
let currentClient: PiRpcClient | null = null;
let currentBridge: ExtensionUIBridge | null = null;
let stoppingIntentionally = false;

function updateContextKey(session: WorkflowSession | null): void {
  const active = !!session && !session.completed && session.state !== 'done';
  vscode.commands.executeCommand('setContext', 'pi.hasActiveWorkflow', active);
}

export function activate(context: vscode.ExtensionContext): void {
  // Set initial context before any guards — prevents stale state across window transitions
  vscode.commands.executeCommand('setContext', 'pi.hasActiveWorkflow', false);

  // Output channel for diagnostics (shared across Phase 1 & 2)
  const outputChannel = vscode.window.createOutputChannel('Pi Workflow');
  context.subscriptions.push(outputChannel);

  // ── Phase 2: Chat Webview (registered regardless of workspace) ──
  const chatViewProvider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(chatViewProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ── Phase 2: Cleanup helper ──────────────────────────────────
  function cleanupChat(): void {
    chatViewProvider.setRpcClient(null);
    currentBridge?.dispose();
    currentClient = null;
    currentBridge = null;
  }

  // ── Phase 2: Start pi process (extracted for auto-start) ─────
  function startPi(): void {
    if (currentClient?.isRunning()) return;
    // Workspace trust gate: do not auto-spawn processes in untrusted workspaces
    if (!vscode.workspace.isTrusted) return;

    const config = vscode.workspace.getConfiguration('pi-workflow');
    const piPath = config.get<string>('piPath') || 'pi';
    const defaultProvider = config.get<string>('defaultProvider') || undefined;
    const defaultModel = config.get<string>('defaultModel') || undefined;
    const extraArgs = config.get<string[]>('extraArgs') || [];

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;

    const client = new PiRpcClient({
      cwd,
      piPath,
      provider: defaultProvider,
      model: defaultModel,
      extraArgs,
    });

    client.on('error', (err: Error) => {
      if (currentClient !== client) return;
      vscode.window.showErrorMessage(`Pi error: ${err.message}`);
      cleanupChat();
      stoppingIntentionally = false;
    });
    client.on('exit', (code: number | null) => {
      if (currentClient !== client) return;
      if (!stoppingIntentionally) {
        vscode.window.showInformationMessage(`Pi exited (code ${code ?? 'unknown'}).`);
      }
      cleanupChat();
      stoppingIntentionally = false;
    });
    client.on('stderr', (text: string) => {
      outputChannel.appendLine(`[pi stderr] ${text}`);
    });

    client.start();

    const bridge = new ExtensionUIBridge(client);
    bridge.bind();
    chatViewProvider.setRpcClient(client);

    currentClient = client;
    currentBridge = bridge;
  }

  // ── Phase 2: Chat commands ───────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('pi.startChat', () => startPi()),

    vscode.commands.registerCommand('pi.stopChat', () => {
      if (currentClient) {
        stoppingIntentionally = true;
        currentClient.stop();
        cleanupChat();
        stoppingIntentionally = false;
      }
    }),

    vscode.commands.registerCommand('pi.newSession', () => {
      if (currentClient?.isRunning()) {
        currentClient.newSession().catch((err) => {
          vscode.window.showErrorMessage(`New session failed: ${err}`);
        });
      }
    }),
  );

  // ── Phase 1: Requires workspace folder ───────────────────────
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

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

  const statusTreeView = vscode.window.createTreeView('pi.status', {
    treeDataProvider: workflowTree,
  });
  context.subscriptions.push(
    statusTreeView,
    vscode.window.registerTreeDataProvider('pi.todos', todoTree),
    vscode.window.registerTreeDataProvider('pi.files', filesTree),
  );
  context.subscriptions.push(workflowTree, todoTree, filesTree);

  // ── Auto-reveal chat when Pi sidebar opens ────────────────────
  statusTreeView.onDidChangeVisibility((e) => {
    if (e.visible) {
      vscode.commands.executeCommand('pi.chat.focus');
    }
  });

  // ── Auto-start pi + workflow resume on chat resolve ────────────
  context.subscriptions.push(
    chatViewProvider.onDidResolve(() => {
      startPi();

      // Auto-resume: getState() as readiness probe, then send /workflow
      if (currentClient) {
        const client = currentClient;
        const session = sessionWatcher.getState();
        if (session && session.state !== 'done' && !session.completed) {
          client
            .getState()
            .then(() => {
              if (currentClient === client) {
                client.prompt('/workflow').catch(() => {});
              }
            })
            .catch(() => {}); // pi not ready yet, skip
        }
      }
    }),
  );

  // ── First-launch: move chat to secondary sidebar ──────────────
  const hasMovedChat = context.globalState.get<boolean>('pi.chatMovedToAux', false);
  if (!hasMovedChat) {
    setTimeout(async () => {
      try {
        await vscode.commands.executeCommand('pi.chat.focus');
        await new Promise((r) => setTimeout(r, 500));
        await vscode.commands.executeCommand(
          'workbench.action.moveViewToSecondarySideBar',
        );
        await context.globalState.update('pi.chatMovedToAux', true);
      } catch {
        vscode.window.showInformationMessage(
          'Tip: Right-click "Pi Chat" tab → "Move to Secondary Side Bar"',
        );
        await context.globalState.update('pi.chatMovedToAux', true);
      }
    }, 2000);
  }

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

  // ── Workflow list → tree binding ──────────────────────────────
  const listDisposable = sessionWatcher.onDidChangeList((list) => {
    workflowTree.updateList(list);
  });
  context.subscriptions.push(listDisposable);

  // ── Start watcher (async load begins) ────────────────────────
  sessionWatcher.start();

  // ── Initial sync (covers the gap before async load completes) ─
  syncUI(sessionWatcher.getState());

  // Also refresh files on file save (git status may change independently)
  const saveDisposable = vscode.workspace.onDidSaveTextDocument(() => {
    filesTree.refresh();
  });
  context.subscriptions.push(saveDisposable);

  // ── Phase 1: Commands ────────────────────────────────────────
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
    vscode.commands.registerCommand('pi.selectWorkflow', async (id: string) => {
      await sessionWatcher.setActiveId(id);
    }),
  );
}

export function deactivate(): void {
  // Stop any running RPC process
  if (currentClient) {
    stoppingIntentionally = true;
    currentClient.stop();
    currentClient = null;
  }
  currentBridge?.dispose();
  currentBridge = null;
  stoppingIntentionally = false;
}
