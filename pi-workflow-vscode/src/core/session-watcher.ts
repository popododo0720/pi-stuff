// core/session-watcher.ts — Watches .pi/workflows/ directory for changes
// Multi-workflow: tracks all workflow files + active pointer.
// Single workspace root assumption (Phase 1). Multi-root not supported.

import * as vscode from 'vscode';
import type { TodoItem, WorkflowListItem, WorkflowSession, WorkflowState } from '../types/workflow';
import { VALID_STATES, VALID_TODO_STATUSES } from '../types/workflow';

const WORKFLOWS_DIR = '.pi/workflows';
const ACTIVE_FILE = '.pi/workflows/active';
const DEBOUNCE_MS = 500;

// Safety limits
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_COMPOUND_STEPS = 20; // Safety ceiling — VSCode can't import workflow-extension constants
const MAX_STRING_LENGTH = 500_000; // 500KB per string field
const MAX_SHORT_STRING = 1000; // id, description, gitBranch, todo title, name
const MAX_TODOS = 100;

export class SessionWatcher implements vscode.Disposable {
  // Active session (for statusBar, todoTree, planPanel, etc.)
  private readonly _onDidChange = new vscode.EventEmitter<WorkflowSession | null>();
  readonly onDidChange = this._onDidChange.event;
  private state: WorkflowSession | null = null;

  // Workflow list (for workflowTree)
  private readonly _onDidChangeList = new vscode.EventEmitter<WorkflowListItem[]>();
  readonly onDidChangeList = this._onDidChangeList.event;
  private workflows: Map<string, WorkflowSession> = new Map();
  private activeId: string | null = null;

  // File watchers
  private dirWatcher: vscode.FileSystemWatcher | undefined;
  private activeWatcher: vscode.FileSystemWatcher | undefined;

  // Self-write guard: prevents reload loop when VSCode writes to active file
  // Counter-based to handle multiple concurrent async writes correctly
  private selfWriteCount = 0;

  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private loadVersion = 0;

  constructor(
    private readonly workspaceRoot: string,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  /** Start watching and perform initial load. */
  start(): void {
    void this.loadAll();

    // Watch all .json files in .pi/workflows/
    this.dirWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceRoot, '.pi/workflows/*.json'),
    );
    this.dirWatcher.onDidChange(() => this.scheduleLoad());
    this.dirWatcher.onDidCreate(() => this.scheduleLoad());
    this.dirWatcher.onDidDelete(() => this.scheduleLoad());

    // Watch active pointer file
    this.activeWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceRoot, ACTIVE_FILE),
    );
    this.activeWatcher.onDidChange(() => {
      if (this.selfWriteCount > 0) { this.selfWriteCount--; return; }
      this.scheduleLoad();
    });
    this.activeWatcher.onDidCreate(() => {
      if (this.selfWriteCount > 0) { this.selfWriteCount--; return; }
      this.scheduleLoad();
    });
    this.activeWatcher.onDidDelete(() => this.scheduleLoad());
  }

  /** Force a manual reload. */
  reload(): void {
    void this.loadAll();
  }

  /** Get current active session. */
  getState(): WorkflowSession | null {
    return this.state;
  }

  /** Get list of all workflows. */
  getList(): WorkflowListItem[] {
    const items: WorkflowListItem[] = [];
    for (const [id, session] of this.workflows) {
      items.push({
        id,
        name: session.name,
        state: session.state,
        description: session.description,
        active: id === this.activeId,
      });
    }
    return items;
  }

  /** Clear the active pointer (writes empty string, triggers reload). */
  async clearActiveId(): Promise<void> {
    this.selfWriteCount++;
    try {
      const activeUri = vscode.Uri.joinPath(
        vscode.Uri.file(this.workspaceRoot),
        ACTIVE_FILE,
      );
      await vscode.workspace.fs.writeFile(activeUri, new TextEncoder().encode(''));
    } catch (e) {
      if (this.selfWriteCount > 0) this.selfWriteCount--;
      console.warn('[watcher] clearActiveId failed:', e);
      return;
    }
    void this.loadAll();
  }

  /** Set active workflow ID (writes active file, triggers reload). */
  async setActiveId(id: string): Promise<void> {
    this.selfWriteCount++;
    try {
      const activeUri = vscode.Uri.joinPath(
        vscode.Uri.file(this.workspaceRoot),
        ACTIVE_FILE,
      );
      await vscode.workspace.fs.writeFile(activeUri, new TextEncoder().encode(id));
    } catch (e) {
      if (this.selfWriteCount > 0) this.selfWriteCount--;
      console.warn('[watcher] setActiveId failed:', e);
      return;
    }
    // Trigger manual reload after self-write
    void this.loadAll();
  }

  /** Delete a workflow: remove JSON + memory files, clear active pointer if needed. */
  async deleteWorkflow(id: string): Promise<{ gitBranch?: string }> {
    const session = this.workflows.get(id);
    const gitBranch = session?.gitBranch;

    // Delete workflow JSON
    try {
      const fileUri = vscode.Uri.joinPath(
        vscode.Uri.file(this.workspaceRoot), WORKFLOWS_DIR, `${id}.json`);
      await vscode.workspace.fs.delete(fileUri);
    } catch { /* file may not exist */ }

    // Delete per-workflow memory file
    try {
      const memUri = vscode.Uri.joinPath(
        vscode.Uri.file(this.workspaceRoot), WORKFLOWS_DIR, `${id}-memory.json`);
      await vscode.workspace.fs.delete(memUri);
    } catch { /* file may not exist */ }

    // Clear active pointer if this was the active workflow
    if (this.activeId === id) {
      this.selfWriteCount++;
      try {
        const activeUri = vscode.Uri.joinPath(
          vscode.Uri.file(this.workspaceRoot), ACTIVE_FILE);
        await vscode.workspace.fs.writeFile(activeUri, new TextEncoder().encode(''));
      } catch {
        if (this.selfWriteCount > 0) this.selfWriteCount--;
      }
    }

    // Update in-memory state
    this.workflows.delete(id);
    if (this.activeId === id) {
      this.activeId = null;
      this.state = null;
      this._onDidChange.fire(null);
    }
    this._onDidChangeList.fire(this.getList());
    return { gitBranch };
  }

  // ── Private ──────────────────────────────────────────────────

  private resetState(): void {
    ++this.loadVersion;
    this.state = null;
    this.workflows.clear();
    this.activeId = null;
    this._onDidChange.fire(null);
    this._onDidChangeList.fire([]);
  }

  private scheduleLoad(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.loadAll();
    }, DEBOUNCE_MS);
  }

  private async loadAll(): Promise<void> {
    const thisVersion = ++this.loadVersion;
    try {
      // Read active pointer
      const activeUri = vscode.Uri.joinPath(
        vscode.Uri.file(this.workspaceRoot),
        ACTIVE_FILE,
      );
      let newActiveId: string | null = null;
      try {
        const stat = await vscode.workspace.fs.stat(activeUri);
        // Guard: active file should be tiny (just an ID). Reject if > 1KB.
        if (stat.size <= 1024) {
          const bytes = await vscode.workspace.fs.readFile(activeUri);
          newActiveId = new TextDecoder().decode(bytes).trim() || null;
        }
      } catch {
        /* no active file */
      }

      if (thisVersion !== this.loadVersion) return;

      // Read all workflow files
      const dirUri = vscode.Uri.joinPath(
        vscode.Uri.file(this.workspaceRoot),
        WORKFLOWS_DIR,
      );
      let entries: [string, vscode.FileType][] = [];
      try {
        entries = await vscode.workspace.fs.readDirectory(dirUri);
      } catch {
        /* dir doesn't exist yet */
      }

      if (thisVersion !== this.loadVersion) return;

      const newWorkflows = new Map<string, WorkflowSession>();
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
        try {
          const fileUri = vscode.Uri.joinPath(dirUri, name);
          const stat = await vscode.workspace.fs.stat(fileUri);
          if (stat.size > MAX_FILE_SIZE) continue;
          const bytes = await vscode.workspace.fs.readFile(fileUri);
          const text = new TextDecoder().decode(bytes);
          const session = this.parseSession(JSON.parse(text));
          if (session) newWorkflows.set(session.id, session);
        } catch {
          /* skip invalid */
        }
      }

      if (thisVersion !== this.loadVersion) return;

      this.workflows = newWorkflows;
      this.activeId = newActiveId;
      const newState = newActiveId
        ? (newWorkflows.get(newActiveId) ?? null)
        : null;

      // Fire active session change (lightweight comparison to avoid serializing large fields)
      const changed = this.state?.id !== newState?.id
        || this.state?.state !== newState?.state
        || this.state?.description !== newState?.description
        || this.state?.retryCount !== newState?.retryCount
        || this.state?.completed !== newState?.completed
        || this.state?.activeTodoIndex !== newState?.activeTodoIndex
        || this.state?.planContent?.length !== newState?.planContent?.length
        || this.state?.verifyPlanResult?.length !== newState?.verifyPlanResult?.length;
      this.state = newState;
      if (changed) this._onDidChange.fire(this.state);

      // Fire list change
      this._onDidChangeList.fire(this.getList());
    } catch {
      if (thisVersion !== this.loadVersion) return;
      this.log('loadAll failed');
      this.resetState();
    }
  }

  private parseSession(raw: unknown): WorkflowSession | null {
    if (raw === null || typeof raw !== 'object') {
      return null;
    }

    const r = raw as Record<string, unknown>;

    if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > MAX_SHORT_STRING) {
      return null;
    }

    if (typeof r.state !== 'string' || !VALID_STATES.has(r.state)) {
      return null;
    }

    if (typeof r.description !== 'string' || r.description.length > MAX_SHORT_STRING) {
      return null;
    }

    // Optional name
    let name: string | undefined;
    if (typeof r.name === 'string') {
      name = this.boundString(r.name, MAX_SHORT_STRING);
    }

    let planContent = '';
    if (typeof r.planContent === 'string') {
      planContent = this.boundString(r.planContent, MAX_STRING_LENGTH);
    }

    let verifyPlanResult = '';
    if (typeof r.verifyPlanResult === 'string') {
      verifyPlanResult = this.boundString(r.verifyPlanResult, MAX_STRING_LENGTH);
    }

    let retryCount = 0;
    if (typeof r.retryCount === 'number' && Number.isFinite(r.retryCount)) {
      retryCount = Math.max(0, Math.floor(r.retryCount));
    }

    let completed: boolean;
    if (typeof r.completed === 'boolean') {
      completed = r.completed;
    } else {
      completed = r.state === 'done';
    }

    let todos: TodoItem[];
    if (Array.isArray(r.todos)) {
      todos = (r.todos as unknown[])
        .slice(0, MAX_TODOS)
        .filter(
          (t): t is TodoItem =>
            typeof t === 'object' &&
            t !== null &&
            typeof (t as TodoItem).title === 'string' &&
            (t as TodoItem).title.length <= MAX_SHORT_STRING &&
            VALID_TODO_STATUSES.has((t as TodoItem).status),
        );
    } else {
      todos = [];
    }

    let activeTodoIndex: number;
    if (typeof r.activeTodoIndex === 'number' && Number.isFinite(r.activeTodoIndex)) {
      const rawVal = Math.floor(r.activeTodoIndex);
      activeTodoIndex = todos.length === 0 ? -1 : Math.max(-1, Math.min(rawVal, todos.length - 1));
    } else {
      activeTodoIndex = -1;
    }

    let gitBranch: string | undefined;
    if (typeof r.gitBranch === 'string') {
      gitBranch = this.boundString(r.gitBranch, MAX_SHORT_STRING);
    }

    let compoundStep: number | undefined;
    if (
      typeof r.compoundStep === 'number' &&
      Number.isFinite(r.compoundStep) &&
      r.compoundStep >= 0 &&
      Number.isInteger(r.compoundStep)
    ) {
      compoundStep = Math.min(r.compoundStep, MAX_COMPOUND_STEPS);
    }

    return {
      id: r.id,
      name,
      state: r.state as WorkflowState,
      description: r.description,
      planContent,
      verifyPlanResult,
      retryCount,
      completed,
      todos,
      activeTodoIndex,
      gitBranch,
      compoundStep,
    };
  }

  private boundString(value: string, max: number): string {
    return value.length > max ? value.slice(0, max) : value;
  }

  private log(message: string): void {
    this.outputChannel.appendLine(`[Pi Workflow] ${message}`);
  }

  dispose(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.dirWatcher?.dispose();
    this.activeWatcher?.dispose();
    this._onDidChange.dispose();
    this._onDidChangeList.dispose();
  }
}
