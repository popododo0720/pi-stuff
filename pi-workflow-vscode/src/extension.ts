// extension.ts — Pi Workflow VSCode Extension entry point
// Phase 1: Read-only UI companion for pi workflow sessions.
// Phase 2: RPC-based chat integration with pi coding agent.

import { execFile as execFileCb } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFileCb);
import { showDiff } from './commands/show-diff';
import { SessionWatcher } from './core/session-watcher';
import { PiRpcClient } from './core/rpc-client';
import { ExtensionUIBridge } from './bridge/extension-ui';
import { ChangedFilesTreeProvider } from './providers/files-tree';
import { WorkflowStatusBar } from './providers/status-bar';
import { TodoTreeItem, TodoTreeProvider } from './providers/todo-tree';
import { WorkflowTreeProvider } from './providers/workflow-tree';
import type { WorkflowSession } from './types/workflow';
import { ChatHistoryStore } from './core/chat-history';
import { ChatViewProvider } from './views/chat-panel';
import { PlanPanel } from './views/plan-panel';
import { SettingsPanel } from './views/settings-panel';
import { VerifyPanel } from './views/verify-panel';

// ── Main branch detection (async + cached) ─────────────────────
let cachedMainBranch: string | null = null;

async function detectMainBranch(cwd: string): Promise<string> {
  if (cachedMainBranch) return cachedMainBranch;
  const candidates = ['main', 'master', 'develop'];
  for (const name of candidates) {
    const exists = await new Promise<boolean>((resolve) => {
      execFileCb(
        'git',
        ['rev-parse', '--verify', name],
        { cwd, timeout: 3000 },
        (err) => resolve(!err),
      );
    });
    if (exists) {
      cachedMainBranch = name;
      return name;
    }
  }
  cachedMainBranch = 'main';
  return 'main';
}

// ── Git content URI helper ──────────────────────────────────────
/**
 * Content cache for git-show virtual documents.
 * Avoids encoding large file content into URI query strings.
 */
const gitContentCache = new Map<string, string>();
let gitContentSeq = 0;
const GIT_CACHE_MAX_SIZE = 50;

/**
 * Create a virtual URI showing file content at a specific commit.
 * Uses `git show <commit>:<path>` and caches content in memory.
 */
async function gitShowUri(cwd: string, commit: string, filePath: string): Promise<vscode.Uri> {
  const { stdout } = await execFileAsync(
    'git', ['show', `${commit}:${filePath}`],
    { cwd, timeout: 5000, maxBuffer: 5 * 1024 * 1024 },
  );
  const shortRef = commit === 'HEAD' ? 'HEAD' : commit.slice(0, 7);
  const cacheKey = `${++gitContentSeq}`;
  gitContentCache.set(cacheKey, stdout);
  // FIFO eviction — oldest-inserted entry removed when over limit
  if (gitContentCache.size > GIT_CACHE_MAX_SIZE) {
    const oldest = gitContentCache.keys().next().value;
    if (oldest !== undefined) gitContentCache.delete(oldest);
  }
  return vscode.Uri.parse(`pi-git-show:${filePath}@${shortRef}?${cacheKey}`);
}

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
  const chatHistoryStore = new ChatHistoryStore(context.workspaceState);
  const chatViewProvider = new ChatViewProvider(context.extensionUri, chatHistoryStore);
  context.subscriptions.push(chatViewProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ── Phase 2: Cleanup helper ──────────────────────────────────
  function cleanupChat(): void {
    chatViewProvider.setRpcClient(null);
    settingsPanel?.setRpcClient(null);
    currentBridge?.dispose();
    currentClient = null;
    currentBridge = null;
  }
  // settingsPanel is assigned later in activate(), but cleanupChat is only called at runtime
  let settingsPanel: InstanceType<typeof SettingsPanel> | null = null;

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
    settingsPanel?.setRpcClient(client);

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
        currentClient
          .newSession()
          .then((resp) => {
            const d = resp.data as { cancelled?: boolean } | undefined;
            if (!d?.cancelled) {
              chatHistoryStore.addSessionSeparator();
              chatViewProvider.postToWebview({ type: 'clear' });
            }
          })
          .catch((err) => {
            vscode.window.showErrorMessage(`New session failed: ${err}`);
          });
      }
    }),

    vscode.commands.registerCommand('pi.newWorkflow', async () => {
      if (!currentClient?.isRunning()) {
        startPi();
        await new Promise((r) => setTimeout(r, 1500));
        if (!currentClient?.isRunning()) {
          vscode.window.showErrorMessage('Pi is not running.');
          return;
        }
      }
      const description = await vscode.window.showInputBox({
        prompt: 'Describe the task for the new workflow',
        placeHolder: 'e.g. Add user authentication module',
      });
      if (description?.trim()) {
        if (!currentClient?.isRunning()) {
          vscode.window.showErrorMessage('Pi is no longer running.');
          return;
        }
        currentClient.prompt(`/workflow ${description.trim()}`).catch((err) =>
          vscode.window.showErrorMessage(`Failed to start workflow: ${err}`),
        );
      }
    }),
  );

  // ── Phase 1: Requires workspace folder ───────────────────────
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;

  // ── Session Watcher (created but not started yet) ────────────
  const sessionWatcher = new SessionWatcher(workspaceRoot, outputChannel);
  context.subscriptions.push(sessionWatcher);

  // ── Git Show virtual document provider ─────────────────────
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('pi-git-show', {
      provideTextDocumentContent(uri: vscode.Uri): string {
        // Query is a cache key into gitContentCache
        const key = uri.query;
        if (!key) return ''; // empty document (used for A/D diff sides)
        const content = gitContentCache.get(key);
        return content ?? '';
      },
    }),
  );

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
  settingsPanel = new SettingsPanel(workspaceRoot, context.extensionUri);
  context.subscriptions.push(planPanel, verifyPanel, settingsPanel);

  // Track last auto-opened plan to avoid reopening after user closes
  let lastAutoOpenPlanId = '';
  let lastSyncedWorkflowId: string | null = null;

  // ── UI Sync Helper ────────────────────────────────────────────
  function syncUI(session: WorkflowSession | null): void {
    const newId = session?.id ?? null;
    const idChanged = newId !== lastSyncedWorkflowId;
    lastSyncedWorkflowId = newId;
    chatHistoryStore.setWorkflowId(newId);
    statusBar.update(session);
    workflowTree.update(session);
    todoTree.update(session);

    // Auto-open plan panel when planContent first appears (or changes)
    const planKey = session ? `${session.id}:${session.planContent?.length ?? 0}` : '';
    if (session?.planContent && !planPanel.isVisible() && planKey !== lastAutoOpenPlanId) {
      lastAutoOpenPlanId = planKey;
      planPanel.show(session);
    } else {
      planPanel.update(session);
    }

    verifyPanel.update(session);
    updateContextKey(session);

    // Done state: commit range from TODOs (survives branch deletion)
    if (session?.state === 'done' || session?.completed) {
      const firstStart = session.todos.find(t => t.startCommit)?.startCommit;
      const lastEnd = [...session.todos].reverse().find(t => t.endCommit)?.endCommit;
      filesTree.setBaseBranch(null);
      filesTree.setCommitRange(firstStart ?? null, lastEnd ?? null);
      filesTree.refresh();
    } else {
      // Active workflow: branch-based diff
      const gitBranch = session?.gitBranch ?? null;
      if (gitBranch) {
        detectMainBranch(workspaceRoot!).then((base) => {
          filesTree.setBaseBranch(base);
          filesTree.setCommitRange(null, null);
          filesTree.refresh();
        });
      } else {
        filesTree.setBaseBranch(null);
        filesTree.setCommitRange(null, null);
        filesTree.refresh();
      }
    }

    // Resend history when workflowId changes (fixes race condition on reload).
    // Uses local store here because pi session may not have switched yet
    // (selectWorkflow calls newSession after syncUI fires).
    // The webview 'ready' handler uses getMessages() for accurate pi-sourced history.
    if (idChanged) {
      chatViewProvider.postToWebview({ type: 'clear' });
      const history = chatHistoryStore.getAll();
      if (history.length > 0) {
        chatViewProvider.postToWebview({ type: 'loadHistory', messages: history });
      }
    }
  }

  // ── Watcher → UI Binding (subscribe BEFORE start) ────────────
  const watcherDisposable = sessionWatcher.onDidChange(syncUI);
  context.subscriptions.push(watcherDisposable);

  // ── Workflow list → tree binding ──────────────────────────────
  const listDisposable = sessionWatcher.onDidChangeList((list) => {
    workflowTree.updateList(list);
  });
  context.subscriptions.push(listDisposable);

  // ── Clear stale active pointer from previous session ──────────
  // The active file persists on disk, but pi chat process is not running
  // after a VS Code restart. Clear it so no workflow appears active until
  // the user explicitly clicks one.
  void sessionWatcher.clearActiveId();

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
    vscode.commands.registerCommand('pi.openSettings', () => settingsPanel.show()),
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
    vscode.commands.registerCommand(
      'pi.openCommitDiff',
      async (filePath: string, status: string, startCommit: string, endCommit: string, oldPath?: string) => {
        try {
          const absPath = join(workspaceRoot, filePath);
          const fileUri = vscode.Uri.file(absPath);
          const emptyUri = vscode.Uri.parse('pi-git-show:empty?');

          if (status === 'A') {
            // Added file: show right side only (empty → new)
            // Use workspace file when endCommit is HEAD (active TODO)
            const rightUri = endCommit === 'HEAD'
              ? fileUri
              : await gitShowUri(workspaceRoot, endCommit, filePath);
            await vscode.commands.executeCommand('vscode.diff',
              emptyUri, rightUri,
              `${filePath} (Added)`,
            );
          } else if (status === 'D') {
            // Deleted file: show left side only (old → empty)
            const leftUri = await gitShowUri(workspaceRoot, startCommit, filePath);
            await vscode.commands.executeCommand('vscode.diff',
              leftUri, emptyUri,
              `${filePath} (Deleted)`,
            );
          } else {
            // Modified/Renamed/Copied: show both sides
            // For rename/copy, use oldPath for the left (start commit) side
            const leftPath = oldPath ?? filePath;
            const leftUri = await gitShowUri(workspaceRoot, startCommit, leftPath);
            // If endCommit is HEAD and file exists on disk, use the workspace file
            const rightUri = endCommit === 'HEAD'
              ? fileUri
              : await gitShowUri(workspaceRoot, endCommit, filePath);
            await vscode.commands.executeCommand('vscode.diff',
              leftUri, rightUri,
              `${filePath} (${startCommit.slice(0, 7)}..${endCommit.slice(0, 7)})`,
            );
          }
        } catch {
          // Fallback: just open the file
          const fileUri = vscode.Uri.file(join(workspaceRoot, filePath));
          await vscode.commands.executeCommand('vscode.open', fileUri);
        }
      },
    ),
    vscode.commands.registerCommand('pi.selectWorkflow', async (arg: unknown) => {
      // Support both direct id (string) and WorkflowNode from context menu
      const id = typeof arg === 'string'
        ? arg
        : (arg && typeof arg === 'object' && 'kind' in arg)
          ? (arg as { item?: { id?: string } }).item?.id
          : undefined;
      if (!id) return;
      await sessionWatcher.setActiveId(id);
      // syncUI handles workflowId switch + history resend via onDidChange

      // Reset pi context if running
      if (currentClient?.isRunning()) {
        try {
          await currentClient.newSession();
          // Session is already active via setActiveId.
          // syncUI handles tree/status/history update.
          // Next user message triggers before_agent_start which loads the session.
        } catch { /* pi may not be running */ }
      }
    }),

    vscode.commands.registerCommand('pi.deleteWorkflow', async (node?: { kind: string; item?: { id: string } }) => {
      const workflowId = node?.kind === 'workflow' ? node.item?.id : undefined;
      if (!workflowId) return;

      const confirm = await vscode.window.showWarningMessage(
        `Delete workflow "${workflowId}"? This cannot be undone.`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;

      const { gitBranch } = await sessionWatcher.deleteWorkflow(workflowId);

      if (gitBranch) {
        try {
          await new Promise<void>((resolve, reject) => {
            execFileCb('git', ['branch', '-D', gitBranch],
              { cwd: workspaceRoot!, timeout: 5000 },
              (err) => err ? reject(err) : resolve());
          });
        } catch { /* branch may not exist or currently checked out */ }
      }

      vscode.window.showInformationMessage(`Workflow "${workflowId}" deleted.`);
    }),

    vscode.commands.registerCommand('pi.selectTodo', (todoIndex: number) => {
      const session = sessionWatcher.getState();
      if (!session) return;

      if (todoIndex < 0 || !session.todos[todoIndex]) {
        // -1 or out of range → reset to branch-level diff
        filesTree.setCommitRange(null, null);
        filesTree.refresh();
        return;
      }

      const todo = session.todos[todoIndex];

      // Validate commit refs (SHA hex or HEAD only)
      const isValidRef = (ref: unknown): ref is string =>
        typeof ref === 'string' && (ref === 'HEAD' || /^[0-9a-f]{7,40}$/i.test(ref));

      // Done TODO: startCommit..endCommit (both required)
      // Active TODO: startCommit..HEAD (endCommit not yet available)
      // Pending TODO: no diff
      if (todo.status === 'done' && isValidRef(todo.startCommit) && isValidRef(todo.endCommit)) {
        filesTree.setCommitRange(todo.startCommit, todo.endCommit);
        filesTree.refresh();
      } else if (todo.status === 'active' && isValidRef(todo.startCommit)) {
        filesTree.setCommitRange(todo.startCommit, 'HEAD');
        filesTree.refresh();
      } else {
        // Pending or missing refs → reset to branch-level diff
        filesTree.setCommitRange(null, null);
        filesTree.refresh();
      }

      // Show verification result for this TODO
      if (typeof todo.verifyResult === 'string' && todo.verifyResult) {
        verifyPanel.showText(
          `Verification: TODO #${todoIndex + 1}`,
          todo.verifyResult,
        );
      }
    }),

    // ── Rollback TODO ────────────────────────────────────────
    vscode.commands.registerCommand('pi.rollbackTodo', async (item: unknown) => {
      if (!(item instanceof TodoTreeItem)) return;
      const targetIndex = item.todoIndex;

      const session = sessionWatcher.getState();
      if (!session?.id) return;

      const filePath = join(workspaceRoot, '.pi', 'workflows', `${session.id}.json`);
      let raw: any;
      try {
        raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        vscode.window.showErrorMessage('Failed to read session file.');
        return;
      }

      const commit = raw.todos?.[targetIndex]?.startCommit;
      if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit)) {
        vscode.window.showErrorMessage('No valid commit reference found for this TODO.');
        return;
      }

      if (currentClient?.isRunning()) {
        vscode.window.showErrorMessage('Stop the agent before rollback.');
        return;
      }

      let isDirty = false;
      try {
        await execFileAsync('git', ['diff-index', '--quiet', 'HEAD'], { cwd: workspaceRoot });
      } catch {
        isDirty = true;
      }

      const msg = isDirty
        ? `Rollback to ${commit.slice(0, 7)}? Uncommitted changes AND all work since TODO #${targetIndex + 1} will be lost.`
        : `Rollback to ${commit.slice(0, 7)}? All work since TODO #${targetIndex + 1} will be lost.`;
      const confirm = await vscode.window.showWarningMessage(msg, { modal: true }, 'Rollback');
      if (confirm !== 'Rollback') return;

      try {
        await execFileAsync('git', ['reset', '--hard', commit], { cwd: workspaceRoot });
      } catch (e) {
        vscode.window.showErrorMessage(`Git reset failed: ${e}`);
        return;
      }

      // Modify raw JSON directly to preserve workflow-extension-only fields
      raw.todos[targetIndex].status = 'active';
      delete raw.todos[targetIndex].endCommit;
      delete raw.todos[targetIndex].verifyResult;
      delete raw.todos[targetIndex].implementationNotes;

      for (let i = targetIndex + 1; i < raw.todos.length; i++) {
        raw.todos[i].status = 'pending';
        delete raw.todos[i].startCommit;
        delete raw.todos[i].endCommit;
        delete raw.todos[i].verifyResult;
        delete raw.todos[i].implementationNotes;
      }

      raw.activeTodoIndex = targetIndex;
      raw.state = 'implement';
      raw.retryCount = 0;
      raw.completed = false;
      raw.compoundStep = 0;
      delete raw.compoundMemorySnapshot;

      try {
        writeFileSync(filePath, JSON.stringify(raw, null, '\t'), 'utf-8');
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to update session file after rollback: ${e}`);
      }
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
