// storage/session.ts — WorkflowSession disk persistence
// Saves/loads session state to .pi/workflow-session.json.

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MEMORY_DIR } from '../constants';
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

const SESSION_FILE = 'workflow-session.json';

/**
 * Resolve the absolute path to the session file.
 */
function resolveSessionPath(cwd: string): string {
  return resolve(join(cwd, MEMORY_DIR, SESSION_FILE));
}

/**
 * Save session state to disk.
 * If session is null, deletes the file.
 */
export function saveSessionToDisk(
  cwd: string,
  session: WorkflowSession | null,
): void {
  const path = resolveSessionPath(cwd);
  if (!session) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch (e) {
      console.error('[workflow] session delete failed:', e);
    }
    return;
  }
  try {
    const dir = resolve(join(cwd, MEMORY_DIR));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(path, JSON.stringify(session, null, '\t'), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch (e) {
    console.error('[workflow] session save failed:', e);
  }
}

/**
 * Load session state from disk.
 * Returns null if file doesn't exist or is invalid.
 */
export function loadSessionFromDisk(cwd: string): WorkflowSession | null {
  try {
    const path = resolveSessionPath(cwd);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (
      typeof raw?.id !== 'string' ||
      typeof raw?.state !== 'string' ||
      typeof raw?.description !== 'string' ||
      !VALID_STATES.has(raw.state)
    ) {
      return null;
    }
    // Validate and filter todos
    const todos: TodoItem[] = Array.isArray(raw.todos)
      ? raw.todos.filter(
          (t: unknown): t is TodoItem =>
            typeof t === 'object' &&
            t !== null &&
            typeof (t as TodoItem).title === 'string' &&
            VALID_TODO_STATUSES.has((t as TodoItem).status),
        )
      : [];
    // Clamp activeTodoIndex to valid range
    const rawIndex =
      typeof raw.activeTodoIndex === 'number' &&
      Number.isFinite(raw.activeTodoIndex)
        ? Math.floor(raw.activeTodoIndex)
        : -1;
    const activeTodoIndex =
      todos.length === 0
        ? -1
        : Math.max(-1, Math.min(rawIndex, todos.length - 1));
    return {
      id: raw.id,
      state: raw.state as WorkflowState,
      description: raw.description,
      planContent: typeof raw.planContent === 'string' ? raw.planContent : '',
      verifyPlanResult:
        typeof raw.verifyPlanResult === 'string' ? raw.verifyPlanResult : '',
      retryCount: typeof raw.retryCount === 'number' ? raw.retryCount : 0,
      completed:
        typeof raw.completed === 'boolean'
          ? raw.completed
          : raw.state === 'done',
      todos,
      activeTodoIndex,
      startupPrepRequired:
        typeof raw.startupPrepRequired === 'boolean'
          ? raw.startupPrepRequired
          : false,
      startupPrepNote:
        typeof raw.startupPrepNote === 'string' ? raw.startupPrepNote : '',
      startupPrepLocked:
        typeof raw.startupPrepLocked === 'boolean'
          ? raw.startupPrepLocked
          : false,
      gitBranch: typeof raw.gitBranch === 'string' ? raw.gitBranch : undefined,
      gitWorktreePath:
        typeof raw.gitWorktreePath === 'string'
          ? raw.gitWorktreePath
          : undefined,
      compoundMemorySnapshot:
        typeof raw.compoundMemorySnapshot === 'object' &&
        raw.compoundMemorySnapshot !== null &&
        typeof raw.compoundMemorySnapshot.patterns === 'number' &&
        typeof raw.compoundMemorySnapshot.gotchas === 'number' &&
        typeof raw.compoundMemorySnapshot.decisions === 'number'
          ? raw.compoundMemorySnapshot
          : undefined,
      gitSkipAttempted:
        typeof raw.gitSkipAttempted === 'boolean'
          ? raw.gitSkipAttempted
          : undefined,
    };
  } catch (e) {
    console.error('[workflow] loadSession failed:', e);
    return null;
  }
}
