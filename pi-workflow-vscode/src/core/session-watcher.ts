// core/session-watcher.ts — Watches .pi/workflow-session.json for changes
// Single workspace root assumption (Phase 1). Multi-root not supported.
// Uses RelativePattern(workspaceRoot) to watch only the project root's session file.

import * as vscode from 'vscode';
import type { TodoItem, WorkflowSession, WorkflowState } from '../types/workflow';
import { VALID_STATES, VALID_TODO_STATUSES } from '../types/workflow';

const SESSION_REL_PATH = '.pi/workflow-session.json';
const DEBOUNCE_MS = 500;

// Safety limits
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_STRING_LENGTH = 500_000; // 500KB per string field
const MAX_SHORT_STRING = 1000; // id, description, gitBranch, todo title
const MAX_TODOS = 100;

export class SessionWatcher implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<WorkflowSession | null>();
  readonly onDidChange = this._onDidChange.event;

  private watcher: vscode.FileSystemWatcher | undefined;
  private state: WorkflowSession | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private loadVersion = 0; // Monotonic counter to prevent stale async overwrites
  private readonly sessionUri: vscode.Uri;

  constructor(
    private readonly workspaceRoot: string,
    private readonly outputChannel: vscode.OutputChannel,
  ) {
    this.sessionUri = vscode.Uri.joinPath(
      vscode.Uri.file(workspaceRoot),
      SESSION_REL_PATH,
    );
  }

  /** Start watching and perform initial load. */
  start(): void {
    void this.loadSession();

    // RelativePattern scoped to workspace root — intentionally not using
    // **/ glob since Phase 1 assumes single workspace root.
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceRoot, SESSION_REL_PATH),
    );

    this.watcher.onDidChange(() => this.scheduleLoad());
    this.watcher.onDidCreate(() => this.scheduleLoad());
    this.watcher.onDidDelete(() => this.resetState());
  }

  /** Force a manual reload. */
  reload(): void {
    void this.loadSession();
  }

  /** Get current cached state. */
  getState(): WorkflowSession | null {
    return this.state;
  }

  // ── Private ──────────────────────────────────────────────────

  /** Always resets state to null and fires event. Also invalidates in-flight loads. */
  private resetState(): void {
    ++this.loadVersion; // Invalidate any in-flight async loadSession
    this.state = null;
    this._onDidChange.fire(null);
  }

  private scheduleLoad(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.loadSession();
    }, DEBOUNCE_MS);
  }

  private async loadSession(): Promise<void> {
    const thisVersion = ++this.loadVersion;

    try {
      // Check file existence and size (async)
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(this.sessionUri);
      } catch {
        if (thisVersion !== this.loadVersion) return;
        this.resetState();
        return;
      }

      if (thisVersion !== this.loadVersion) return;

      if (stat.size > MAX_FILE_SIZE) {
        this.log(`Session file too large (${stat.size} bytes), ignoring`);
        this.resetState();
        return;
      }

      // Read file (async)
      const bytes = await vscode.workspace.fs.readFile(this.sessionUri);
      const text = new TextDecoder().decode(bytes);
      const raw = JSON.parse(text);
      const session = this.parseSession(raw);

      // Stale read guard: a newer load was started, discard this result
      if (thisVersion !== this.loadVersion) return;

      if (session === null) {
        this.resetState();
        return;
      }

      // Only fire if state actually changed (avoid unnecessary UI refreshes)
      if (this.state !== null) {
        const oldJson = JSON.stringify(this.state);
        const newJson = JSON.stringify(session);
        if (oldJson === newJson) return;
      }

      this.state = session;
      this._onDidChange.fire(session);
    } catch (e) {
      // Parse/read failure → fail-closed: reset state to null
      if (thisVersion !== this.loadVersion) return;
      this.log(`Failed to load session: ${e instanceof Error ? e.message : String(e)}`);
      this.resetState();
    }
  }

  private parseSession(raw: unknown): WorkflowSession | null {
    if (raw === null || typeof raw !== 'object') {
      this.log('Session parse: not an object');
      return null;
    }

    const r = raw as Record<string, unknown>;

    // ── Stage 1: Hard-required (reject → null) ──────────────

    if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > MAX_SHORT_STRING) {
      this.log('Session parse: invalid id');
      return null;
    }

    if (typeof r.state !== 'string' || !VALID_STATES.has(r.state)) {
      this.log(`Session parse: invalid state "${String(r.state)}"`);
      return null;
    }

    if (typeof r.description !== 'string' || r.description.length > MAX_SHORT_STRING) {
      this.log('Session parse: invalid description');
      return null;
    }

    // ── Stage 2: Defaultable fields (coerce with logging) ───

    let planContent = '';
    if (typeof r.planContent === 'string') {
      planContent = this.boundString(r.planContent, MAX_STRING_LENGTH);
    } else if (r.planContent !== undefined) {
      this.log(`Session parse: planContent is ${typeof r.planContent}, defaulting to ''`);
    }

    let verifyPlanResult = '';
    if (typeof r.verifyPlanResult === 'string') {
      verifyPlanResult = this.boundString(r.verifyPlanResult, MAX_STRING_LENGTH);
    } else if (r.verifyPlanResult !== undefined) {
      this.log(`Session parse: verifyPlanResult is ${typeof r.verifyPlanResult}, defaulting to ''`);
    }

    let retryCount = 0;
    if (typeof r.retryCount === 'number' && Number.isFinite(r.retryCount)) {
      retryCount = Math.max(0, Math.floor(r.retryCount));
    } else if (r.retryCount !== undefined) {
      this.log(`Session parse: retryCount is ${typeof r.retryCount}, defaulting to 0`);
    }

    let completed: boolean;
    if (typeof r.completed === 'boolean') {
      completed = r.completed;
    } else {
      if (r.completed !== undefined) {
        this.log(`Session parse: completed is ${typeof r.completed}, defaulting to state==='done'`);
      }
      completed = r.state === 'done';
    }

    let todos: TodoItem[];
    if (Array.isArray(r.todos)) {
      todos = (r.todos as unknown[])
        .slice(0, MAX_TODOS)
        .filter((t): t is TodoItem =>
          typeof t === 'object' &&
          t !== null &&
          typeof (t as TodoItem).title === 'string' &&
          (t as TodoItem).title.length <= MAX_SHORT_STRING &&
          VALID_TODO_STATUSES.has((t as TodoItem).status),
        );
      const dropped = Math.min(r.todos.length, MAX_TODOS) - todos.length;
      if (dropped > 0) {
        this.log(`Session parse: dropped ${dropped} invalid todo items`);
      }
    } else {
      if (r.todos !== undefined) {
        this.log(`Session parse: todos is ${typeof r.todos}, defaulting to []`);
      }
      todos = [];
    }

    let activeTodoIndex: number;
    if (typeof r.activeTodoIndex === 'number' && Number.isFinite(r.activeTodoIndex)) {
      const raw = Math.floor(r.activeTodoIndex);
      activeTodoIndex = todos.length === 0 ? -1 : Math.max(-1, Math.min(raw, todos.length - 1));
    } else {
      if (r.activeTodoIndex !== undefined) {
        this.log(`Session parse: activeTodoIndex is ${typeof r.activeTodoIndex}, defaulting to -1`);
      }
      activeTodoIndex = -1;
    }

    // ── Stage 3: Optional fields (undefined if absent) ──────

    let gitBranch: string | undefined;
    if (typeof r.gitBranch === 'string') {
      gitBranch = this.boundString(r.gitBranch, MAX_SHORT_STRING);
    } else if (r.gitBranch !== undefined) {
      this.log(`Session parse: gitBranch is ${typeof r.gitBranch}, ignoring`);
    }

    let compoundStep: number | undefined;
    if (
      typeof r.compoundStep === 'number' &&
      Number.isFinite(r.compoundStep) &&
      r.compoundStep >= 0 &&
      Number.isInteger(r.compoundStep)
    ) {
      compoundStep = r.compoundStep;
    } else if (r.compoundStep !== undefined) {
      this.log(`Session parse: compoundStep is invalid (${String(r.compoundStep)}), ignoring`);
    }

    return {
      id: r.id,
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
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }
}
