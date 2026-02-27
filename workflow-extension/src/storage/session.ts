// storage/session.ts — WorkflowSession disk persistence
// Multi-workflow: saves each workflow to .pi/workflows/{id}.json
// Active workflow tracked via .pi/workflows/active (plain text ID)

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ACTIVE_WORKFLOW_FILE,
  COMPOUND_STEPS,
  WORKFLOWS_DIR,
} from '../constants';
import type { TodoItem, WorkflowSession, WorkflowState } from '../types';
import { atomicWriteFileSync } from './atomic-write';

const VALID_STATES: Set<string> = new Set<WorkflowState>([
  'plan',
  'verifyPlan',
  'implement',
  'verifyImpl',
  'compound',
  'done',
]);

const VALID_TODO_STATUSES: Set<string> = new Set(['pending', 'active', 'done']);

// ── Path helpers ───────────────────────────────────────────────

/** Safe ID pattern — prevents path traversal. */
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function resolveWorkflowPath(cwd: string, id: string): string {
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid workflow ID: ${id}`);
  }
  return resolve(join(cwd, WORKFLOWS_DIR, `${id}.json`));
}

function resolveActivePath(cwd: string): string {
  return resolve(join(cwd, WORKFLOWS_DIR, ACTIVE_WORKFLOW_FILE));
}

function ensureWorkflowsDir(cwd: string): void {
  const dir = resolve(join(cwd, WORKFLOWS_DIR));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Active workflow pointer ────────────────────────────────────

/** Get the active workflow ID from .pi/workflows/active */
export function getActiveWorkflowId(cwd: string): string | null {
  try {
    const path = resolveActivePath(cwd);
    if (!existsSync(path)) return null;
    const id = readFileSync(path, 'utf-8').trim();
    if (!id || !SAFE_ID_RE.test(id)) return null;
    return id;
  } catch (e) {
    console.warn('[session] getActiveWorkflowId failed:', e);
    return null;
  }
}

/** Set (or clear) the active workflow ID */
export function setActiveWorkflowId(cwd: string, id: string | null): void {
  ensureWorkflowsDir(cwd);
  const path = resolveActivePath(cwd);
  if (id === null) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch (e) {
      console.warn('[session] clear active id failed:', e);
    }
    return;
  }
  atomicWriteFileSync(path, id, { encoding: 'utf-8', mode: 0o600 });
}

// ── Save / Load ────────────────────────────────────────────────

/**
 * Save session state to disk.
 * If session is null, only clears the active pointer (preserves workflow files).
 */
export function saveSessionToDisk(
  cwd: string,
  session: WorkflowSession | null,
): void {
  if (!session) {
    // Multi-workflow: only clear active pointer, preserve workflow files
    setActiveWorkflowId(cwd, null);
    return;
  }
  try {
    ensureWorkflowsDir(cwd);
    const path = resolveWorkflowPath(cwd, session.id);
    atomicWriteFileSync(path, JSON.stringify(session, null, '\t'), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    setActiveWorkflowId(cwd, session.id);
  } catch (e) {
    console.error('[workflow] session save failed:', e);
  }
}

/**
 * Load active session state from disk.
 * Reads active pointer → loads that workflow file.
 */
export function loadSessionFromDisk(cwd: string): WorkflowSession | null {
  const activeId = getActiveWorkflowId(cwd);
  if (!activeId) return null;
  return loadWorkflowById(cwd, activeId);
}

// ── Multi-workflow operations ──────────────────────────────────

/** List all workflow sessions on disk (lightweight summary). */
export function listWorkflows(cwd: string): Array<{
  id: string;
  name?: string;
  state: string;
  description: string;
}> {
  const dir = resolve(join(cwd, WORKFLOWS_DIR));
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const results: Array<{
    id: string;
    name?: string;
    state: string;
    description: string;
  }> = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      if (typeof raw?.id === 'string' && typeof raw?.state === 'string') {
        results.push({
          id: raw.id,
          name: typeof raw.name === 'string' ? raw.name : undefined,
          state: raw.state,
          description:
            typeof raw.description === 'string' ? raw.description : '',
        });
      }
    } catch (e) {
      console.warn(`[session] skip invalid workflow file ${file}:`, e);
    }
  }
  return results;
}

/** Load a specific workflow by ID. */
export function loadWorkflowById(
  cwd: string,
  id: string,
): WorkflowSession | null {
  try {
    const path = resolveWorkflowPath(cwd, id);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return parseSession(raw);
  } catch (e) {
    console.error('[workflow] loadWorkflowById failed:', e);
    return null;
  }
}

/** Delete a workflow file from disk. */
export function deleteWorkflow(cwd: string, id: string): void {
  try {
    const path = resolveWorkflowPath(cwd, id);
    if (existsSync(path)) unlinkSync(path);
  } catch (e) {
    console.warn(`[session] deleteWorkflow ${id} failed:`, e);
  }
}

// ── Migration ──────────────────────────────────────────────────

/**
 * Migrate old single-file .pi/workflow-session.json to new directory layout.
 * Idempotent: no-op if old file doesn't exist or target already exists.
 */
export function migrateSessionIfNeeded(cwd: string): void {
  const oldPath = resolve(join(cwd, '.pi', 'workflow-session.json'));
  if (!existsSync(oldPath)) return;
  try {
    const raw = JSON.parse(readFileSync(oldPath, 'utf-8'));
    if (typeof raw?.id === 'string') {
      ensureWorkflowsDir(cwd);
      const newPath = resolveWorkflowPath(cwd, raw.id);
      if (!existsSync(newPath)) {
        atomicWriteFileSync(newPath, JSON.stringify(raw, null, '\t'), {
          encoding: 'utf-8',
          mode: 0o600,
        });
        setActiveWorkflowId(cwd, raw.id);
      }
      unlinkSync(oldPath);
    }
  } catch (e) {
    console.warn('[session] migration failed:', e);
  }
}

// ── Backward-compatible no-op ──────────────────────────────────

/**
 * No-op in multi-workflow model: each workflow has its own file.
 * Kept for call-site compatibility.
 */
export function backupSession(_cwd: string): void {
  // No-op: each workflow is already in its own file
}

// ── Session parsing (shared) ───────────────────────────────────

/** @internal — exported for testing */
export function parseSession(raw: unknown): WorkflowSession | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  if (
    typeof r.id !== 'string' ||
    r.id.trim().length === 0 ||
    typeof r.state !== 'string' ||
    typeof r.description !== 'string' ||
    !VALID_STATES.has(r.state)
  ) {
    return null;
  }

  // Validate and filter todos
  const todos: TodoItem[] = Array.isArray(r.todos)
    ? (r.todos as unknown[]).filter(
        (t: unknown): t is TodoItem =>
          typeof t === 'object' &&
          t !== null &&
          typeof (t as TodoItem).title === 'string' &&
          VALID_TODO_STATUSES.has((t as TodoItem).status),
      )
    : [];

  // Clamp activeTodoIndex to valid range
  const rawIndex =
    typeof r.activeTodoIndex === 'number' && Number.isFinite(r.activeTodoIndex)
      ? Math.floor(r.activeTodoIndex)
      : -1;
  const activeTodoIndex =
    todos.length === 0
      ? -1
      : Math.max(-1, Math.min(rawIndex, todos.length - 1));

  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : undefined,
    state: r.state as WorkflowState,
    description: r.description,
    planContent: typeof r.planContent === 'string' ? r.planContent : '',
    verifyPlanResult:
      typeof r.verifyPlanResult === 'string' ? r.verifyPlanResult : '',
    retryCount: typeof r.retryCount === 'number' ? r.retryCount : 0,
    completed:
      typeof r.completed === 'boolean' ? r.completed : r.state === 'done',
    todos,
    activeTodoIndex,
    startupPrepRequired:
      typeof r.startupPrepRequired === 'boolean'
        ? r.startupPrepRequired
        : false,
    startupPrepNote:
      typeof r.startupPrepNote === 'string' ? r.startupPrepNote : '',
    startupPrepLocked:
      typeof r.startupPrepLocked === 'boolean' ? r.startupPrepLocked : false,
    gitBranch: typeof r.gitBranch === 'string' ? r.gitBranch : undefined,
    gitWorktreePath:
      typeof r.gitWorktreePath === 'string' ? r.gitWorktreePath : undefined,
    compoundMemorySnapshot:
      typeof r.compoundMemorySnapshot === 'object' &&
      r.compoundMemorySnapshot !== null &&
      typeof (r.compoundMemorySnapshot as Record<string, unknown>).patterns ===
        'number' &&
      typeof (r.compoundMemorySnapshot as Record<string, unknown>).gotchas ===
        'number' &&
      typeof (r.compoundMemorySnapshot as Record<string, unknown>).decisions ===
        'number'
        ? (r.compoundMemorySnapshot as {
            patterns: number;
            gotchas: number;
            decisions: number;
          })
        : undefined,
    compoundStep:
      typeof r.compoundStep === 'number' &&
      Number.isFinite(r.compoundStep) &&
      r.compoundStep >= 0 &&
      Number.isInteger(r.compoundStep)
        ? Math.min(r.compoundStep, COMPOUND_STEPS.length)
        : undefined,
  };
}
